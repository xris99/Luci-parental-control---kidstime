# luci-app-kidtime

Per-device **internet time control** for **OpenWrt 23.05**. Two independent gates
are applied to each device (or group of devices):

1. **Time windows** — allowed timeframes per weekday (e.g. `mon,tue,wed,thu,fri 07:00-20:00`).
   Outside the window → blocked. Windows may cross midnight.
2. **Daily activity budget** — a per-weekday budget in minutes. A device only
   "spends" budget during minutes it is **actually sending traffic** (idle time
   is free). When the budget is used up → blocked until midnight, unless you grant
   bonus time from the web UI.

Devices can be **grouped** so several devices (e.g. one child's phone + tablet)
share a single budget pool.

This is a from-scratch implementation — it is **not** a port of
`luci-app-parentalcontrol` (that package does windows only, has no budget, and is
packaged for 25.x). It runs natively on 23.05 with fw4/nftables.

---

## Why this works on 23.05

OpenWrt 23.05 already ships everything required:

- **fw4 / nftables** — the enforcement uses one small `table inet kidtime` with a
  `forward` hook and a single `blocked` MAC set. It does **not** touch your fw4
  zone rules, so your three firewall zones (WAN_DMZ / WLAN / INTERN) are untouched.
- **rpcd + ubus** — the LuCI UI talks to a small rpcd shell plugin.
- **dnsmasq** — used only to populate the device picker from DHCP leases.
- **cron** — a one-line crontab entry runs the per-minute accounting tick.

### A note about your topology

OpenWrt routes between all three VLANs, so the **forward** chain sees traffic from
INTERN and WLAN devices heading to the internet (via the Fritzbox) — which is
exactly where this blocks. The hook priority (`-150`) places it ahead of fw4's
normal forwarding so a blocked device is dropped early.

Because matching is on **`ether saddr` (source MAC)**, the device must be on a
network where OpenWrt sees its real MAC as the L2 source — i.e. a VLAN/subnet that
OpenWrt is directly attached to. INTERN (192.168.100.0/24) and WLAN
(192.168.122.0/24) both qualify. Make sure **MAC randomisation is OFF** on the
kids' devices for the chosen Wi-Fi SSID, otherwise the MAC will change and the
rule won't match. (You picked MAC-based identification; if a device insists on
randomising, pin it to a static DHCP lease and disable "private/random MAC" for
that SSID in the device's settings.)

---

## Install (direct copy, no SDK needed)

From a machine that can SSH to the router:

```sh
cd luci-app-kidtime
scp -r root/* root@<router-ip>:/
scp -r htdocs/luci-static/resources/view/kidtime \
    root@<router-ip>:/www/luci-static/resources/view/

# on the router:
chmod +x /usr/libexec/kidtime.sh /usr/libexec/rpcd/kidtime /etc/init.d/kidtime
sh /etc/uci-defaults/luci-app-kidtime      # creates default config, enables service
/etc/init.d/rpcd restart
/etc/init.d/kidtime enable
/etc/init.d/kidtime start
```

The page appears under **Services → Internet Time (Kids)**.

### Building a real .ipk (optional)

If you use the OpenWrt 23.05 SDK with the luci feed, drop this directory into
`package/` (or a feed) and `make package/luci-app-kidtime/compile`. The provided
`Makefile` uses `luci.mk`, which produces a standard `.ipk` on 23.05. (The direct
copy above is simpler and is the recommended path.)

---

## Updating (without wiping your rules)

Do **not** re-copy `root/*` — that would overwrite `/etc/config/kidtime`. Copy only
the changed files:

```sh
scp root/usr/libexec/kidtime.sh        root@<router-ip>:/usr/libexec/kidtime.sh
scp root/usr/libexec/rpcd/kidtime      root@<router-ip>:/usr/libexec/rpcd/kidtime
scp htdocs/luci-static/resources/view/kidtime/settings.js \
    root@<router-ip>:/www/luci-static/resources/view/kidtime/settings.js
ssh root@<router-ip> '/etc/init.d/rpcd restart; /etc/init.d/kidtime restart'
```

---

## How it works (detail)

### Enforcement
`table inet kidtime` has a `forward` chain (priority -150, policy accept) with one
rule: `ether saddr @blocked counter drop`. The `blocked` set holds the MACs that
are currently denied. Per-tracked-MAC named counters (also in the chain) tally
**forwarded** packets for activity accounting — a blocked device forwards ~0
packets, so it cannot accrue activity while blocked.

### Per-minute tick
`/usr/libexec/kidtime.sh tick` runs every minute from cron:
1. Rolls the day over at local midnight (wipes used/bonus).
2. For each device/group, reads its MAC counters' delta since the last tick.
   If the delta exceeds `active_threshold` packets, that minute counts as **active**.
3. If active **and** the device is currently allowed **and** it has a budget,
   `used += 1`.
4. Recomputes who should be blocked (window gate **AND** budget gate) and rewrites
   the `blocked` set atomically.

### Decision
A device is **allowed** only when all of: global controls on, rule enabled,
current time inside one of its windows (or it has no windows), and
`budget + bonus - used > 0` (or budget is 0 = window-only). Otherwise **blocked**.

### Bonus / extend
The web UI's **+15m / +30m / +60m** buttons add to today's `bonus` for that
device/group and re-evaluate immediately. Bonus resets at midnight with everything
else.

### State
- `/etc/config/kidtime` — your rules and budgets (UCI, persistent).
- `/etc/kidtime/usage.kv` — today's used/bonus counters (survives reboot).
- `/etc/kidtime/usage.json` — same data, formatted for the UI.
- `/tmp/kidtime_prev` — last counter readings (volatile; rebuilt automatically).

---

## UCI schema

See the commented `/etc/config/kidtime` for full examples. Budgets are given per
weekday as `budget_mon` … `budget_sun` (minutes; `0` = no budget gate for that
day, i.e. window-only). Windows are `list window 'days hh:mm-hh:mm'`, repeatable.

---

## Limitations

- Blocks **all** internet traffic for the device; no per-service (YouTube-only)
  blocking. Pair with AdGuard Home if you want that.
- Activity accounting has 1-minute granularity; a child gets at most ~1 extra
  minute past the budget before the next tick blocks them.
- MAC-based: defeated by MAC randomisation. Use static leases + disable random MAC.
- A device that briefly idles still keeps whatever budget it hasn't spent — by
  design (you chose activity-based tracking).

## Uninstall

```sh
/etc/init.d/kidtime stop
/etc/init.d/kidtime disable
sed -i '\|kidtime.sh tick|d' /etc/crontabs/root; /etc/init.d/cron restart
rm -f /usr/libexec/kidtime.sh /usr/libexec/rpcd/kidtime /etc/init.d/kidtime
rm -f /etc/config/kidtime
rm -rf /etc/kidtime /tmp/kidtime_prev
rm -f /usr/share/luci/menu.d/luci-app-kidtime.json
rm -f /usr/share/rpcd/acl.d/luci-app-kidtime.json
rm -rf /www/luci-static/resources/view/kidtime
rm -f /tmp/luci-indexcache* /tmp/luci-modulecache/*
/etc/init.d/rpcd restart
```
