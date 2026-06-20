#!/bin/sh
# /usr/libexec/kidtime.sh
# Backend for luci-app-kidtime. POSIX sh (busybox ash) compatible.
#
# Architecture
# ------------
# nftables table inet kidtime:
#   * set "blocked" (ether_addr)         -> MACs currently denied internet
#   * chain forward (prio -150):
#         ether saddr @blocked drop      -> the enforcement
#         <per-MAC named counters>       -> ACTIVITY accounting (count, never drop)
#   The per-MAC counters sit AFTER the drop rule but with `accept`-less `counter`
#   verdict-maps so they only tally packets that were NOT dropped, i.e. real
#   forwarded activity. A device that is blocked forwards ~0 pkts -> 0 activity.
#
# Each minute, `tick`:
#   1) rolls the day over at local midnight (wipes usage)
#   2) reads each tracked id's counter delta since last tick
#   3) if delta > active_threshold -> that minute counts: used += 1
#   4) recomputes who should be blocked (window gate AND budget gate)
#   5) atomically rewrites the blocked set
#
# Subcommands: setup | tick | apply | reset | extend <mac> <min> | status | teardown

# NOTE: we deliberately do NOT use `set -u`. OpenWrt's /lib/functions.sh and the
# UCI config helpers (config_load/foreach/get/list_foreach) reference internal
# variables such as CONFIG_LIST_STATE without guarding them, both while sourcing
# and at call time. Since those run in this same shell, `set -u` would abort the
# script. Our own code uses explicit `${var:-default}` fallbacks instead.
TABLE=kidtime
STATE_DIR=/etc/kidtime
USAGE="$STATE_DIR/usage.json"
PREV="/tmp/kidtime_prev"          # "<id> <last_pkt_count>" lines
_NFT_BIN=/usr/sbin/nft
[ -x "$_NFT_BIN" ] || _NFT_BIN=nft
# Guard every nft call with a timeout if available, so a stuck nft (e.g. a
# kernel/netlink lock) can never wedge a cron tick or an rpcd worker.
if command -v timeout >/dev/null 2>&1; then
	NFT="timeout 10 $_NFT_BIN"
else
	NFT="$_NFT_BIN"
fi

mkdir -p "$STATE_DIR"

. /usr/share/libubox/jshn.sh
. /lib/functions.sh

# ---------------- time helpers -------------------------------------------
_today()   { date +%u; }                       # 1=Mon..7=Sun
_daykey()  { date +%Y-%m-%d; }
_hhmm()    { date +%H:%M; }
_dow() { case "$1" in 1) echo mon;;2) echo tue;;3) echo wed;;4) echo thu;;
                      5) echo fri;;6) echo sat;;7) echo sun;; esac; }
