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
}

_budget_for_today() { # $1=section -> echoes minutes (option budget_<dow>)
	local d v; d=$(_dow "$(_today)")
	config_get v "$1" "budget_$d" 0
	echo "${v:-0}"
}

_collect() { # called per rule/group section
	local sid="$1" type="$2" name en macs win bud id
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

	eval "KT_NAME_$id=\$name"
	eval "KT_EN_$id=\$en"
	eval "KT_MACS_$id=\$macs"
	eval "KT_WIN_$id=\$win"
	eval "KT_BUD_$id=\$bud"
	IDS="$IDS $id"
}
_ML=""; _appendmac() { _ML="$_ML $1"; }
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
	local stored today; today=$(_daykey); stored=$(_kv_get day "")
	if [ "$stored" != "$today" ]; then
		: > "$KV"; _kv_set day "$today"; : > "$PREV"
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
		eval bud=\${KT_BUD_$id:-0}
		rem=$(( bud + bonus - used )); [ "$rem" -lt 0 ] && rem=0
		json_add_object "$id"
		eval json_add_string name \"\$KT_NAME_$id\"
		json_add_int used "$used"
		json_add_int budget "$bud"
		json_add_int bonus "$bonus"
		json_add_int remaining "$rem"
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
			chain forward {
				type filter hook forward priority -150; policy accept;
				ether saddr @blocked counter drop
			}
		}
	EOF
}
teardown() { $NFT delete table inet "$TABLE" 2>/dev/null; }

# ensure one named counter per tracked MAC for activity accounting.
# counter name = c_<sanitised mac>; rule counts forwarded pkts from that MAC.
_mac_key() { printf 'c_%s' "$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '_')"; }

_ensure_counters() {
	local id macs m key
	for id in $IDS; do
		eval macs=\${KT_MACS_$id:-}
		for m in $macs; do
			[ -z "$m" ] && continue
			key=$(_mac_key "$m")
			$NFT list counter inet "$TABLE" "$key" >/dev/null 2>&1 || {
				$NFT add counter inet "$TABLE" "$key" 2>/dev/null
				$NFT add rule inet "$TABLE" forward ether saddr "$m" counter name "$key" 2>/dev/null
			}
		done
	done
}

_counter_pkts() { # $1=mac -> packets
	local key v; key=$(_mac_key "$1")
	v=$($NFT -j list counter inet "$TABLE" "$key" 2>/dev/null \
	    | sed -n 's/.*"packets":[ ]*\([0-9]*\).*/\1/p' | head -n1)
	echo "${v:-0}"
}

# ---------------- enforcement decision ------------------------------------
# echoes "blocked" or "allowed" for an id given current state
_decide() {
	local id="$1" en win used bonus bud rem
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
			now=$(_counter_pkts "$m")
			key=$(_mac_key "$m")
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

cmd_reset() { _load_all; : > "$KV"; _kv_set day "$(_daykey)"; : > "$PREV"; cmd_apply; }

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

cmd_status() { _load_all; _ensure_counters 2>/dev/null; _export_json; cat "$USAGE"; }

case "${1:-}" in
	setup)    setup ;;
	apply)    cmd_apply ;;
	tick)     cmd_tick ;;
	reset)    cmd_reset ;;
	extend)   cmd_extend "$2" "$3" ;;
	status)   cmd_status ;;
	teardown) teardown ;;
	*) echo "usage: $0 {setup|apply|tick|reset|extend <mac> <min>|status|teardown}" >&2; exit 1 ;;
esac
