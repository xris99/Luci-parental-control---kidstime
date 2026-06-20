'use strict';
'require view';
'require ui';
'require rpc';
'require uci';
'require dom';
'require poll';
'require network';

/* ---- RPC declarations -------------------------------------------------- */
var callStatus = rpc.declare({ object: 'kidtime', method: 'get_status' });
var callDevices = rpc.declare({ object: 'kidtime', method: 'list_devices' });
var callToggleGlobal = rpc.declare({
	object: 'kidtime', method: 'toggle_global', params: ['enabled']
});
var callSetConfig = rpc.declare({
	object: 'kidtime', method: 'set_config', params: ['config']
});
var callExtend = rpc.declare({
	object: 'kidtime', method: 'extend', params: ['mac', 'minutes']
});
var callSetBlock = rpc.declare({
	object: 'kidtime', method: 'set_block', params: ['mac', 'on']
});
var callResetDay = rpc.declare({ object: 'kidtime', method: 'reset_day' });
var callTraffic = rpc.declare({ object: 'kidtime', method: 'get_traffic' });

var DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
var DAY_LABEL = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

/* ---- helpers ----------------------------------------------------------- */
function fmtMin(m) {
	m = parseInt(m) || 0;
	if (m <= 0) return '0m';
	var h = Math.floor(m / 60), r = m % 60;
	return (h ? h + 'h ' : '') + (r ? r + 'm' : (h ? '' : '0m')).trim();
}

function fmtBytes(b) {
	b = parseFloat(b) || 0;
	if (b < 1024) return b + ' B';
	var u = ['KB', 'MB', 'GB', 'TB'], i = -1;
	do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
	return (b >= 10 ? Math.round(b) : Math.round(b * 10) / 10) + ' ' + u[i];
}

/* Parse `uci export kidtime` text into structured rule/group objects.
   We keep it tolerant: only the fields we render are extracted. */