_min_of() {
	local h=${1%%:*} m=${1##*:}
	h=${h#0}; [ -z "$h" ] && h=0
	m=${m#0}; [ -z "$m" ] && m=0
	echo $(( h * 60 + m ))
}

# windows on stdin (one "days hh:mm-hh:mm" per line). 0 = allowed now.
_in_window() {
	local today now any=0 line days range s e smin emin
	today=$(_dow "$(_today)"); now=$(_min_of "$(_hhmm)")
	while IFS= read -r line; do
		[ -z "$line" ] && continue
		any=1; days=${line%% *}; range=${line##* }
		case ",$days," in *",$today,"*) ;; *) continue;; esac
		s=${range%%-*}; e=${range##*-}; smin=$(_min_of "$s"); emin=$(_min_of "$e")
		if [ "$smin" -le "$emin" ]; then
			[ "$now" -ge "$smin" ] && [ "$now" -le "$emin" ] && return 0
		else
			{ [ "$now" -ge "$smin" ] || [ "$now" -le "$emin" ]; } && return 0
		fi
	done
	[ "$any" -eq 0 ] && return 0      # no windows defined => always in-window
	return 1
}

# ---------------- config loading -----------------------------------------
# Builds, in shell vars, the list of tracked "ids" (section names). For each id:
#   KT_NAME_<id> KT_ENABLED_<id> KT_MACS_<id> (space list)
#   KT_WIN_<id> (newline list) KT_BUDGET_<id> (today's minutes)
GLOBAL_ENABLED=1
ACTIVE_THRESHOLD=5
IDS=""

_safe() { printf '%s' "$1" | tr -c 'A-Za-z0-9' '_'; }

_load_global() {
	config_get GLOBAL_ENABLED global enabled 1
	config_get ACTIVE_THRESHOLD global active_threshold 5
	config_get EXEMPT_ENABLED global exempt_enabled 1
	# global exempt domain list
	GLOBAL_EXEMPT=""
	config_list_foreach global exempt_domain _appendgdom
	GLOBAL_EXEMPT="$_GD"; _GD=""
	# global exempt IP/CIDR list (added directly to the nft sets, no DNS needed)
	GLOBAL_EXEMPT_IP=""
	config_list_foreach global exempt_ip _appendgip
	GLOBAL_EXEMPT_IP="$_GIP"; _GIP=""
}
_GD=""; _appendgdom() { _GD="$_GD $1"; }
_GIP=""; _appendgip() { _GIP="$_GIP $1"; }

_budget_for_today() { # $1=section -> echoes minutes (option budget_<dow>)
	local d v; d=$(_dow "$(_today)")
	config_get v "$1" "budget_$d" 0
	echo "${v:-0}"
}

_collect() { # called per rule/group section
	local sid="$1" type="$2" name en macs win bud id edoms
	config_get name "$sid" name "$sid"
	config_get en   "$sid" enabled 1
	# identity key is derived from the human-set name option so it stays stable
	# across config rewrites (anonymous UCI sections get random ids otherwise).
	id=$(_safe "$name")
	macs=""
	if [ "$type" = group ]; then
		config_list_foreach "$sid" mac _appendmac
		macs="$_ML"; _ML=""
	else
		config_get m "$sid" mac ""
		macs="$m"
	fi
	win=""
	config_list_foreach "$sid" window _appendwin
	win="$_WL"; _WL=""
	bud=$(_budget_for_today "$sid")
	# per-rule extra exempt domains
	edoms=""
	config_list_foreach "$sid" exempt_domain _appenredom
	edoms="$_RD"; _RD=""

	eval "KT_NAME_$id=\$name"
	eval "KT_EN_$id=\$en"
	eval "KT_MACS_$id=\$macs"
	eval "KT_WIN_$id=\$win"
	eval "KT_BUD_$id=\$bud"
	eval "KT_EDOM_$id=\$edoms"
	IDS="$IDS $id"
}
_ML=""; _appendmac() { _ML="$_ML $1"; }
_RD=""; _appenredom() { _RD="$_RD $1"; }
_WL=""; _appendwin() { _WL="$_WL$1
"; }

_rule_cb()  { _collect "$1" rule;  }
_group_cb() { _collect "$1" group; }

_load_all() {
	config_load kidtime
	_load_global
	IDS=""
	config_foreach _rule_cb rule
	config_foreach _group_cb group
}

# ---------------- usage state (flat key=val file, robust & fast) ----------
# usage.json kept human/jshn readable for the UI; internal math uses a flat
# shadow file usage.kv:  day, used.<id>, bonus.<id>
KV="$STATE_DIR/usage.kv"
_kv_get() { local k="$1" d="${2:-0}" v; v=$(sed -n "s/^$k=//p" "$KV" 2>/dev/null|head -n1); echo "${v:-$d}"; }
_kv_set() {
	local k="$1" v="$2"
	[ -f "$KV" ] || : > "$KV"
	if grep -q "^$k=" "$KV" 2>/dev/null; then
		sed -i "s/^$k=.*/$k=$v/" "$KV"
	else
		echo "$k=$v" >> "$KV"
	fi
}

_maybe_reset() {
	local stored today saved; today=$(_daykey); stored=$(_kv_get day "")
	if [ "$stored" != "$today" ]; then
		# preserve manual blocks (mblock.*) across the midnight reset; only the
		# daily usage/bonus counters should be wiped.
		saved=$(grep '^mblock\.' "$KV" 2>/dev/null)
		: > "$KV"; _kv_set day "$today"; : > "$PREV"
		[ -n "$saved" ] && printf '%s\n' "$saved" >> "$KV"
	fi
}

# write the jshn usage.json the UI reads
_export_json() {
	local id used bud bonus rem
	json_init
	json_add_string day "$(_kv_get day "$(_daykey)")"
	json_add_object devices
	for id in $IDS; do
		used=$(_kv_get used.$id 0)
		bonus=$(_kv_get bonus.$id 0)
		mblock=$(_kv_get mblock.$id 0)
		eval bud=\${KT_BUD_$id:-0}
		rem=$(( bud + bonus - used )); [ "$rem" -lt 0 ] && rem=0
		json_add_object "$id"
		eval json_add_string name \"\$KT_NAME_$id\"
		json_add_int used "$used"
		json_add_int budget "$bud"
		json_add_int bonus "$bonus"
		json_add_int remaining "$rem"
		json_add_int manual_block "$mblock"
		json_close_object
	done
	json_close_object
	json_dump > "$USAGE.tmp" && mv "$USAGE.tmp" "$USAGE"
}

# ---------------- nftables scaffolding ------------------------------------
setup() {
	$NFT list table inet "$TABLE" >/dev/null 2>&1 || $NFT -f - <<-EOF
		table inet $TABLE {
			set blocked { type ether_addr; flags interval; }
			set exempt4 { type ipv4_addr; flags interval; }
			set exempt6 { type ipv6_addr; flags interval; }
			chain forward {
				type filter hook forward priority -150; policy accept;
				ether saddr @blocked counter drop
			}
		}
	EOF
	# the sets may be missing on tables created by an older version; add them
	$NFT list set inet "$TABLE" exempt4 >/dev/null 2>&1 || \
		$NFT add set inet "$TABLE" exempt4 '{ type ipv4_addr; flags interval; }' 2>/dev/null
	$NFT list set inet "$TABLE" exempt6 >/dev/null 2>&1 || \
		$NFT add set inet "$TABLE" exempt6 '{ type ipv6_addr; flags interval; }' 2>/dev/null
}
teardown() { $NFT delete table inet "$TABLE" 2>/dev/null; }

# Per tracked MAC we keep TWO named counters in the forward chain:
#   c_<mac>  -> BUDGETED traffic: from MAC to a destination NOT in the exempt
#              sets. Only this counter drives the daily budget.
#   e_<mac>  -> EXEMPT traffic: from MAC to a destination IN an exempt set.
#              Purely informational (logging); never charged to the budget.
# Splitting by destination is what lets background services (push/sync) run
# without consuming the child's time, once their domains are exempted.
_mac_key()  { printf 'c_%s' "$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '_')"; }
_emac_key() { printf 'e_%s' "$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '_')"; }

_ensure_counters() {
	local id macs m ckey ekey
	for id in $IDS; do
		eval macs=\${KT_MACS_$id:-}
		for m in $macs; do
			[ -z "$m" ] && continue
			ckey=$(_mac_key "$m")
			ekey=$(_emac_key "$m")
			# create counters once
			$NFT list counter inet "$TABLE" "$ckey" >/dev/null 2>&1 || \
				$NFT add counter inet "$TABLE" "$ckey" 2>/dev/null
			$NFT list counter inet "$TABLE" "$ekey" >/dev/null 2>&1 || \
				$NFT add counter inet "$TABLE" "$ekey" 2>/dev/null
			# (re)create the four counting rules only if this MAC has none yet.
			# We detect "already wired" by checking for the c_ rule reference.
			if ! $NFT -a list chain inet "$TABLE" forward 2>/dev/null | grep -q "counter name \"$ckey\""; then
				# EXEMPT first (so those packets are tallied as exempt), then budgeted.
				$NFT add rule inet "$TABLE" forward ether saddr "$m" ip  daddr @exempt4 counter name "$ekey" 2>/dev/null
				$NFT add rule inet "$TABLE" forward ether saddr "$m" ip6 daddr @exempt6 counter name "$ekey" 2>/dev/null
				$NFT add rule inet "$TABLE" forward ether saddr "$m" ip  daddr != @exempt4 counter name "$ckey" 2>/dev/null
				$NFT add rule inet "$TABLE" forward ether saddr "$m" ip6 daddr != @exempt6 counter name "$ckey" 2>/dev/null
			fi
		done
	done
}

_counter_pkts() { # $1=counter-name -> packets
	local v
	v=$($NFT -j list counter inet "$TABLE" "$1" 2>/dev/null \
	    | sed -n 's/.*"packets":[ ]*\([0-9]*\).*/\1/p' | head -n1)
	echo "${v:-0}"
}

# ---------------- manual IP/CIDR exemptions -------------------------------
# IPs have no domain for dnsmasq to resolve, so we add them straight into the
# same exempt4/exempt6 sets. We track what we previously added in a state file
# so that removing an IP from the config also removes it from the live set,
# WITHOUT touching the entries dnsmasq maintains for exempt domains.
IP_EXEMPT_STATE="$STATE_DIR/exempt-ips"

apply_ip_exemptions() {
	setup
	local want prev ip fam
	# desired set = config list (empty if feature disabled)
	if [ "${EXEMPT_ENABLED:-1}" = 0 ]; then
		want=""
	else
		want=$(printf '%s\n' $GLOBAL_EXEMPT_IP | sed '/^$/d' | sort -u)
	fi
	prev=$(cat "$IP_EXEMPT_STATE" 2>/dev/null)

	# remove entries that were present before but are no longer wanted
	for ip in $prev; do
		printf '%s\n' $want | grep -qxF "$ip" && continue
		case "$ip" in
			*:*) $NFT delete element inet "$TABLE" exempt6 "{ $ip }" 2>/dev/null ;;
			*)   $NFT delete element inet "$TABLE" exempt4 "{ $ip }" 2>/dev/null ;;
		esac
	done
	# add all wanted entries (idempotent)
	for ip in $want; do
		case "$ip" in
			*:*) $NFT add element inet "$TABLE" exempt6 "{ $ip }" 2>/dev/null ;;
			*)   $NFT add element inet "$TABLE" exempt4 "{ $ip }" 2>/dev/null ;;
		esac
	done
	# persist the new "previously added" set
	printf '%s\n' $want | sed '/^$/d' > "$IP_EXEMPT_STATE"
}

