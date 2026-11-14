/* Saved accounts on this device (E1: switch between siblings / accounts without signing out).
   Only students and teachers can be remembered — never admin accounts. Each entry keeps the
   account's sign-in renewal token; passkeys.js keeps it fresh. "Sign out" forgets an account. */
(function () {
  'use strict';
  var KEY = 'cmz_accounts';
  function read() {
    try { var v = JSON.parse(localStorage.getItem(KEY) || 'null'); if (v && Array.isArray(v.list)) return v; } catch (e) {}
    // Older "keep me signed in" (one account) becomes the first saved account.
    try {
      var k = JSON.parse(localStorage.getItem('cmz_keep') || 'null');
      localStorage.removeItem('cmz_keep');
      if (k && k.refresh && k.type !== 'ADMIN') return { active: 'legacy', list: [{ authId: 'legacy', type: k.type, name: '', username: '', refresh: k.refresh }] };
    } catch (e) {}
    return { active: null, list: [] };
  }
  function write(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {} }
  function subOf(token) {
    try { var b = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(atob(b + '==='.slice((b.length + 3) % 4))).sub || ''; } catch (e) { return ''; }
  }
  var A = {
    subOf: subOf,
    all: function () { return read().list; },
    active: function () { var v = read(); return v.list.filter(function (a) { return a.authId === v.active; })[0] || null; },
    has: function (id) { return read().list.some(function (a) { return a.authId === id; }); },
    save: function (acc) {
      if (!acc || !acc.authId || !acc.refresh || acc.type === 'ADMIN') return;
      var v = read();
      var old = v.list.filter(function (a) { return a.authId === acc.authId; })[0] || {};
      v.list = v.list.filter(function (a) { return a.authId !== acc.authId && a.authId !== 'legacy'; });
      v.list.unshift({ authId: acc.authId, type: acc.type, name: acc.name || old.name || '', username: acc.username || old.username || '', refresh: acc.refresh });
      v.list = v.list.slice(0, 6);
      v.active = acc.authId;
      write(v);
    },
    update: function (id, fields) { var v = read(); v.list.forEach(function (a) { if (a.authId === id) Object.keys(fields).forEach(function (k) { if (fields[k]) a[k] = fields[k]; }); }); write(v); },
    setActive: function (id) { var v = read(); v.active = id; write(v); },
    clearActive: function () { var v = read(); v.active = null; write(v); },
    remove: function (id) { var v = read(); v.list = v.list.filter(function (a) { return a.authId !== id; }); if (v.active === id) v.active = null; write(v); },
    forgetActive: function () { var v = read(); if (v.active) { v.list = v.list.filter(function (a) { return a.authId !== v.active; }); v.active = null; write(v); } },
    label: function (a) { return (a.name || a.username || 'Saved account') + (a.username && a.name ? ' (' + a.username + ')' : '') + ' · ' + (a.type === 'TEACHER' ? 'Teacher' : 'Student'); },
    // Switch / add account from inside a portal. `current` = the signed-in account (it is remembered too).
    openSwitcher: function (ui, current) {
      var esc = ui.esc;
      if (current && current.authId && current.refresh) A.save(current);
      var others = A.all().filter(function (a) { return !current || a.authId !== current.authId; });
      ui.openDlg('Switch account',
        '<p class="muted" style="margin-top:0">For brothers and sisters, or a parent who is also a teacher. Accounts you switch between are remembered on this phone; <b>Sign out</b> removes one.</p>' +
        (others.length ? others.map(function (a) { return '<button type="button" class="btn" style="width:100%;justify-content:flex-start;margin-bottom:.5rem;text-align:left" data-acc="' + esc(a.authId) + '">👤 ' + esc(A.label(a)) + '</button>'; }).join('')
          : '<p class="muted">No other account is saved on this phone yet.</p>') +
        '<button type="button" class="btn primary" style="width:100%;margin-top:.4rem" id="acc-add">➕ Add another account</button>',
        '<button class="btn" type="button" data-close>Close</button>', function (d) {
          var leave = function (url) {
            try { ['cmz_st', 'cmz_sr', 'cmz_tt', 'cmz_trt', 'cmz_t', 'cmz_tr'].forEach(function (k) { sessionStorage.removeItem(k); }); } catch (e) {}
            location.replace(url);
          };
          Array.prototype.forEach.call(d.querySelectorAll('[data-acc]'), function (b) {
            b.addEventListener('click', function () { A.setActive(b.getAttribute('data-acc')); leave('student.html'); });
          });
          d.querySelector('#acc-add').addEventListener('click', function () { A.clearActive(); leave('student.html?add=1'); });
        });
    },
  };
  window.CMZAccounts = A;
})();
