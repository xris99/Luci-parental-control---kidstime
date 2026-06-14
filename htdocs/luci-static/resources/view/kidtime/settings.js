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
var callResetDay = rpc.declare({ object: 'kidtime', method: 'reset_day' });

var DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
var DAY_LABEL = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

/* ---- helpers ----------------------------------------------------------- */
function fmtMin(m) {
	m = parseInt(m) || 0;
	if (m <= 0) return '0m';
	var h = Math.floor(m / 60), r = m % 60;
	return (h ? h + 'h ' : '') + (r ? r + 'm' : (h ? '' : '0m')).trim();
}

/* Parse `uci export kidtime` text into structured rule/group objects.
   We keep it tolerant: only the fields we render are extracted. */
function parseConfig(text) {
	var sections = [], cur = null;
	(text || '').split('\n').forEach(function (raw) {
		var line = raw.trim();
		var m;
		if ((m = line.match(/^config\s+(\S+)(?:\s+'([^']+)'|\s+(\S+))?\s*$/))) {
			if (cur) sections.push(cur);
			var nm = m[2] || m[3] || '';
			cur = { _type: m[1], _name: nm, windows: [], macs: [], budget: {} };
		} else if (cur && (m = line.match(/^option\s+(\S+)\s+'([^']*)'/))) {
			var k = m[1], v = m[2];
			if (k === 'mac') cur.macs.push(v);
			else if (k.indexOf('budget_') === 0) cur.budget[k.slice(7)] = v;
			else cur[k] = v;
		} else if (cur && (m = line.match(/^list\s+(\S+)\s+'([^']*)'/))) {
			if (m[1] === 'window') cur.windows.push(m[2]);
			else if (m[1] === 'mac') cur.macs.push(m[2]);
		}
	});
	if (cur) sections.push(cur);
	return sections.filter(function (s) { return s._type === 'rule' || s._type === 'group'; });
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
		try { this.rulesCache = parseConfig(st.config || ''); } catch (e) { this.rulesCache = []; }
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
		var batch = buildBatch(this.rulesCache);
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
				E('th', { 'class': 'th cbi-section-actions' }, '')
			])
		];

		this.rulesCache.forEach(function (r) {
			var u = self.usageFor(r);
			var bud = parseInt(u.budget) || 0;
			var rem = parseInt(u.remaining) || 0;
			var enabled = (r.enabled !== '0');

			var statusBadge, statusColor;
			if (!self.globalEnabled || !enabled) { statusBadge = _('Inactive'); statusColor = '#888'; }
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

		var container = E('div', {}, [
			E('h2', {}, _('Internet Time for Kids')),
			E('p', {}, _('Each device is allowed online only inside its time windows AND while it still has daily budget left. Budget counts minutes the device is actually active.')),
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
			])
		]);

		this.renderTable();

		// live refresh of remaining-time / status every 20s
		poll.add(function () { return self.refresh(); }, 20);

		return container;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