# ---------------- dnsmasq domain exemptions -------------------------------
# dnsmasq (when built with nftset support, i.e. dnsmasq-full) can add the
# resolved IPs of given domains directly into our nft sets. We generate a
# config snippet in /tmp/dnsmasq.d and reload dnsmasq.
DNSMASQ_CONF=/tmp/dnsmasq.d/kidtime-exempt.conf

# returns 0 if dnsmasq supports nftset (dnsmasq-full)
_dnsmasq_has_nftset() {
	# dnsmasq --help dhcp prints compile options; HAVE_NFTSET shows as "nftset"
	local v
	v=$(dnsmasq --version 2>/dev/null)
	case "$v" in
		*no-nftset*) return 1 ;;
		*nftset*)    return 0 ;;
	esac
	# fall back: assume not supported if we can't tell
	return 1
}

# collect ALL exempt domains (global + every rule), unique
_all_exempt_domains() {
	local id out d
	out="$GLOBAL_EXEMPT"
	for id in $IDS; do
		eval out="\$out \${KT_EDOM_$id:-}"
	done
	# dedupe + drop empties
	printf '%s\n' $out | sed '/^$/d' | sort -u
}

# (re)generate the dnsmasq snippet and reload. Safe no-op if feature disabled
# or dnsmasq lacks nftset support.
apply_exemptions() {
	setup
	[ "${EXEMPT_ENABLED:-1}" = 0 ] && { rm -f "$DNSMASQ_CONF"; _dnsmasq_reload; return 0; }
	# turn on DNS query logging so the Traffic view can show real service names
	ensure_dns_logging
	if ! _dnsmasq_has_nftset; then
		# leave a marker the UI can read; do not break dnsmasq
		echo "nftset-unsupported" > "$STATE_DIR/dnsmasq_status"
		rm -f "$DNSMASQ_CONF"
		return 0
	fi
	echo "ok" > "$STATE_DIR/dnsmasq_status"
	mkdir -p /tmp/dnsmasq.d
	local doms d
	doms=$(_all_exempt_domains)
	if [ -z "$doms" ]; then
		rm -f "$DNSMASQ_CONF"
		_dnsmasq_reload
		return 0
	fi
	{
		echo "# generated by kidtime - do not edit"
		for d in $doms; do
			# add both v4 and v6 resolved addresses into our sets
			echo "nftset=/$d/4#inet#$TABLE#exempt4"
			echo "nftset=/$d/6#inet#$TABLE#exempt6"
		done
	} > "$DNSMASQ_CONF"
	_dnsmasq_reload
}