function parseConfig(text) {
	var sections = [], cur = null, global = { exempt: [], exemptIp: [], enabled: '1', exempt_enabled: '1' };
	(text || '').split('\n').forEach(function (raw) {
		var line = raw.trim();
		var m;
		if ((m = line.match(/^config\s+(\S+)(?:\s+'([^']+)'|\s+(\S+))?\s*$/))) {
			if (cur) sections.push(cur);
			var nm = m[2] || m[3] || '';
			cur = { _type: m[1], _name: nm, windows: [], macs: [], budget: {}, exempt: [], exemptIp: [] };
		} else if (cur && (m = line.match(/^option\s+(\S+)\s+'([^']*)'/))) {
			var k = m[1], v = m[2];
			if (cur._type === 'global') {
				cur[k] = v;
			} else if (k === 'mac') cur.macs.push(v);
			else if (k.indexOf('budget_') === 0) cur.budget[k.slice(7)] = v;
			else cur[k] = v;
		} else if (cur && (m = line.match(/^list\s+(\S+)\s+'([^']*)'/))) {
			if (m[1] === 'window') cur.windows.push(m[2]);
			else if (m[1] === 'mac') cur.macs.push(m[2]);
			else if (m[1] === 'exempt_domain') cur.exempt.push(m[2]);
			else if (m[1] === 'exempt_ip') cur.exemptIp.push(m[2]);
		}
	});
	if (cur) sections.push(cur);
	// pull the global section's exempt info out for the caller
	sections.forEach(function (s) {
		if (s._type === 'global') {
			global.exempt = s.exempt || [];
			global.exemptIp = s.exemptIp || [];
			global.enabled = (s.enabled != null) ? s.enabled : '1';
			global.exempt_enabled = (s.exempt_enabled != null) ? s.exempt_enabled : '1';
		}
	});
	var rules = sections.filter(function (s) { return s._type === 'rule' || s._type === 'group'; });
	rules._global = global; // attach for convenience
	return rules;
}

/* Serialise structured rules into a uci batch script of add/set/add_list
   commands only. The rpcd plugin wipes existing rule/group sections before
   applying this, so we only need to (re)create them here. Anonymous sections
   are used; the human-readable name carries each rule's identity. */
function buildBatch(rules) {
	var lines = [];
	rules.forEach(function (r) {
		var t = (r._type === 'group') ? 'group' : 'rule';
		lines.push("add kidtime " + t);
		lines.push("set kidtime.@" + t + "[-1].name='" + (r.name || '').replace(/'/g, '') + "'");
		lines.push("set kidtime.@" + t + "[-1].enabled='" + (r.enabled === '0' ? '0' : '1') + "'");
		if (t === 'rule') {
			lines.push("set kidtime.@" + t + "[-1].mac='" + (r.macs[0] || '') + "'");
		} else {
			(r.macs || []).forEach(function (mc) {
				if (mc) lines.push("add_list kidtime.@" + t + "[-1].mac='" + mc + "'");
			});
		}
		(r.windows || []).forEach(function (w) {
			if (w) lines.push("add_list kidtime.@" + t + "[-1].window='" + w + "'");
		});
		DAYS.forEach(function (d) {
			var b = (r.budget && r.budget[d] != null) ? r.budget[d] : '0';
			lines.push("set kidtime.@" + t + "[-1].budget_" + d + "='" + b + "'");
		});
		(r.exempt || []).forEach(function (dom) {
			if (dom) lines.push("add_list kidtime.@" + t + "[-1].exempt_domain='" + dom.replace(/'/g, '') + "'");
		});
	});
	return lines.join('\n');
}

/* Build a uci-batch snippet that rewrites ONLY the global exempt domain list
   and exempt_enabled flag (leaves enabled/active_threshold untouched). The
   plugin runs this through `uci batch`; we delete existing exempt_domain
   entries first via a marker the plugin understands. */
function buildGlobalExemptBatch(globalExempt, exemptEnabled, globalExemptIp) {
	var lines = [];
	// NOTE: existing exempt_domain/exempt_ip lists are wiped by the rpcd plugin
	// (with `uci -q delete`, tolerating a missing option) BEFORE this batch runs.
	lines.push("set kidtime.global.exempt_enabled='" + (exemptEnabled ? '1' : '0') + "'");
	(globalExempt || []).forEach(function (dom) {
		if (dom) lines.push("add_list kidtime.global.exempt_domain='" + dom.replace(/'/g, '') + "'");
	});
	(globalExemptIp || []).forEach(function (ip) {
		if (ip) lines.push("add_list kidtime.global.exempt_ip='" + ip.replace(/'/g, '') + "'");
	});
	return lines.join('\n');
}

return view.extend({
	rulesCache: [],
	usageCache: {},
	devicesCache: [],

	load: function () {
		return Promise.all([
			callStatus().catch(function () { return {}; }),
			callDevices().catch(function () { return { devices: [] }; }),
			network.getHostHints().catch(function () { return null; })
		]);
	},

	/* Build a {mac: "MAC (name/ip)"} choices object from LuCI host hints,
	   the same data source the native firewall/DHCP MAC pickers use.
	   getMACHints() returns [mac, nameHint] tuples sorted by MAC. */
	macChoices: function () {
		var choices = {};
		var hints = this.hostHints;
		if (!hints || typeof hints.getMACHints !== 'function') return choices;
		(hints.getMACHints() || []).forEach(function (tuple) {
			var mac = tuple[0], hint = tuple[1];
			choices[mac] = hint ? (mac + ' (' + hint + ')') : mac;
		});
		return choices;
	},

	/* ---- data refresh ---- */
	refresh: function () {
		var self = this;
		// Never refresh while the editor is open: applyStatus() would rebuild
		// rulesCache from scratch and pull the data out from under the dialog,
		// which previously caused edited rules to be saved as duplicates.
		if (this.editorOpen) return Promise.resolve();
		return callStatus().then(function (st) {
			self.applyStatus(st);
			self.renderTable();
		});
	},

	applyStatus: function (st) {
		st = st || {};
		this.globalEnabled = (st.global_enabled != 0);
		this.dnsmasqStatus = st.dnsmasq_status || 'unknown';
		try { this.rulesCache = parseConfig(st.config || ''); } catch (e) { this.rulesCache = []; }
		// global exempt list + flag (from parseConfig's attached _global)
		var g = (this.rulesCache && this.rulesCache._global) || { exempt: [], exemptIp: [], exempt_enabled: '1' };
		this.globalExempt = g.exempt || [];
		this.globalExemptIp = g.exemptIp || [];
		this.exemptEnabled = (g.exempt_enabled != 0 && g.exempt_enabled !== '0');
		try { this.usageCache = JSON.parse(st.usage || '{}'); } catch (e) { this.usageCache = {}; }
	},

	/* sanitised id used as key in usage.json (mirror of backend _safe on the
	   human name option, so UI usage lookups line up with backend accounting) */
	idOf: function (r) {
		return ((r.name || r._name) || '').replace(/[^A-Za-z0-9]/g, '_');
	},

	usageFor: function (r) {
		var d = (this.usageCache && this.usageCache.devices) || {};
		return d[this.idOf(r)] || { used: 0, budget: 0, bonus: 0, remaining: 0, name: r.name };
	},

	/* ---- actions ---- */
	saveRules: function () {
		// combine the global exempt lists (domains + IPs) and all rules into one batch
		var batch = buildGlobalExemptBatch(this.globalExempt || [], this.exemptEnabled !== false, this.globalExemptIp || [])
			+ '\n' + buildBatch(this.rulesCache);
		return callSetConfig(batch).then(function (res) {
			if (res && res.ok) ui.addNotification(null, E('p', _('Saved.')), 'info');
			else ui.addNotification(null, E('p', _('Save failed: ') + ((res && res.error) || '?')), 'danger');
		});
	},

	doExtend: function (mac, mins) {
		return callExtend(mac, String(mins)).then(function (res) {
			if (res && res.ok) ui.addNotification(null, E('p', _('Added %s minutes.').format(mins)), 'info');
			else ui.addNotification(null, E('p', _('Could not extend: ') + ((res && res.error) || '?')), 'danger');
		});
	},

	doSetBlock: function (mac, on) {
		var self = this;
		return callSetBlock(mac, String(on)).then(function (res) {
			if (res && res.ok) {
				ui.addNotification(null, E('p', on ? _('Device blocked.') : _('Block removed.')), 'info');
			} else {
				ui.addNotification(null, E('p', _('Could not change block: ') + ((res && res.error) || '?')), 'danger');
			}
			return self.refresh();
		});
	},

	/* ---- edit modal ---- */
	openEditor: function (rule) {
		var self = this;
		var isNew = !rule;
		rule = rule || { _type: 'rule', _name: '', name: '', enabled: '1', macs: [], windows: [], budget: {} };
		// Remember the rule's identity at open time. We must NOT rely on the
		// object reference for locating it later: the 20s auto-refresh rebuilds
		// rulesCache with fresh parsed objects, so the original reference is gone
		// by save time. Identify by name (the same key the backend uses) plus the
		// index it currently occupies as a tie-breaker for duplicate names.
		var origName = isNew ? null : (rule.name || rule._name || '');
		var origIndex = isNew ? -1 : self.rulesCache.indexOf(rule);
		// working copy
		var work = JSON.parse(JSON.stringify(rule));
		if (!work.exempt) work.exempt = [];

		// --- window <-> struct helpers ----------------------------------
		// internal storage stays "days hh:mm-hh:mm" (backend + parse/build
		// depend on it); the UI works on a parsed struct {days:[], start, end}.
		function winToStruct(w) {
			var parts = String(w || '').trim().split(/\s+/);
			var daysPart = parts[0] || '';
			var range = parts[1] || '';
			var days = daysPart ? daysPart.split(',').filter(Boolean) : [];
			var start = '', end = '';
			if (range.indexOf('-') >= 0) { start = range.split('-')[0]; end = range.split('-')[1]; }
			return { days: days, start: start, end: end };
		}
		function structToWin(s) {
			if (!s.days.length || !s.start || !s.end) return '';
			// keep canonical weekday order
			var ordered = DAYS.filter(function (d) { return s.days.indexOf(d) >= 0; });
			return ordered.join(',') + ' ' + s.start + '-' + s.end;
		}

		// editor state: array of structs (parsed from work.windows)
		var winStructs = (work.windows.length ? work.windows : []).map(winToStruct);

		function dayCheckbox(struct, day) {
			var checked = struct.days.indexOf(day) >= 0;
			var cb = E('input', {
				'type': 'checkbox', 'style': 'margin:0',
				'change': function (ev) {
					if (ev.target.checked) {
						if (struct.days.indexOf(day) < 0) struct.days.push(day);
					} else {
						struct.days = struct.days.filter(function (d) { return d !== day; });
					}
				}
			});
			if (checked) cb.checked = true;
			return E('label', {
				'style': 'display:flex;flex-direction:column;align-items:center;gap:.1em;font-size:.85em;cursor:pointer'
			}, [ E('span', {}, DAY_LABEL[day]), cb ]);
		}

		function windowRow(struct, i) {
			var dayCells = DAYS.map(function (d) { return dayCheckbox(struct, d); });
			return E('div', {
				'class': 'cbi-value',
				'style': 'display:flex;gap:.75em;align-items:flex-end;flex-wrap:wrap;border-bottom:1px solid rgba(128,128,128,.2);padding:.4em 0'
			}, [
				E('div', { 'style': 'display:flex;gap:.4em' }, dayCells),
				E('div', { 'style': 'display:flex;flex-direction:column;gap:.1em' }, [
					E('span', { 'class': 'cbi-value-description', 'style': 'font-size:.85em' }, _('From')),
					E('input', {
						'type': 'time', 'value': struct.start, 'style': 'width:8em',
						'change': function (ev) { struct.start = ev.target.value; }
					})
				]),
				E('div', { 'style': 'display:flex;flex-direction:column;gap:.1em' }, [
					E('span', { 'class': 'cbi-value-description', 'style': 'font-size:.85em' }, _('Until')),
					E('input', {
						'type': 'time', 'value': struct.end, 'style': 'width:8em',
						'change': function (ev) { struct.end = ev.target.value; }
					})
				]),
				E('button', {
					'class': 'btn cbi-button-remove',
					'click': function () { winStructs.splice(i, 1); rerenderWindows(); }
				}, _('Remove'))
			]);
		}

		function windowRows() {
			if (!winStructs.length)
				return [ E('p', { 'class': 'cbi-value-description' },
					_('No time windows — internet is allowed at any time (still limited by the daily budget).')) ];
			return winStructs.map(windowRow);
		}
		var winContainer = E('div', {}, windowRows());
		function rerenderWindows() { dom.content(winContainer, windowRows()); }

		// per-rule exempt domain rows
		function exemptRows() {
			if (!work.exempt.length)
				return [ E('p', { 'class': 'cbi-value-description' }, _('No extra exempt domains for this device.')) ];
			return work.exempt.map(function (dom, i) {
				return E('div', { 'style': 'display:flex;gap:.5em;align-items:center;margin:.15em 0' }, [
					E('input', {
						'type': 'text', 'value': dom, 'placeholder': 'youtube.com', 'style': 'flex:1',
						'change': function (ev) { work.exempt[i] = ev.target.value.trim(); }
					}),
					E('button', {
						'class': 'btn cbi-button-remove',
						'click': function () { work.exempt.splice(i, 1); rerenderExempt(); }
					}, _('Remove'))
				]);
			});
		}
		var exemptContainer = E('div', {}, exemptRows());
		function rerenderExempt() { dom.content(exemptContainer, exemptRows()); }

		function budgetRow(d) {
			return E('div', { 'style': 'display:flex;align-items:center;gap:.5em;margin:.15em 0' }, [
				E('label', { 'style': 'width:3em' }, DAY_LABEL[d]),
				E('input', {
					'type': 'number', 'min': '0', 'style': 'width:6em',
					'value': (work.budget[d] != null ? work.budget[d] : '0'),
					'change': function (ev) { work.budget[d] = String(parseInt(ev.target.value) || 0); }
				}),
				E('span', { 'class': 'cbi-value-description' }, _('minutes (0 = no budget limit)'))
			]);
		}

		var nameInput = E('input', { 'type': 'text', 'value': work.name || '', 'style': 'width:100%' });
		var typeSelect = E('select', {
			'change': function (ev) { work._type = ev.target.value; rerenderMacs(); }
		}, [
			E('option', { 'value': 'rule', 'selected': work._type !== 'group' }, _('Single device')),
			E('option', { 'value': 'group', 'selected': work._type === 'group' }, _('Device group (shared budget)'))
		]);

		var allMacChoices = self.macChoices();

		function macPicker(currentVal, onChange) {
			// ui.Dropdown with create:true gives the native host dropdown plus
			// free-text entry, exactly like the firewall/DHCP MAC pickers.
			var choices = {};
			for (var k in allMacChoices)
				if (allMacChoices.hasOwnProperty(k)) choices[k] = allMacChoices[k];
			// make sure an already-set value that isn't a known host still shows
			if (currentVal && !choices[currentVal]) choices[currentVal] = currentVal;
			var dd = new ui.Dropdown(currentVal || '', choices, {
				optional: true,
				create: true,
				sort: true,
				select_placeholder: _('Select or type a MAC address'),
				custom_placeholder: _('AA:BB:CC:DD:EE:FF'),
				validate: function (val) {
					if (!val) return true;
					return /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(String(val).trim())
						? true : _('Enter a valid MAC (AA:BB:CC:DD:EE:FF)');
				}
			});
			var node = dd.render();
			node.addEventListener('cbi-dropdown-change', function () {
				var v = dd.getValue();
				onChange((v || '').trim());
			});
			return node;
		}

		function macRows() {
			var rows = [];
			var list = work.macs.length ? work.macs : [''];
			list.forEach(function (mc, i) {
				rows.push(E('div', { 'style': 'display:flex;gap:.5em;align-items:center;margin:.15em 0' }, [
					E('div', { 'style': 'flex:1' }, [
						macPicker(mc, function (v) { work.macs[i] = v; })
					]),
					(work._type === 'group') ? E('button', {
						'class': 'btn cbi-button-remove',
						'click': function () { work.macs.splice(i, 1); rerenderMacs(); }
					}, _('Remove')) : E('span', {})
				]));
			});
			if (work._type === 'group')
				rows.push(E('button', {
					'class': 'btn cbi-button-add',
					'click': function () { work.macs.push(''); rerenderMacs(); }
				}, _('+ Add device')));
			return rows;
		}
		var macContainer = E('div', {}, macRows());
		function rerenderMacs() { dom.content(macContainer, macRows()); }

		// pause auto-refresh while this dialog is open
		self.editorOpen = true;
		function closeEditor() { self.editorOpen = false; ui.hideModal(); }

		var dlg = ui.showModal(isNew ? _('Add device or group') : _('Edit: ') + (work.name || ''), [
			E('div', { 'class': 'cbi-value' }, [E('label', { 'class': 'cbi-value-title' }, _('Name')), nameInput]),
			E('div', { 'class': 'cbi-value' }, [E('label', { 'class': 'cbi-value-title' }, _('Type')), typeSelect]),
			E('div', { 'class': 'cbi-value' }, [E('label', { 'class': 'cbi-value-title' }, _('MAC address(es)')), macContainer]),
			E('h4', {}, _('Allowed time windows')),
			E('p', { 'class': 'cbi-value-description' },
				_('Tick the days a window applies to, then set the From/Until time. Add several rows for different days (e.g. weekdays vs. weekend). A window may cross midnight (From later than Until, e.g. 22:00–07:00). With no windows, internet is allowed any time, still limited by the daily budget.')),
			winContainer,
			E('button', {
				'class': 'btn cbi-button-add',
				'click': function () { winStructs.push({ days: [], start: '', end: '' }); rerenderWindows(); }
			}, _('+ Add window')),
			E('h4', {}, _('Extra exempt services (optional)')),
			E('p', { 'class': 'cbi-value-description' },
				_('Domains listed here do NOT count against this device\'s budget, in addition to the global list. One domain per line, e.g. youtube.com or *.spotify.com.')),
			exemptContainer,
			E('button', {
				'class': 'btn cbi-button-add',
				'click': function () { work.exempt.push(''); rerenderExempt(); }
			}, _('+ Add exempt domain')),
			E('h4', {}, _('Daily time budget')),
			E('div', {}, DAYS.map(budgetRow)),
			E('div', { 'class': 'right', 'style': 'margin-top:1em' }, [
				E('button', { 'class': 'btn', 'click': closeEditor }, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn cbi-button-save',
					'click': ui.createHandlerFn(self, function () {
						// commit working copy
						work.name = nameInput.value.trim();
						work._name = work.name; // backend uses anonymous sections; name carries identity

						// validate + serialize the window table
						var windows = [];
						for (var i = 0; i < winStructs.length; i++) {
							var s = winStructs[i];
							var hasDays = s.days.length > 0;
							var hasTimes = !!(s.start && s.end);
							// skip fully-empty rows silently
							if (!hasDays && !hasTimes) continue;
							if (hasDays && !hasTimes) {
								alert(_('Window %d: please set both From and Until times.').format(i + 1));
								return;
							}
							if (!hasDays && hasTimes) {
								alert(_('Window %d: please tick at least one day.').format(i + 1));
								return;
							}
							windows.push(structToWin(s));
						}
						work.windows = windows;
						work.macs = work.macs.filter(function (m) { return m && m.trim(); });
						work.exempt = (work.exempt || []).filter(function (d) { return d && d.trim(); });
						if (!work.name) { alert(_('Name is required.')); return; }
						if (!work.macs.length) { alert(_('At least one MAC address is required.')); return; }
						// names are identity keys (backend uses them for accounting),
						// so they must be unique; reject collisions with OTHER rules
						for (var n = 0; n < self.rulesCache.length; n++) {
							var existing = self.rulesCache[n];
							var en2 = existing.name || existing._name || '';
							var isSelf = (!isNew && en2 === origName && (origIndex < 0 || origIndex === n));
							if (en2 === work.name && !isSelf) {
								alert(_('A device or group named "%s" already exists. Please choose a different name.').format(work.name));
								return;
							}
						}
						if (isNew) {
							self.rulesCache.push(work);
						} else {
							// locate the entry to replace by identity, not by reference
							var idx = -1;
							// prefer the original index if it still holds a same-named rule
							if (origIndex >= 0 && self.rulesCache[origIndex] &&
								(self.rulesCache[origIndex].name || self.rulesCache[origIndex]._name) === origName) {
								idx = origIndex;
							} else {
								// otherwise find the first rule matching the original name
								for (var k = 0; k < self.rulesCache.length; k++) {
									var rn = self.rulesCache[k].name || self.rulesCache[k]._name || '';
									if (rn === origName) { idx = k; break; }
								}
							}
							if (idx >= 0) self.rulesCache[idx] = work;
							else self.rulesCache.push(work); // fallback: shouldn't happen
						}
						return self.saveRules().then(function () {
							self.editorOpen = false;
							ui.hideModal();
							return self.refresh();
						});
					})
				}, _('Save'))
			])
		]);
		return dlg;
	},

	deleteRule: function (rule) {
		var self = this;
		var name = rule.name || rule._name || '';
		if (!confirm(_('Delete "%s"?').format(name))) return;
		// identify by name rather than object reference (auto-refresh may have
		// rebuilt rulesCache with new object identities)
		var idx = this.rulesCache.indexOf(rule);
		if (idx < 0) {
			for (var k = 0; k < this.rulesCache.length; k++) {
				var rn = this.rulesCache[k].name || this.rulesCache[k]._name || '';
				if (rn === name) { idx = k; break; }
			}
		}
		if (idx >= 0) this.rulesCache.splice(idx, 1);
		this.saveRules().then(function () { self.refresh(); });
	},

	/* ---- table render ---- */
	renderTable: function () {
		var self = this;
		var rows = [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, _('Device / Group')),
				E('th', { 'class': 'th' }, _('Windows')),
				E('th', { 'class': 'th' }, _('Time left today')),
				E('th', { 'class': 'th' }, _('Status')),
				E('th', { 'class': 'th' }, _('Give more time')),
				E('th', { 'class': 'th' }, _('Manual block')),
				E('th', { 'class': 'th cbi-section-actions' }, '')
			])
		];

		this.rulesCache.forEach(function (r) {
			var u = self.usageFor(r);
			var bud = parseInt(u.budget) || 0;
			var rem = parseInt(u.remaining) || 0;
			var enabled = (r.enabled !== '0');
			var manualBlocked = (parseInt(u.manual_block) === 1);

			var statusBadge, statusColor;
			if (manualBlocked) { statusBadge = _('Blocked (manual)'); statusColor = '#c0392b'; }
			else if (!self.globalEnabled || !enabled) { statusBadge = _('Inactive'); statusColor = '#888'; }
			else if (bud > 0 && rem <= 0) { statusBadge = _('Out of time'); statusColor = '#c0392b'; }
			else { statusBadge = _('OK'); statusColor = '#27ae60'; }

			var leftText = (bud > 0)
				? (fmtMin(rem) + ' / ' + fmtMin(bud) + (parseInt(u.bonus) ? ' (+' + u.bonus + ' bonus)' : ''))
				: _('no budget');

			var firstMac = (r.macs && r.macs[0]) || '';
			var extendCell = (bud > 0 && firstMac)
				? E('div', { 'style': 'display:flex;gap:.3em' }, [
					E('button', { 'class': 'btn', 'click': ui.createHandlerFn(self, 'doExtend', firstMac, 15) }, '+15m'),
					E('button', { 'class': 'btn', 'click': ui.createHandlerFn(self, 'doExtend', firstMac, 30) }, '+30m'),
					E('button', { 'class': 'btn', 'click': ui.createHandlerFn(self, 'doExtend', firstMac, 60) }, '+60m')
				])
				: E('span', { 'class': 'cbi-value-description' }, '—');

			// manual block toggle (red when it would block, green to release)
			var blockBtn = firstMac
				? (manualBlocked
					? E('button', {
						'class': 'btn cbi-button-positive',
						'click': ui.createHandlerFn(self, 'doSetBlock', firstMac, 0)
					}, _('Unblock'))
					: E('button', {
						'class': 'btn cbi-button-negative',
						'click': ui.createHandlerFn(self, 'doSetBlock', firstMac, 1)
					}, _('Block now')))
				: E('span', { 'class': 'cbi-value-description' }, '—');

			rows.push(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, [
					E('strong', {}, r.name || r._name),
					E('br'),
					E('small', { 'style': 'color:#888' },
						(r._type === 'group' ? _('group: ') : '') + (r.macs || []).join(', '))
				]),
				E('td', { 'class': 'td' },
					(r.windows && r.windows.length)
						? r.windows.map(function (w) { return E('div', {}, w); })
						: E('span', { 'class': 'cbi-value-description' }, _('always'))),
				E('td', { 'class': 'td' }, leftText),
				E('td', { 'class': 'td' },
					E('span', { 'style': 'padding:.2em .6em;border-radius:.4em;color:#fff;background:' + statusColor }, statusBadge)),
				E('td', { 'class': 'td' }, extendCell),
				E('td', { 'class': 'td' }, blockBtn),
				E('td', { 'class': 'td cbi-section-actions' }, [
					E('button', { 'class': 'btn cbi-button-edit', 'click': ui.createHandlerFn(self, 'openEditor', r) }, _('Edit')),
					' ',
					E('button', { 'class': 'btn cbi-button-remove', 'click': ui.createHandlerFn(self, 'deleteRule', r) }, _('Delete'))
				])
			]));
		});

		if (this.rulesCache.length === 0)
			rows.push(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td', 'colspan': '6' }, _('No devices yet. Click "Add device or group" to start.'))
			]));

		dom.content(this.tableEl, rows);
	},

	render: function (data) {
		var self = this;
		var st = (data && data[0]) || {};
		this.devicesCache = ((data && data[1] && data[1].devices) || []);
		this.hostHints = (data && data[2]) || null;
		this.applyStatus(st);

		var globalToggle = E('button', {
			'class': 'btn',
			'click': ui.createHandlerFn(this, function () {
				var next = this.globalEnabled ? 0 : 1;
				return callToggleGlobal(next).then(function () { return self.refresh(); });
			})
		}, this.globalEnabled ? _('Controls ON — click to suspend all') : _('Controls SUSPENDED — click to enable'));

		this.tableEl = E('table', { 'class': 'table cbi-section-table' }, []);
		this.exemptEl = E('div', {});
		this.trafficEl = E('div', {});

		var container = E('div', {}, [
			E('h2', {}, _('Internet Time for Kids')),
			E('p', {}, _('Each device is allowed online only inside its time windows AND while it still has daily budget left. Budget counts minutes the device is actually active — except traffic to exempt services (below).')),
			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'style': 'display:flex;gap:1em;align-items:center;flex-wrap:wrap;margin-bottom:1em' }, [
					globalToggle,
					E('button', { 'class': 'btn cbi-button-add', 'click': ui.createHandlerFn(this, 'openEditor', null) }, _('Add device or group')),
					E('button', {
						'class': 'btn', 'click': ui.createHandlerFn(this, function () {
							if (confirm(_('Reset all used time for today?')))
								return callResetDay().then(function () { return self.refresh(); });
						})
					}, _('Reset today'))
				]),
				this.tableEl
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Exempt services (global)')),
				E('p', { 'class': 'cbi-value-description' },
					_('Traffic to these domains never counts against any budget — ideal for background services like push, sync and OS updates. Resolved to IP addresses by dnsmasq.')),
				this.exemptEl
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'style': 'display:flex;gap:1em;align-items:center;flex-wrap:wrap' }, [
					E('h3', { 'style': 'margin:0' }, _('Traffic by device')),
					E('button', { 'class': 'btn', 'click': ui.createHandlerFn(this, 'loadTraffic') }, _('Refresh traffic')),
					E('span', { 'class': 'cbi-value-description' }, _('Top destinations today, by volume. Use this to decide what to exempt.'))
				]),
				this.trafficEl
			])
		]);

		this.renderTable();
		this.renderExempt();
		dom.content(this.trafficEl, E('p', { 'class': 'cbi-value-description' },
			_('Click "Refresh traffic" to load current top destinations per device.')));

		// live refresh of remaining-time / status every 20s
		poll.add(function () { return self.refresh(); }, 20);

		return container;
	},

	/* ---- global exempt editor ---- */
	renderExempt: function () {
		var self = this;
		var rows = [];

		// dnsmasq capability notice
		if (this.dnsmasqStatus === 'nftset-unsupported') {
			rows.push(E('div', { 'class': 'alert-message warning', 'style': 'margin-bottom:1em' }, [
				E('strong', {}, _('dnsmasq-full required. ')),
				_('Domain exemptions need nftset support. Install it via: '),
				E('code', {}, 'opkg update && opkg install dnsmasq-full'),
				_(' (this replaces the stock dnsmasq). Until then, exemptions are inactive and all traffic counts.')
			]));
		} else if (this.dnsmasqStatus === 'unknown') {
			rows.push(E('p', { 'class': 'cbi-value-description' },
				_('dnsmasq status not yet known — save once or run apply to detect nftset support.')));
		}

		var list = this.globalExempt || [];
		if (!list.length) {
			rows.push(E('p', { 'class': 'cbi-value-description' }, _('No global exempt domains yet.')));
		}
		list.forEach(function (dom, i) {
			rows.push(E('div', { 'style': 'display:flex;gap:.5em;align-items:center;margin:.15em 0' }, [
				E('input', {
					'type': 'text', 'value': dom, 'placeholder': 'push.apple.com', 'style': 'flex:1;max-width:30em',
					'change': function (ev) { self.globalExempt[i] = ev.target.value.trim(); }
				}),
				E('button', {
					'class': 'btn cbi-button-remove',
					'click': function () { self.globalExempt.splice(i, 1); self.renderExempt(); }
				}, _('Remove'))
			]));
		});

		rows.push(E('div', { 'style': 'margin-top:.6em;display:flex;gap:.5em' }, [
			E('button', {
				'class': 'btn cbi-button-add',
				'click': function () { self.globalExempt.push(''); self.renderExempt(); }
			}, _('+ Add domain')),
			E('button', {
				'class': 'btn cbi-button-save',
				'click': ui.createHandlerFn(self, function () {
					// clean + dedupe both lists before saving
					var seen = {}, clean = [];
					(self.globalExempt || []).forEach(function (d) {
						d = (d || '').trim();
						if (d && !seen[d]) { seen[d] = 1; clean.push(d); }
					});
					self.globalExempt = clean;
					var seenIp = {}, cleanIp = [];
					(self.globalExemptIp || []).forEach(function (p) {
						p = (p || '').trim();
						if (p && !seenIp[p]) { seenIp[p] = 1; cleanIp.push(p); }
					});
					self.globalExemptIp = cleanIp;
					return self.saveRules().then(function () { return self.refresh(); });
				})
			}, _('Save exempt list'))
		]));

		// --- exempt IPs / CIDR ranges ---
		rows.push(E('h4', { 'style': 'margin:1em 0 .3em' }, _('Exempt IP addresses / ranges')));
		rows.push(E('p', { 'class': 'cbi-value-description' },
			_('For destinations that have no usable domain name (many CDNs). Accepts a single IP (e.g. 2.16.168.61) or a CIDR range (e.g. 2.16.168.0/24). Added directly to the firewall, no DNS needed.')));
		var iplist = this.globalExemptIp || [];
		if (!iplist.length) {
			rows.push(E('p', { 'class': 'cbi-value-description' }, _('No exempt IPs yet.')));
		}
		iplist.forEach(function (ip, i) {
			rows.push(E('div', { 'style': 'display:flex;gap:.5em;align-items:center;margin:.15em 0' }, [
				E('input', {
					'type': 'text', 'value': ip, 'placeholder': '2.16.168.0/24', 'style': 'flex:1;max-width:30em',
					'change': function (ev) { self.globalExemptIp[i] = ev.target.value.trim(); }
				}),
				E('button', {
					'class': 'btn cbi-button-remove',
					'click': function () { self.globalExemptIp.splice(i, 1); self.renderExempt(); }
				}, _('Remove'))
			]));
		});
		rows.push(E('div', { 'style': 'margin-top:.6em;display:flex;gap:.5em' }, [
			E('button', {
				'class': 'btn cbi-button-add',
				'click': function () { if (!self.globalExemptIp) self.globalExemptIp = []; self.globalExemptIp.push(''); self.renderExempt(); }
			}, _('+ Add IP / range')),
			E('button', {
				'class': 'btn cbi-button-save',
				'click': ui.createHandlerFn(self, function () {
					var seenIp = {}, cleanIp = [];
					(self.globalExemptIp || []).forEach(function (p) {
						p = (p || '').trim();
						if (p && !seenIp[p]) { seenIp[p] = 1; cleanIp.push(p); }
					});
					self.globalExemptIp = cleanIp;
					return self.saveRules().then(function () { return self.refresh(); });
				})
			}, _('Save IP list'))
		]));

		rows.push(E('p', { 'class': 'cbi-value-description', 'style': 'margin-top:.4em' }, [
			_('Tip: a domain covers its subdomains. Common picks: '),
			E('code', {}, 'push.apple.com, icloud.com, mesu.apple.com, gvt1.com, googleapis.com'),
			_('. Note: domain exemptions only work if devices use this router for DNS (no hardcoded DNS / DoH). IP exemptions always work.')
		]));

		dom.content(this.exemptEl, rows);
	},

	/* ---- traffic view ---- */
	loadTraffic: function () {
		var self = this;
		dom.content(this.trafficEl, E('p', { 'class': 'cbi-value-description' }, _('Loading traffic…')));
		return callTraffic().then(function (res) {
			self.renderTraffic(res);
		}).catch(function () {
			dom.content(self.trafficEl, E('p', { 'class': 'cbi-value-description' }, _('Could not load traffic data.')));
		});
	},

	renderTraffic: function (res) {
		var self = this;
		if (res && res.conntrack === false) {
			dom.content(this.trafficEl, E('div', { 'class': 'alert-message warning' }, [
				E('strong', {}, _('conntrack tool not installed. ')),
				_('Install it for traffic insight: '),
				E('code', {}, 'opkg update && opkg install conntrack')
			]));
			return;
		}
		var devices = (res && res.devices) || {};
		var blocks = [];
		var ids = Object.keys(devices);
		if (!ids.length) {
			blocks.push(E('p', { 'class': 'cbi-value-description' }, _('No traffic recorded yet today.')));
		}
		ids.forEach(function (id) {
			var d = devices[id];
			var top = (d && d.top) || [];
			var rows = [ E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, _('Destination')),
				E('th', { 'class': 'th' }, _('IP')),
				E('th', { 'class': 'th' }, _('Volume today')),
				E('th', { 'class': 'th' }, _('Exempt?'))
			]) ];
			if (!top.length) {
				rows.push(E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td', 'colspan': '4' }, _('No destinations recorded.')) ]));
			}
			top.forEach(function (t) {
				var nm = t.name || t.ip;
				var isExempt = self.destIsExempt(nm, t.ip);
				rows.push(E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td' }, nm),
					E('td', { 'class': 'td' }, E('small', { 'style': 'color:#888' }, t.ip)),
					E('td', { 'class': 'td' }, fmtBytes(t.bytes)),
					E('td', { 'class': 'td' },
						isExempt
							? E('span', { 'style': 'color:#27ae60' }, _('yes'))
							: E('button', {
								'class': 'btn cbi-button-apply',
								'click': ui.createHandlerFn(self, 'quickExempt', nm)
							}, _('Exempt this')))
				]));
			});
			blocks.push(E('div', { 'style': 'margin-bottom:1.2em' }, [
				E('h4', { 'style': 'margin:.3em 0' }, (d && d.name) || id),
				E('table', { 'class': 'table' }, rows)
			]));
		});
		dom.content(this.trafficEl, blocks);
	},

	// is a hostname covered by a global or any per-rule exempt domain?
	domainIsExempt: function (host) {
		host = (host || '').toLowerCase();
		if (!host) return false;
		var all = (this.globalExempt || []).slice();
		(this.rulesCache || []).forEach(function (r) { (r.exempt || []).forEach(function (d) { all.push(d); }); });
		return all.some(function (dom) {
			dom = (dom || '').toLowerCase().replace(/^\*\./, '');
			if (!dom) return false;
			return host === dom || host.indexOf('.' + dom) >= 0 || host.indexOf(dom) === 0;
		});
	},

	// check whether a destination (by name and/or ip) is exempted by either the
	// domain list or the IP/CIDR list (exact IP or /24 match for v4).
	destIsExempt: function (name, ip) {
		// domain match (only meaningful when name isn't just the ip)
		if (name && name !== ip && this.domainIsExempt(name)) return true;
		if (!ip) return false;
		var list = this.globalExemptIp || [];
		for (var i = 0; i < list.length; i++) {
			var e = (list[i] || '').trim();
			if (!e) continue;
			if (e === ip) return true;
			// /24 (or other CIDR) containment for IPv4
			var sl = e.indexOf('/');
			if (sl > 0 && /^[0-9.]+$/.test(ip) && /^[0-9.]+\/[0-9]+$/.test(e)) {
				var bits = parseInt(e.slice(sl + 1), 10);
				if (this.ipv4InCidr(ip, e.slice(0, sl), bits)) return true;
			}
		}
		return false;
	},

	ipv4InCidr: function (ip, net, bits) {
		function toInt(a) {
			var p = a.split('.'); if (p.length !== 4) return null;
			return ((+p[0] << 24) >>> 0) + (+p[1] << 16) + (+p[2] << 8) + (+p[3]);
		}
		var a = toInt(ip), b = toInt(net);
		if (a == null || b == null) return false;
		if (bits <= 0) return true;
		if (bits > 32) bits = 32;
		var mask = bits === 32 ? 0xffffffff : (~(0xffffffff >>> bits)) >>> 0;
		return ((a & mask) >>> 0) === ((b & mask) >>> 0);
	},

	// add a domain to the global exempt list and save immediately
	quickExempt: function (host) {
		var self = this;
		host = (host || '').trim();
		if (!host) return;

		var isV4 = /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(host);
		var isV6 = (host.indexOf(':') >= 0 && !/[a-zA-Z]/.test(host.replace(/:/g, '').replace(/[0-9a-fA-F]/g, '')));
		var isIp = isV4 || (host.indexOf(':') >= 0 && /^[0-9a-fA-F:]+$/.test(host));

		if (isIp) {
			// IP target: add to the exempt IP list (exact or, for v4, the /24)
			var slash24 = '';
			if (isV4) slash24 = host.replace(/\.[0-9]+$/, '.0/24');
			var modeExact = E('input', { 'type': 'radio', 'name': 'ipmode', 'checked': 'checked' });
			var modeNet = E('input', { 'type': 'radio', 'name': 'ipmode' });
			var body = [
				E('p', {}, _('This destination is an IP address (no domain name available). Add it to the exempt IP list so its traffic no longer counts against any budget.')),
				E('div', { 'style': 'margin:.5em 0' }, [
					E('label', { 'style': 'display:flex;gap:.5em;align-items:center;margin:.3em 0' }, [
						modeExact, E('span', {}, _('Exact IP: ') + host)
					])
				])
			];
			if (isV4) {
				body.push(E('div', {}, [
					E('label', { 'style': 'display:flex;gap:.5em;align-items:center;margin:.3em 0' }, [
						modeNet, E('span', {}, _('Whole /24 network: ') + slash24 + _('  (covers CDN address changes)'))
					])
				]));
			}
			body.push(E('div', { 'class': 'right', 'style': 'margin-top:1em' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn cbi-button-save',
					'click': ui.createHandlerFn(self, function () {
						var val = (isV4 && modeNet.checked) ? slash24 : host;
						if (!self.globalExemptIp) self.globalExemptIp = [];
						if (self.globalExemptIp.indexOf(val) < 0) self.globalExemptIp.push(val);
						ui.hideModal();
						self.renderExempt();
						return self.saveRules().then(function () {
							ui.addNotification(null, E('p', _('Added IP exemption: %s').format(val)), 'info');
							return self.refresh();
						});
					})
				}, _('Add IP exemption'))
			]));
			ui.showModal(_('Exempt an IP address'), body);
			return;
		}

		// Domain target: suggest a registrable-ish parent so subdomains match
		var parts = host.split('.');
		var suggested = host;
		if (parts.length > 2) suggested = parts.slice(-2).join('.');
		var input = E('input', { 'type': 'text', 'value': suggested, 'style': 'width:100%' });
		ui.showModal(_('Exempt a service'), [
			E('p', {}, _('Add a domain to the global exempt list. Its traffic will no longer count against any budget. A domain automatically covers its subdomains.')),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Domain')),
				input
			]),
			E('p', { 'class': 'cbi-value-description' }, _('Seen for this destination: ') + host),
			E('div', { 'class': 'right', 'style': 'margin-top:1em' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn cbi-button-save',
					'click': ui.createHandlerFn(self, function () {
						var useDom = (input.value || '').trim();
						if (!useDom) { ui.hideModal(); return; }
						if (!self.globalExempt) self.globalExempt = [];
						if (self.globalExempt.indexOf(useDom) < 0) self.globalExempt.push(useDom);
						ui.hideModal();
						self.renderExempt();
						return self.saveRules().then(function () {
							ui.addNotification(null, E('p', _('Added "%s" to the exempt list.').format(useDom)), 'info');
							return self.refresh();
						});
					})
				}, _('Add to exempt list'))
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
