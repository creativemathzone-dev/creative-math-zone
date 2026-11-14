/* Creative Math Zone — AI search bar (admin + teacher).
   The server turns a question into one fixed, read-only search and runs it with your
   own permissions. Names are hidden before anything is sent to the AI. */
(function () {
  'use strict';
  var STYLE = '.as-bar{display:flex;gap:.5rem;flex-wrap:wrap}.as-bar input{flex:1 1 260px;min-width:0;font:inherit;padding:.7rem .85rem;border:1px solid var(--line,#d9dee7);border-radius:10px}' +
    '.as-chips{display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.7rem}.as-chip{border:1px solid var(--line,#d9dee7);background:transparent;color:inherit;border-radius:999px;padding:.32rem .75rem;font:inherit;font-size:.86rem;cursor:pointer}' +
    '.as-chip:hover{border-color:currentColor}.as-meta{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin:.2rem 0 .6rem}.as-sum{font-weight:700;font-size:1.05rem}' +
    '.as-ex{margin:.6rem 0 0;padding-left:1.1rem;font-size:.9rem}.as-ex li{margin:.15rem 0}.as-ex button{background:none;border:0;padding:0;color:inherit;text-decoration:underline dotted;cursor:pointer;font:inherit;text-align:left}' +
    '.as-num{text-align:right;white-space:nowrap}.nav-search{padding:.2rem .9rem .7rem}.nav-search input{width:100%;box-sizing:border-box;font:inherit;font-size:.9rem;padding:.5rem .7rem;border-radius:9px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.1);color:inherit}' +
    '.nav-search input::placeholder{color:inherit;opacity:.7}';
  function addStyle() { if (document.getElementById('as-style')) return; var s = document.createElement('style'); s.id = 'as-style'; s.textContent = STYLE; document.head.appendChild(s); }
  function fnUrl() { var c = window.CMZ_CONFIG || {}; return String(c.supabaseUrl || '').replace(/\/$/, '') + '/functions/v1/ai-search'; }
  async function call(ctx, payload) {
    var c = window.CMZ_CONFIG || {}, res;
    try {
      res = await fetch(fnUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: c.supabasePublishableKey, Authorization: 'Bearer ' + ctx.token() }, body: JSON.stringify(payload) });
    } catch (e) { throw { error: 'No internet connection. Please try again.' }; }
    var out = await res.json().catch(function () { return {}; });
    if (!res.ok) throw { error: out.error || 'Search failed. Please try again.' };
    return out;
  }
  var st = { suggestions: null, aiEnabled: true, last: null, q: '' };
  var EXAMPLES = {
    ADMIN: ['Who hasn’t paid November fees in class X?', 'Students absent 3 or more times this week', 'How much did we collect in October by payment mode?', 'ICSE students who joined after 1 September', 'Which teacher has the most classes this week?', 'Birthdays this month'],
    TEACHER: ['My classes tomorrow', 'Who didn’t submit the DBMS homework?', 'Students absent in XII-A this week', 'Unanswered Computer Science doubts', 'Worksheets I made on networking', 'Attendance below 75% in my classes']
  };

  function cell(ctx, col, v) {
    var esc = ctx.esc;
    if (v == null || v === '') return '—';
    if (col.type === 'student') return '<button type="button" class="link" data-profile-student="' + esc(v.id) + '">' + esc(v.name) + '</button>';
    if (col.type === 'money') return '₹' + Math.round(Number(v)).toLocaleString('en-IN');
    if (col.type === 'pct') return esc(v) + '%';
    if (col.type === 'date') return /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? esc(String(v).slice(8, 10) + '/' + String(v).slice(5, 7) + '/' + String(v).slice(0, 4)) : esc(v);
    return esc(v);
  }
  function plain(col, v) {
    if (v == null) return '';
    if (col.type === 'student') return v.name;
    if (col.type === 'pct') return v + '%';
    return String(v);
  }
  function csv(result) {
    var q = function (s) { s = String(s == null ? '' : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var lines = [result.columns.map(function (c) { return q(c.label); }).join(',')];
    result.rows.forEach(function (r) { lines.push(result.columns.map(function (c) { return q(plain(c, r[c.key])); }).join(',')); });
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = (result.title || 'search').replace(/[^\w\- ]+/g, ' ').trim().slice(0, 60) + '.csv'; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 30000);
  }
  function renderResult(box, ctx, out) {
    var esc = ctx.esc, r = out.result;
    var via = out.via === 'ai' ? '<span class="pill">Understood by AI</span>' : out.via === 'cache' ? '<span class="pill">Asked earlier today · no AI used</span>' : out.via === 'button' ? '<span class="pill">Quick search · no AI</span>' : '<span class="pill">Direct search · no AI</span>';
    if (!r) { box.innerHTML = '<div class="card"><p style="margin:0">' + esc(out.message || 'No result.') + '</p>' + (out.understood ? '<p class="muted" style="margin:.4rem 0 0">Looked for: ' + esc(out.understood) + '</p>' : '') + '</div>'; return; }
    var open = r.open && ctx.canOpen && ctx.canOpen(r.open.view) ? '<button type="button" class="btn small" id="as-open">' + esc(r.open.label) + '</button>' : '';
    var table = r.rows.length ? '<div class="tablewrap"><table class="stack"><thead><tr>' + r.columns.map(function (c) { return '<th' + (c.type === 'money' || c.type === 'num' || c.type === 'pct' ? ' class="as-num"' : '') + '>' + esc(c.label) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      r.rows.map(function (row) { return '<tr>' + r.columns.map(function (c) { return '<td data-l="' + esc(c.label) + '"' + (c.type === 'money' || c.type === 'num' || c.type === 'pct' ? ' class="as-num"' : '') + '>' + cell(ctx, c, row[c.key]) + '</td>'; }).join('') + '</tr>'; }).join('') +
      '</tbody></table></div>' : '<p class="muted" style="margin:0">Nothing found.</p>';
    box.innerHTML = '<div class="card"><h2 style="font-size:1.15rem;margin:0 0 .3rem">' + esc(r.title) + '</h2><div class="as-meta">' + (r.summary ? '<span class="as-sum">' + esc(r.summary) + '</span>' : '') + via + '</div>' +
      table + '<div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.8rem">' + open + (r.rows.length ? '<button type="button" class="btn small" id="as-csv">Download list (CSV)</button>' : '') + '</div>' +
      (r.rows.length >= 500 ? '<p class="muted" style="margin:.5rem 0 0">Showing the first 500. Add more details to narrow the search.</p>' : '') +
      '<p class="muted" style="margin:.6rem 0 0;font-size:.82rem">Results come straight from your records, not from the AI. If this is not what you meant, ask in different words.</p></div>';
    var o = box.querySelector('#as-open'); if (o) o.addEventListener('click', function () { ctx.open(r.open.view); });
    var d = box.querySelector('#as-csv'); if (d) d.addEventListener('click', function () { csv(r); });
  }

  async function view(main, ctx, initialQ) {
    addStyle();
    var esc = ctx.esc, role = ctx.role === 'TEACHER' ? 'TEACHER' : 'ADMIN';
    main.innerHTML = '<div class="head"><div><h1>Search</h1><p>Ask in your own words, or type a student’s name, ID or phone number.</p></div></div>' +
      '<div class="card"><form id="as-form" class="as-bar" autocomplete="off"><input id="as-q" maxlength="200" placeholder="e.g. ' + esc(EXAMPLES[role][0]) + '" aria-label="Search"><button class="btn primary" id="as-go">Search</button></form>' +
      '<div class="as-chips" id="as-chips"><span class="muted">Loading quick searches…</span></div>' +
      '<details style="margin-top:.7rem"><summary class="muted">Example questions</summary><ul class="as-ex">' + EXAMPLES[role].map(function (x) { return '<li><button type="button" data-ex="' + esc(x) + '">' + esc(x) + '</button></li>'; }).join('') + '</ul></details>' +
      '<p class="muted" style="margin:.6rem 0 0;font-size:.82rem">🔒 Names, phone numbers and IDs are hidden before a question goes to the free AI. The AI only picks which search to run; it never sees your records and cannot change anything.</p></div>' +
      '<div id="as-out"></div>';
    var input = main.querySelector('#as-q'), out = main.querySelector('#as-out'), go = main.querySelector('#as-go');
    var run = function (payload, label) {
      return ctx.busy(go, async function () {
        go.textContent = payload.action === 'search' ? 'Searching…' : 'Loading…';
        out.innerHTML = '<div class="card"><span class="muted">' + esc(label) + '</span></div>';
        try { var r = await call(ctx, payload); st.last = r; renderResult(out, ctx, r); }
        catch (e) { out.innerHTML = '<div class="card" role="alert"><p style="margin:0">' + esc(e.error || 'Search failed.') + '</p></div>'; }
        finally { go.textContent = 'Search'; }
      });
    };
    var ask = function (q) { q = String(q || '').trim(); if (q.length < 2) { input.focus(); return; } st.q = q; input.value = q; run({ action: 'search', q: q }, 'Searching for “' + q + '”…'); };
    main.querySelector('#as-form').addEventListener('submit', function (ev) { ev.preventDefault(); ask(input.value); });
    Array.prototype.forEach.call(main.querySelectorAll('[data-ex]'), function (b) { b.addEventListener('click', function () { ask(b.getAttribute('data-ex')); }); });
    var showChips = function () {
      var box = main.querySelector('#as-chips');
      box.innerHTML = (st.suggestions || []).map(function (s, i) { return '<button type="button" class="as-chip" data-chip="' + i + '">' + esc(s.label) + '</button>'; }).join('') +
        (st.aiEnabled ? '' : '<span class="muted" style="font-size:.85rem">AI questions are off — quick buttons and name search still work.</span>');
      Array.prototype.forEach.call(box.querySelectorAll('[data-chip]'), function (b) {
        b.addEventListener('click', function () { var s = st.suggestions[+b.getAttribute('data-chip')]; input.value = ''; run({ action: 'run', plan: s.plan }, s.label + '…'); });
      });
    };
    if (st.suggestions) showChips();
    call(ctx, { action: 'suggest' }).then(function (r) { st.suggestions = r.suggestions || []; st.aiEnabled = !!r.aiEnabled; showChips(); })
      .catch(function () { var b = main.querySelector('#as-chips'); if (b) b.innerHTML = ''; });
    if (initialQ) ask(initialQ);
    else if (st.last && st.q) { input.value = st.q; renderResult(out, ctx, st.last); }
    input.focus();
  }

  // Small search box in the side menu; Enter opens the Search page with the question.
  function mountNavBox(container, onSearch) {
    if (!container || container.querySelector('.nav-search')) return;
    addStyle();
    var f = document.createElement('form'); f.className = 'nav-search'; f.setAttribute('role', 'search');
    f.innerHTML = '<input type="search" maxlength="200" placeholder="🔎 Search or ask…" aria-label="Search or ask">';
    f.addEventListener('submit', function (ev) { ev.preventDefault(); var i = f.querySelector('input'), q = i.value.trim(); i.value = ''; onSearch(q); });
    container.parentNode.insertBefore(f, container);
  }

  window.CMZSearch = { view: view, mountNavBox: mountNavBox };
})();