_dnsmasq_reload() {
	# prefer a graceful reload; fall back to init restart
	if [ -x /etc/init.d/dnsmasq ]; then
		/etc/init.d/dnsmasq reload >/dev/null 2>&1 || /etc/init.d/dnsmasq restart >/dev/null 2>&1
	fi
}

# ---------------- DNS-query logging for service names ---------------------
# Reverse DNS (PTR) is unreliable for CDN/Apple/Google IPs, so we instead learn
# IP->domain from the actual forward lookups our clients make. dnsmasq logs
# "reply <domain> is <ip>" lines; we parse those into an ip->domain map.
DNS_LOG=/tmp/kidtime-dns.log

# Ensure dnsmasq query logging into our own file is enabled (idempotent).
# Only touches logqueries/logfacility; leaves everything else alone.
ensure_dns_logging() {
	local cur_fac cur_q changed=0
	cur_q=$(uci -q get dhcp.@dnsmasq[0].logqueries)
	cur_fac=$(uci -q get dhcp.@dnsmasq[0].logfacility)
	if [ "$cur_q" != "1" ]; then
		uci -q set dhcp.@dnsmasq[0].logqueries='1'; changed=1
	fi
	if [ "$cur_fac" != "$DNS_LOG" ]; then
		uci -q set dhcp.@dnsmasq[0].logfacility="$DNS_LOG"; changed=1
	fi
	if [ "$changed" = 1 ]; then
		uci -q commit dhcp
		_dnsmasq_reload
	fi
}

# Build an ip->domain map file from the DNS log. Keeps the LAST domain seen for
# each IP (most recent wins). Output: "<ip> <domain>" lines in $1.
_build_ip_domain_map() {
	local out="$1"
	: > "$out"
	[ -f "$DNS_LOG" ] || return 0
	# lines look like: "... reply www.tiktok.com is 23.205.110.10"
	# also "is <CNAME>" which we skip (not an IP). Keep v4 and v6 addrs.
	tail -n 4000 "$DNS_LOG" 2>/dev/null | awk '
		/ reply / && / is / {
			# find "reply <dom> is <val>"
			dom=""; val="";
			for (i=1;i<=NF;i++){
				if ($i=="reply" && (i+3)<=NF && $(i+2)=="is"){ dom=$(i+1); val=$(i+3); break }
			}
			if (dom=="" || val=="") next;
			# only keep if val looks like an IP (contains . or :) and not "<CNAME>"
			if (val ~ /[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/ || val ~ /:/) {
				map[val]=dom;   # last wins
			}
		}
		END { for (ip in map) print ip" "map[ip] }
	' > "$out"
}


# echoes "blocked" or "allowed" for an id given current state
_decide() {
	local id="$1" en win used bonus bud rem mblock
	# manual block has the highest priority: when set, the device is blocked
	# regardless of window, budget, or even the rule being disabled.
	mblock=$(_kv_get mblock.$id 0)
	[ "$mblock" = 1 ] && { echo blocked; return; }
	eval en=\${KT_EN_$id:-1}
	[ "$en" = 0 ] && { echo allowed; return; }       # rule disabled
	# window gate
	eval win=\"\${KT_WIN_$id:-}\"
	if ! printf '%s' "$win" | _in_window; then echo blocked; return; fi
	# budget gate
	eval bud=\${KT_BUD_$id:-0}
	[ "${bud:-0}" = 0 ] && { echo allowed; return; }  # 0 budget = window-only
	used=$(_kv_get used.$id 0); bonus=$(_kv_get bonus.$id 0)
	rem=$(( bud + bonus - used ))
	[ "$rem" -le 0 ] && { echo blocked; return; }
	echo allowed
}

_rewrite_blocked() {
	local id macs m out=""
	if [ "${GLOBAL_ENABLED:-1}" = 0 ]; then
		$NFT flush set inet "$TABLE" blocked 2>/dev/null
		return
	fi
	for id in $IDS; do
		[ "$(_decide "$id")" = blocked ] || continue
		eval macs=\${KT_MACS_$id:-}
		for m in $macs; do [ -n "$m" ] && out="$out $m,"; done
	done
	out=${out%,}
	$NFT flush set inet "$TABLE" blocked 2>/dev/null
	[ -n "$out" ] && $NFT add element inet "$TABLE" blocked "{$out }" 2>/dev/null
	return 0
}

# ---------------- subcommands ---------------------------------------------
cmd_apply() {
	setup; _load_all; _ensure_counters; _maybe_reset
	apply_exemptions
	apply_ip_exemptions
	_rewrite_blocked; _export_json
}

cmd_tick() {
	setup; _load_all; _ensure_counters; _maybe_reset
	# accounting: per id, sum its MAC deltas; if active, used += 1
	local id macs m now prev key delta active total
	for id in $IDS; do
		eval macs=\${KT_MACS_$id:-}
		active=0
		for m in $macs; do
			[ -z "$m" ] && continue
			key=$(_mac_key "$m")
			now=$(_counter_pkts "$key")
			prev=$(sed -n "s/^$key //p" "$PREV" 2>/dev/null | head -n1)
			prev=${prev:-0}
			delta=$(( now - prev ))
			[ "$delta" -lt 0 ] && delta=0     # counter reset/reboot
			[ "$delta" -gt "${ACTIVE_THRESHOLD:-5}" ] && active=1
			# persist current reading
			if grep -q "^$key " "$PREV" 2>/dev/null; then
				sed -i "s/^$key .*/$key $now/" "$PREV"
			else
				echo "$key $now" >> "$PREV"
			fi
		done
		# only consume budget while the device is actually allowed AND has a budget
		eval bud=\${KT_BUD_$id:-0}
		if [ "$active" = 1 ] && [ "${bud:-0}" != 0 ] && [ "$(_decide "$id")" = allowed ]; then
			used=$(_kv_get used.$id 0); _kv_set used.$id $(( used + 1 ))
		fi
	done
	_rewrite_blocked; _export_json
}

cmd_reset() {
	_load_all
	local saved; saved=$(grep '^mblock\.' "$KV" 2>/dev/null)
	: > "$KV"; _kv_set day "$(_daykey)"; : > "$PREV"
	[ -n "$saved" ] && printf '%s\n' "$saved" >> "$KV"
	cmd_apply
}

cmd_extend() { # $1 = mac, $2 = minutes
	local mac="$1" add="$2" id macs m bonus
	_load_all
	for id in $IDS; do
		eval macs=\${KT_MACS_$id:-}
		for m in $macs; do
			if [ "$m" = "$mac" ]; then
				bonus=$(_kv_get bonus.$id 0)
				_kv_set bonus.$id $(( bonus + add ))
				cmd_apply
				echo "extended $id by ${add}m"
				return 0
			fi
		done
	done
	echo "no rule owns mac $mac" >&2; return 1
}

cmd_block() { # $1 = mac, $2 = 1 (block) | 0 (unblock)
	local mac="$1" on="$2" id macs m
	[ "$on" = 1 ] || on=0
	_load_all
	for id in $IDS; do
		eval macs=\${KT_MACS_$id:-}
		for m in $macs; do
			if [ "$m" = "$mac" ]; then
				_kv_set mblock.$id "$on"
				cmd_apply
				echo "manual block of $id set to $on"
				return 0
			fi
		done
	done
	echo "no rule owns mac $mac" >&2; return 1
}

cmd_status() { _load_all; _ensure_counters 2>/dev/null; _export_json; cat "$USAGE"; }

# ---------------- traffic logging -----------------------------------------
# Live top-talkers + per-day accumulation, sourced from conntrack. conntrack
# gives per-flow src/dst/bytes; we aggregate by (mac -> dest ip). Names are
# resolved lazily with a small reverse-DNS cache. Degrades cleanly if the
# conntrack CLI is unavailable.
RESOLV_CACHE="$STATE_DIR/dns-cache"
IPDOM_MAP="$STATE_DIR/ipdom-map"            # ip -> domain learned from DNS log
TRAFFIC_PREV="/tmp/kidtime_traffic_prev"   # "<mac> <dstip> <bytes>" last sample

_have_conntrack() { command -v conntrack >/dev/null 2>&1; }

# map an IP to a name: exempt-domain reverse lookup cache first, then PTR.
_resolve_ip() {
	local ip="$1" name
	# 1) prefer the ip->domain map learned from clients' own DNS lookups
	if [ -f "$IPDOM_MAP" ]; then
		name=$(awk -v ip="$ip" '$1==ip {print $2; exit}' "$IPDOM_MAP" 2>/dev/null)
		[ -n "$name" ] && { echo "$name"; return; }
	fi
	# 2) cache of previous PTR results
	name=$(sed -n "s/^$ip //p" "$RESOLV_CACHE" 2>/dev/null | head -n1)
	if [ -z "$name" ]; then
		# 3) best-effort PTR (busybox prints no trailing dot; tolerate both)
		name=$(nslookup "$ip" 2>/dev/null \
			| sed -n 's/.*name = \([^ ]*[^ .]\)\.*[[:space:]]*$/\1/p' | head -n1)
		if [ -n "$name" ]; then
			echo "$ip $name" >> "$RESOLV_CACHE"
		else
			name="$ip"
		fi
	fi
	echo "$name"
}

# build a MAC -> IP lookup from current neigh table (so conntrack src IPs can be
# attributed to the tracked MAC).
_mac_for_ip() { ip neigh 2>/dev/null | awk -v ip="$1" '$1==ip {print $5; exit}'; }

# Produce JSON of live top destinations for each tracked id and update the
# per-day accumulation file. Output goes to stdout (consumed by rpcd).
cmd_traffic() {
	_load_all
	local day dayfile snap idmapfile aggfile id macs m
	day=$(_daykey); dayfile="$STATE_DIR/traffic-$day.json"

	if ! _have_conntrack; then
		printf '{"ok":true,"conntrack":false,"devices":{}}\n'
		return 0
	fi

	# refresh the ip->domain map from the DNS log (names come from clients'
	# own forward lookups; far more reliable than PTR for CDN/Apple/Google)
	_build_ip_domain_map "$IPDOM_MAP"

	snap=$(conntrack -L 2>/dev/null)

	# Build "ip<TAB>id" map from the neigh table for every tracked MAC.
	idmapfile=$(mktemp 2>/dev/null || echo /tmp/kt_idmap.$$)
	: > "$idmapfile"
	for id in $IDS; do
		eval macs=\${KT_MACS_$id:-}
		for m in $macs; do
			[ -z "$m" ] && continue
			ip neigh 2>/dev/null | awk -v mac="$m" -v id="$id" \
				'tolower($5)==tolower(mac){print $1"\t"id}' >> "$idmapfile"
		done
	done

	# One awk pass: read id-map, then conntrack; attribute each flow's bytes to
	# the owning id by source IP; accumulate per (id,dst). Emit "id dst bytes".
	aggfile=$(mktemp 2>/dev/null || echo /tmp/kt_agg.$$)
	printf '%s\n' "$snap" | awk -v mapfile="$idmapfile" '
		BEGIN {
			while ((getline line < mapfile) > 0) {
				n=split(line, a, "\t"); if (n>=2) owner[a[1]]=a[2];
			}
		}
		{
			src=""; dst=""; b=0;
			for (i=1;i<=NF;i++){
				if ($i ~ /^src=/ && src=="") { t=$i; sub(/^src=/,"",t); src=t }
				else if ($i ~ /^dst=/ && dst=="") { t=$i; sub(/^dst=/,"",t); dst=t }
				if ($i ~ /^bytes=/) { t=$i; sub(/^bytes=/,"",t); b+=t }
			}
			if (src!="" && dst!="" && (src in owner)) {
				key=owner[src] SUBSEP dst; agg[key]+=b;
			}
		}
		END { for (k in agg){ split(k, p, SUBSEP); print p[1]" "p[2]" "agg[k] } }
	' > "$aggfile"

	# Merge into daily totals (store max seen per id+dst -> approximates volume).
	awk '
		FNR==NR { key=$1" "$2; daily[key]=$3; next }
		{ key=$1" "$2; v=$3+0; if (v>daily[key]) daily[key]=v }
		END { for (k in daily) print k" "daily[k] }
	' "${dayfile}.kv" "$aggfile" 2>/dev/null > "${dayfile}.kv.tmp" || cp "$aggfile" "${dayfile}.kv.tmp"
	mv "${dayfile}.kv.tmp" "${dayfile}.kv"

	# Build JSON: per id, top 15 destinations by bytes (from daily totals).
	json_init
	json_add_boolean ok 1
	json_add_boolean conntrack 1
	json_add_object devices
	for id in $IDS; do
		json_add_object "$id"
		eval json_add_string name \"\${KT_NAME_$id:-$id}\"
		json_add_array top
		awk -v id="$id" '$1==id {print $2" "$3}' "${dayfile}.kv" 2>/dev/null \
			| sort -k2 -n -r | head -n 15 > /tmp/kt_top.$$
		while read -r dst bytes; do
			[ -z "$dst" ] && continue
			nm=$(_resolve_ip "$dst")
			json_add_object ""
			json_add_string ip "$dst"
			json_add_string name "$nm"
			json_add_double bytes "$bytes"
			json_close_object
		done < /tmp/kt_top.$$
		rm -f /tmp/kt_top.$$
		json_close_array
		json_close_object
	done
	json_close_object
	json_dump

	rm -f "$idmapfile" "$aggfile" 2>/dev/null
}

case "${1:-}" in
	setup)    setup ;;
	apply)    cmd_apply ;;
	tick)     cmd_tick ;;
	reset)    cmd_reset ;;
	extend)   cmd_extend "$2" "$3" ;;
	block)    cmd_block "$2" "$3" ;;
	status)   cmd_status ;;
	traffic)  cmd_traffic ;;
	exemptions) _load_all; apply_exemptions ;;
	teardown) teardown ;;
	*) echo "usage: $0 {setup|apply|tick|reset|extend <mac> <min>|block <mac> <0|1>|status|traffic|exemptions|teardown}" >&2; exit 1 ;;
esac
