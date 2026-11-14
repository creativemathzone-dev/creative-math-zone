/* Creative Math Zone — AI worksheet maker (board-style test papers + answer keys).
   Teachers/Super Admin: CMZWorksheets.view(main, ctx)
   Students:             CMZWorksheets.studentOpen(ctx, homeworkId), CMZWorksheets.studentKeys(el, ctx)
   ctx = { esc, toast, busy, openDlg, closeDlg, role, token, centreName } */
(function () {
  'use strict';
  var STYLE = '.ws-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:.7rem}' +
    '.ws-form label{display:block;margin-bottom:.8rem}.ws-form label>span{display:block;font-weight:600;margin-bottom:.3rem}' +
    '.ws-form input,.ws-form select,.ws-form textarea,.ws-filters input,.ws-filters select{width:100%;box-sizing:border-box;padding:.55rem .6rem;border:1px solid var(--line,#d9dee7);border-radius:8px;font:inherit;background:var(--paper,#fff);color:inherit}' +
    '.ws-filters{display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:1rem}.ws-filters>*{flex:1 1 150px;width:auto}' +
    '.ws-item{display:block;width:100%;text-align:left;font:inherit;color:inherit;cursor:pointer;margin-bottom:.7rem}.ws-item:hover{border-color:var(--pencil,#f3b11c)}' +
    '.ws-meta{font-size:.86rem;opacity:.75;margin-top:.25rem}.ws-actions{display:flex;gap:.5rem;flex-wrap:wrap;margin:.8rem 0}' +
    '.ws-text{font-family:ui-monospace,Consolas,monospace;font-size:.92rem;line-height:1.5;min-height:18rem}' +
    '.ws-hint{font-size:.86rem;padding:.5rem .7rem;border-radius:8px;background:rgba(243,177,28,.12);margin:-.3rem 0 .8rem}';
  function addStyle() { if (document.getElementById('ws-style')) return; var s = document.createElement('style'); s.id = 'ws-style'; s.textContent = STYLE; document.head.appendChild(s); }
  function fnUrl() { var c = window.CMZ_CONFIG || {}; return String(c.supabaseUrl || '').replace(/\/$/, '') + '/functions/v1/worksheets'; }
  async function call(ctx, action, payload) {
    var c = window.CMZ_CONFIG || {};
    var res;
    try {
      res = await fetch(fnUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: c.supabasePublishableKey, Authorization: 'Bearer ' + ctx.token() },
        body: JSON.stringify(Object.assign({ action: action }, payload || {})) });
    } catch (e) {
      throw { error: action === 'generate' ? 'The connection dropped while the AI was writing (keep this page open and the screen on). Please try again.' : 'No internet connection. Please try again.' };
    }
    var out = await res.json().catch(function () { return {}; });
    if (!res.ok) throw { error: out.error || (action === 'generate' && (res.status === 504 || res.status === 546 || res.status >= 500)
      ? 'The AI took too long this time. Please try again — fewer marks are faster.' : 'Something went wrong. Please try again.') };
    return out;
  }
  // Shows "AI is writing… 25s" so a long wait does not look stuck.
  function ticking(btn, label) {
    var t0 = Date.now(); btn.textContent = label + '…';
    var id = setInterval(function () { btn.textContent = label + '… ' + Math.round((Date.now() - t0) / 1000) + 's'; }, 1000);
    return function (restore) { clearInterval(id); btn.textContent = restore; };
  }
  var CLASSES = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
  var MARKS = [10, 20, 25, 30, 40, 50, 80];
  function when(v) { var d = new Date(v); return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); }
  function opt(esc, v, label, sel) { return '<option value="' + esc(v) + '"' + (sel ? ' selected' : '') + '>' + esc(label) + '</option>'; }

  /* ---------- printing (questions only, or with answer key on a new page) ---------- */
  function printSheet(ctx, w, withKey) {
    var esc = ctx.esc, centre = esc(ctx.centreName ? ctx.centreName() : 'Creative Math Zone');
    var logo = new URL('./icons/creative-math-zone-logo.png', location.href).href;
    var head = '<header><img src="' + logo + '" alt=""><div><b>' + centre + '</b><div>' + esc(w.Title) + '</div></div></header>' +
      '<div class="meta"><span>' + [w.ClassName ? 'Class ' + esc(w.ClassName) : '', esc(w.Board || ''), esc(w.SubjectName || ''), esc(w.Chapter || ''), w.Set === 'B' ? 'Set B' : ''].filter(Boolean).join(' · ') + '</span>' +
      '<span>Full Marks: ' + esc(w.TotalMarks) + ' &nbsp; Time: ' + esc(w.DurationMin) + ' min</span></div>';
    var body = head + '<div class="who">Name: ______________________ &nbsp; Roll: ________ &nbsp; Date: ____________</div><pre>' + esc(w.Questions) + '</pre>' +
      (withKey ? '<section class="key">' + head + '<h2>ANSWER KEY — teacher copy</h2><pre>' + esc(w.AnswerKey) + '</pre></section>' : '');
    var win = window.open('', '_blank', 'width=900,height=700');
    if (!win) { ctx.toast('Allow pop-ups for this site to print.', true); return; }
    win.document.write('<!doctype html><html><head><meta charset="utf-8"><title>' + esc(w.Title) + '</title><style>' +
      'body{font-family:Arial,sans-serif;color:#111;margin:24px}header{display:flex;gap:12px;align-items:center;border-bottom:2px solid #16243b;padding-bottom:8px}' +
      'header img{width:52px;height:52px;border-radius:50%;object-fit:cover}header b{font-size:20px}.meta{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;margin:10px 0;font-size:14px;font-weight:bold}' +
      '.who{margin:12px 0 16px;font-size:14px}pre{white-space:pre-wrap;font-family:"Times New Roman",serif;font-size:15.5px;line-height:1.55;margin:0}' +
      '.key{page-break-before:always;break-before:page}h2{font-size:16px;margin:14px 0}@media print{body{margin:12mm}}' +
      '</style></head><body>' + body + '<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},300)})<\/script></body></html>');
    win.document.close();
  }

  /* ---------- library ---------- */
  var st = { subjectId: '', board: '', className: '', search: '', mine: false };
  async function view(main, ctx) {
    addStyle();
    var esc = ctx.esc;
    main.innerHTML = '<div class="head"><div><h1>Worksheets</h1><p>AI makes board-style test papers with answer keys. Check, edit, print or send as homework. After 7 days each worksheet’s text is kept in Google Drive.</p></div>' +
      '<button class="btn primary" id="ws-new" type="button">New worksheet</button></div><div id="ws-body"><div class="cmz-loader"><i></i></div></div>';
    var info = await call(ctx, 'context');
    main.querySelector('#ws-new').addEventListener('click', function () { create(main, ctx, info); });
    var out = await call(ctx, 'list', st);
    var body = main.querySelector('#ws-body');
    body.innerHTML = '<div class="ws-filters"><select id="ws-f-sub" aria-label="Subject">' + opt(esc, '', 'All subjects', !st.subjectId) + info.subjects.map(function (s) { return opt(esc, s.id, s.name, s.id === st.subjectId); }).join('') + '</select>' +
      '<select id="ws-f-board" aria-label="Board">' + opt(esc, '', 'All boards', !st.board) + info.boards.map(function (b) { return opt(esc, b, b, b === st.board); }).join('') + '</select>' +
      '<select id="ws-f-class" aria-label="Class">' + opt(esc, '', 'All classes', !st.className) + CLASSES.map(function (c) { return opt(esc, c, 'Class ' + c, c === st.className); }).join('') + '</select>' +
      '<input id="ws-f-q" type="search" placeholder="Search title or chapter" value="' + esc(st.search) + '">' +
      (ctx.role === 'TEACHER' ? '<label style="display:flex;gap:.4rem;align-items:center;flex:0 0 auto"><input type="checkbox" id="ws-f-mine" style="width:auto"' + (st.mine ? ' checked' : '') + '> Only mine</label>' : '') + '</div>' +
      (out.rows.length ? out.rows.map(function (w) {
        return '<button type="button" class="card ws-item" data-ws="' + esc(w.WorksheetID) + '"><div style="display:flex;justify-content:space-between;gap:.6rem;flex-wrap:wrap"><b>' + esc(w.Title) + '</b>' +
          '<span class="pill">' + esc(w.TotalMarks) + ' marks' + (w.Set === 'B' ? ' · Set B' : w.Set === 'Q' ? ' · Quiz' : '') + '</span></div>' +
          '<div class="ws-meta">' + esc(w.SubjectName) + ' · Class ' + esc(w.ClassName) + ' · ' + esc(w.Board) + (w.Chapter ? ' · ' + esc(w.Chapter) : '') + ' · ' + esc(w.Difficulty.toLowerCase()) +
          (w.TeacherName ? ' · ' + esc(w.TeacherName) : '') + ' · ' + esc(when(w.CreatedAt)) + (w.Archived ? ' · 📁 in Drive' : '') + '</div></button>';
      }).join('') : '<div class="card empty"><b>No worksheets yet</b>Tap “New worksheet” to make the first one.</div>');
    var reload = function () { view(main, ctx).catch(function (e) { ctx.toast(e.error || 'Could not load.', true); }); };
    body.querySelector('#ws-f-sub').addEventListener('change', function (e) { st.subjectId = e.target.value; reload(); });
    body.querySelector('#ws-f-board').addEventListener('change', function (e) { st.board = e.target.value; reload(); });
    body.querySelector('#ws-f-class').addEventListener('change', function (e) { st.className = e.target.value; reload(); });
    var t; body.querySelector('#ws-f-q').addEventListener('input', function (e) { clearTimeout(t); t = setTimeout(function () { st.search = e.target.value; reload(); }, 400); });
    var mine = body.querySelector('#ws-f-mine'); if (mine) mine.addEventListener('change', function (e) { st.mine = e.target.checked; reload(); });
    Array.prototype.forEach.call(body.querySelectorAll('[data-ws]'), function (b) { b.addEventListener('click', function () { detail(main, ctx, b.getAttribute('data-ws'), info); }); });
  }

  /* ---------- create ---------- */
  function create(main, ctx, info) {
    addStyle();
    var esc = ctx.esc;
    main.innerHTML = '<p><button type="button" class="link" id="ws-back">← Worksheets</button></p><div class="head"><div><h1>New worksheet</h1><p>Pick a batch to fill in the class and board automatically, or choose them yourself.</p></div></div>' +
      '<div class="card"><form class="ws-form" id="ws-form"><div class="ws-grid">' +
      '<label><span>Batch (optional)</span><select name="batchId">' + opt(esc, '', '— Choose class and board myself —', true) + info.batches.map(function (b) { return opt(esc, b.BatchID, b.BatchName + ' (Class ' + b.ClassName + ')', false); }).join('') + '</select></label>' +
      '<label><span>Subject</span><select name="subjectId" required>' + opt(esc, '', 'Choose…', true) + info.subjects.map(function (s) { return opt(esc, s.id, s.name, false); }).join('') + '</select></label>' +
      '<label><span>Class</span><select name="className" required>' + opt(esc, '', 'Choose…', true) + CLASSES.map(function (c) { return opt(esc, c, 'Class ' + c, false); }).join('') + '</select></label>' +
      '<label><span>Board / exam pattern</span><select name="board" required>' + opt(esc, '', 'Choose…', true) + info.boards.map(function (b) { return opt(esc, b, b, false); }).join('') + '</select></label>' +
      '</div><div class="ws-hint" id="ws-board-hint" hidden></div>' +
      '<label><span>Chapter / topic</span><input name="chapter" maxlength="150" required placeholder="e.g. Quadratic equations — nature of roots"></label><div class="ws-grid">' +
      '<label><span>Difficulty</span><select name="difficulty">' + opt(esc, 'MIXED', 'Mixed (recommended)', true) + opt(esc, 'EASY', 'Easy', false) + opt(esc, 'MEDIUM', 'Medium', false) + opt(esc, 'HARD', 'Hard', false) + '</select></label>' +
      '<label><span>Full marks</span><select name="totalMarks">' + MARKS.map(function (m) { return opt(esc, m, m + ' marks', m === 20); }).join('') + '</select></label>' +
      '</div><button class="btn primary" type="submit" id="ws-go">Make worksheet with AI</button>' +
      '<p class="muted" style="font-size:.86rem;margin-bottom:0">Only the class, board, subject and topic are sent to the AI — never student details. It can take up to two minutes. Always check the paper and answer key before using them.</p></form></div>';
    var f = main.querySelector('#ws-form');
    main.querySelector('#ws-back').addEventListener('click', function () { view(main, ctx); });
    f.elements.batchId.addEventListener('change', function () {
      var b = info.batches.filter(function (x) { return x.BatchID === f.elements.batchId.value; })[0], hint = main.querySelector('#ws-board-hint');
      if (!b) { hint.hidden = true; return; }
      f.elements.className.value = CLASSES.indexOf(String(b.ClassName).toUpperCase()) >= 0 ? String(b.ClassName).toUpperCase() : '';
      if (b.SuggestedBoard) f.elements.board.value = b.SuggestedBoard;
      if (b.Subjects && b.Subjects.length === 1) f.elements.subjectId.value = b.Subjects[0].id;
      var mix = Object.keys(b.BoardCounts).map(function (k) { return k + ': ' + b.BoardCounts[k]; }).join(' · ');
      hint.hidden = false;
      hint.innerHTML = 'Students in this batch — ' + esc(mix || 'none yet') + (b.SuggestedBoard ? '. Using <b>' + esc(b.SuggestedBoard) + '</b> (you can change it).' : '. Choose the board.');
    });
    f.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var btn = main.querySelector('#ws-go');
      ctx.busy(btn, async function () {
        var p = { batchId: f.elements.batchId.value, subjectId: f.elements.subjectId.value, className: f.elements.className.value, board: f.elements.board.value,
          chapter: f.elements.chapter.value.trim(), difficulty: f.elements.difficulty.value, totalMarks: Number(f.elements.totalMarks.value) };
        if (!p.subjectId || !p.className || !p.board || !p.chapter) throw { error: 'Fill in subject, class, board and chapter.' };
        var stop = ticking(btn, 'AI is writing the paper');
        try { var out = await call(ctx, 'generate', p); } finally { stop('Make worksheet with AI'); }
        ctx.toast('Worksheet ready. Check it before using.');
        detail(main, ctx, out.worksheet.WorksheetID, info, out.worksheet);
      });
    });
  }

  /* ---------- detail / edit ---------- */
  async function detail(main, ctx, id, info, preloaded) {
    addStyle();
    var esc = ctx.esc;
    main.innerHTML = '<div class="cmz-loader"><i></i></div>';
    var w = preloaded || (await call(ctx, 'get', { id: id })).worksheet;
    var canEdit = !!w.CanEdit, ro = canEdit ? '' : ' readonly';
    main.innerHTML = '<p><button type="button" class="link" id="ws-back">← Worksheets</button></p>' +
      '<div class="card"><label class="f"><span>Title</span><input id="ws-title" maxlength="150" value="' + esc(w.Title) + '"' + ro + '></label>' +
      '<div class="ws-meta">' + esc(w.SubjectName) + ' · Class ' + esc(w.ClassName) + ' · ' + esc(w.Board) + (w.Chapter ? ' · ' + esc(w.Chapter) : '') + ' · ' + esc(w.TotalMarks) + ' marks · ' + esc(w.DurationMin) + ' min' + (w.Set === 'B' ? ' · Set B' : w.Set === 'Q' ? ' · Quick quiz' : '') + (w.TeacherName ? ' · by ' + esc(w.TeacherName) : '') + '</div>' +
      '<div class="ws-actions">' + (canEdit ? '<button class="btn primary" type="button" id="ws-save">Save changes</button>' : '') +
      '<button class="btn" type="button" id="ws-print">Print questions</button><button class="btn" type="button" id="ws-print-key">Print with answer key</button>' +
      (w.Set === 'A' ? '<button class="btn" type="button" id="ws-setb">Make Set B</button>' : '') +
      (w.Set !== 'Q' ? '<button class="btn" type="button" id="ws-quiz">Quick quiz (MCQ)</button>' : '') +
      '<button class="btn" type="button" id="ws-check">✔ Check a copy with AI</button>' +
      (ctx.role === 'TEACHER' ? '<button class="btn" type="button" id="ws-assign">Send as homework</button>' : '') +
      (canEdit ? '<button class="btn danger" type="button" id="ws-del">Delete</button>' : '') + '</div>' +
      (w.Homework && w.Homework.length ? '<p class="ws-meta" style="opacity:1">Sent as homework: ' + w.Homework.map(function (h) { return esc(h.BatchName) + ' (due ' + esc(when(h.DueAt)) + ')'; }).join(', ') + '</p>' : '') +
      '<p class="muted" style="font-size:.86rem">AI can make mistakes. Check every question, the marks total and the answers before printing or sending.</p></div>' +
      '<div class="card"><h2 style="font-size:1.1rem;margin:0 0 .4rem">Question paper</h2><textarea id="ws-q" class="ws-text" style="width:100%;box-sizing:border-box"' + ro + '>' + esc(w.Questions) + '</textarea></div>' +
      '<div class="card"><h2 style="font-size:1.1rem;margin:0 0 .4rem">Answer key <span class="muted" style="font-size:.85rem;font-weight:400">(students see it only after the homework deadline)</span></h2><textarea id="ws-k" class="ws-text" style="width:100%;box-sizing:border-box"' + ro + '>' + esc(w.AnswerKey) + '</textarea></div>';
    var current = function () { return Object.assign({}, w, { Title: main.querySelector('#ws-title').value, Questions: main.querySelector('#ws-q').value, AnswerKey: main.querySelector('#ws-k').value }); };
    var on = function (sel, fn) { var el = main.querySelector(sel); if (el) el.addEventListener('click', function (ev) { ctx.busy(ev.target, fn); }); };
    main.querySelector('#ws-back').addEventListener('click', function () { view(main, ctx); });
    on('#ws-save', async function () { var c = current(); await call(ctx, 'save', { id: w.WorksheetID, title: c.Title, questions: c.Questions, answerKey: c.AnswerKey }); w = c; ctx.toast('Saved.'); });
    on('#ws-print', async function () { printSheet(ctx, current(), false); });
    on('#ws-print-key', async function () { printSheet(ctx, current(), true); });
    on('#ws-setb', async function () {
      var b = main.querySelector('#ws-setb'), stop = ticking(b, 'AI is writing Set B');
      try { var out = await call(ctx, 'generate', { setOf: w.WorksheetID, batchId: w.BatchID || '', subjectId: w.SubjectID, className: w.ClassName, board: w.Board, chapter: w.Chapter, difficulty: w.Difficulty, totalMarks: w.TotalMarks }); }
      finally { stop('Make Set B'); }
      ctx.toast('Set B ready.'); detail(main, ctx, out.worksheet.WorksheetID, info, out.worksheet);
    });
    on('#ws-quiz', async function () {
      var b = main.querySelector('#ws-quiz');
      var n = prompt('How many MCQs? (10, 15 or 20)', '10'); if (n === null) return;
      n = [10, 15, 20].indexOf(Number(n)) >= 0 ? Number(n) : 10;
      var stop = ticking(b, 'AI is writing the quiz');
      try { var out = await call(ctx, 'quiz', { id: w.WorksheetID, count: n }); } finally { stop('Quick quiz (MCQ)'); }
      ctx.toast('Quiz ready. Check it before using.'); detail(main, ctx, out.worksheet.WorksheetID, info, out.worksheet);
    });
    var check = main.querySelector('#ws-check');
    if (check) check.addEventListener('click', function () { checkCopy(ctx, w); });
    on('#ws-del', async function () { if (!confirm('Delete this worksheet? Homework already sent will show “worksheet deleted”.')) return; await call(ctx, 'delete', { id: w.WorksheetID }); ctx.toast('Deleted.'); view(main, ctx); });
    var assign = main.querySelector('#ws-assign');
    if (assign) assign.addEventListener('click', async function () {
      var ctxInfo = info || await call(ctx, 'context');
      var batches = ctxInfo.batches.filter(function (b) { return (b.Subjects || []).some(function (s) { return s.id === w.SubjectID; }); });
      if (!batches.length) { ctx.toast('You do not teach this subject in any batch.', true); return; }
      var d = new Date(Date.now() + 3 * 86400000); d.setHours(20, 0, 0, 0);
      var local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      ctx.openDlg('Send as homework', '<form class="ws-form"><label><span>Batch</span><select name="batchId">' + batches.map(function (b) { return opt(esc, b.BatchID, b.BatchName, b.BatchID === w.BatchID); }).join('') + '</select></label>' +
        '<label><span>Due date and time</span><input name="dueAt" type="datetime-local" value="' + local + '"></label>' +
        '<p class="muted" style="font-size:.86rem">Students see the questions in Homework. The answer key opens for them automatically after this time.</p></form>',
        '<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="button" id="ws-send">Send</button>', function (dlg) {
          dlg.querySelector('#ws-send').addEventListener('click', function (ev) {
            ctx.busy(ev.target, async function () {
              var due = dlg.querySelector('[name=dueAt]').value;
              if (!due) throw { error: 'Choose the due date and time.' };
              await call(ctx, 'assign', { id: w.WorksheetID, batchId: dlg.querySelector('[name=batchId]').value, dueAt: new Date(due).toISOString() });
              ctx.closeDlg(); ctx.toast('Sent as homework.'); detail(main, ctx, w.WorksheetID, info);
            });
          });
        });
    });
  }

  /* ---------- T3: check a student's copy with AI (photos are never stored) ---------- */
  // Shrinks a photo to at most 1600 px and optionally whites out the top strip of the
  // first page, where the student's name and roll number are usually written.
  function shrinkPhoto(file, coverTop) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var scale = Math.min(1, 1600 / Math.max(img.width, img.height)), cv = document.createElement('canvas');
        cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
        var g = cv.getContext('2d'); g.drawImage(img, 0, 0, cv.width, cv.height);
        if (coverTop) { g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, Math.round(cv.height * 0.12)); }
        URL.revokeObjectURL(url);
        resolve({ mime: 'image/jpeg', data: cv.toDataURL('image/jpeg', 0.72).split(',')[1], preview: cv.toDataURL('image/jpeg', 0.4) });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject({ error: 'Could not read “' + file.name + '”. Use JPG or PNG photos.' }); };
      img.src = url;
    });
  }
  function checkCopy(ctx, w) {
    var esc = ctx.esc;
    ctx.openDlg('Check a copy with AI',
      '<form class="ws-form" id="cc-form"><p class="muted" style="margin-top:0">Photograph the student’s answer sheet for <b>' + esc(w.Title) + '</b>. The AI suggests marks for each question using the answer key — <b>you decide the final marks</b>.</p>' +
      '<label><span>Photos of the answer sheet (up to 6 pages)</span><input type="file" name="photos" accept="image/*" multiple></label>' +
      '<label style="display:flex;gap:.5rem;align-items:flex-start"><input type="checkbox" name="cover" checked style="width:auto;margin-top:.25rem"><span style="font-weight:400">Hide the top of the first page (where the name and roll number are written) before sending</span></label>' +
      '<div id="cc-prev" style="display:flex;gap:.4rem;flex-wrap:wrap"></div>' +
      '<label><span>Or type the answers (optional)</span><textarea name="typed" rows="3" maxlength="8000" placeholder="1(a) 25&#10;1(b) x = 3"></textarea></label>' +
      '<p class="muted" style="font-size:.84rem;margin:0">🔒 Photos go to the free AI once and are not saved anywhere. Don’t include pages with the student’s name or other details.</p></form>' +
      '<div id="cc-out"></div>',
      '<button class="btn" type="button" data-close>Close</button><button class="btn primary" type="button" id="cc-go">Check with AI</button>', function (d) {
        var f = d.querySelector('#cc-form'), out = d.querySelector('#cc-out'), go = d.querySelector('#cc-go'), shots = [];
        var prep = async function () {
          var files = Array.prototype.slice.call(f.elements.photos.files || [], 0, 6);
          shots = [];
          for (var i = 0; i < files.length; i++) shots.push(await shrinkPhoto(files[i], i === 0 && f.elements.cover.checked));
          d.querySelector('#cc-prev').innerHTML = shots.map(function (s, i) { return '<img alt="Page ' + (i + 1) + '" src="' + s.preview + '" style="height:90px;border:1px solid var(--line,#ccd);border-radius:6px">'; }).join('');
        };
        f.elements.photos.addEventListener('change', function () { prep().catch(function (e) { ctx.toast(e.error || 'Could not read the photos.', true); }); });
        f.elements.cover.addEventListener('change', function () { prep().catch(function () {}); });
        go.addEventListener('click', function () {
          ctx.busy(go, async function () {
            var typed = f.elements.typed.value.trim();
            if (!shots.length && !typed) throw { error: 'Add photos of the answer sheet, or type the answers.' };
            var stop = ticking(go, 'AI is checking');
            try { var r = (await call(ctx, 'checkCopy', { id: w.WorksheetID, typed: typed, photos: shots.map(function (s) { return { mime: s.mime, data: s.data }; }) })).check; }
            finally { stop('Check again'); }
            var total = function () { return Array.prototype.reduce.call(out.querySelectorAll('[data-mark]'), function (v, i) { return v + (Number(i.value) || 0); }, 0); };
            out.innerHTML = '<h3 style="margin:1rem 0 .4rem">Suggested marks: <span id="cc-total">' + r.Total + '</span> / ' + esc(r.OutOf) + '</h3>' +
              '<div class="tablewrap"><table class="stack"><thead><tr><th>Q</th><th>Marks</th><th>Out of</th><th>Why</th></tr></thead><tbody>' +
              r.Rows.map(function (x) { return '<tr><td data-l="Q"><b>' + esc(x.Q) + '</b></td><td data-l="Marks"><input data-mark type="number" min="0" max="' + esc(x.Max) + '" step="0.5" value="' + esc(x.Awarded) + '" style="width:5rem"></td><td data-l="Out of">' + esc(x.Max) + '</td><td data-l="Why">' + esc(x.Comment) + '</td></tr>'; }).join('') +
              '</tbody></table></div>' + (r.Feedback ? '<p><b>Feedback:</b> ' + esc(r.Feedback) + '</p>' : '') + (r.Unclear ? '<p class="muted"><b>Could not read clearly:</b> ' + esc(r.Unclear) + '</p>' : '') +
              '<button class="btn small" type="button" id="cc-copy">Copy marks as text</button>' +
              '<p class="muted" style="font-size:.84rem">These are suggestions. Change any mark above; the total updates. AI can misread handwriting — check before telling the student.</p>';
            Array.prototype.forEach.call(out.querySelectorAll('[data-mark]'), function (i) { i.addEventListener('input', function () { out.querySelector('#cc-total').textContent = total(); }); });
            out.querySelector('#cc-copy').addEventListener('click', function () {
              var marks = out.querySelectorAll('[data-mark]');
              var text = w.Title + '\nMarks: ' + total() + ' / ' + r.OutOf + '\n' + r.Rows.map(function (x, i) { return x.Q + ': ' + marks[i].value + '/' + x.Max + (x.Comment ? ' — ' + x.Comment : ''); }).join('\n') + (r.Feedback ? '\n\n' + r.Feedback : '');
              (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { ctx.toast('Copied.'); }, function () { ctx.toast('Copy did not work.', true); });
            });
            out.scrollIntoView({ behavior: 'smooth', block: 'start' });
          });
        });
      });
  }

  /* ---------- students ---------- */
  async function studentOpen(ctx, homeworkId) {
    var esc = ctx.esc;
    var w = await call(ctx, 'studentView', { homeworkId: homeworkId });
    var sheet = { Title: w.Title, ClassName: '', Board: '', SubjectName: '', Chapter: '', TotalMarks: w.TotalMarks, DurationMin: w.DurationMin, Questions: w.Questions, AnswerKey: w.AnswerKey };
    ctx.openDlg(w.Title, '<p class="muted" style="margin-top:0">Full Marks: ' + esc(w.TotalMarks) + ' · Time: ' + esc(w.DurationMin) + ' min</p>' +
      '<div style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:1rem;line-height:1.55">' + esc(w.Questions) + '</div>' +
      (w.AnswerKey ? '<h3 style="margin-top:1.2rem">Answer key</h3><div style="white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.55">' + esc(w.AnswerKey) + '</div>'
        : '<p class="muted" style="margin-top:1rem">The answer key opens after ' + esc(new Date(w.AnswerKeyOpensAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })) + '.</p>'),
      '<button class="btn" type="button" id="ws-stu-print">Print</button><button class="btn primary" type="button" data-close>Close</button>', function (d) {
        d.querySelector('#ws-stu-print').addEventListener('click', function () { printSheet(ctx, sheet, !!w.AnswerKey); });
      });
  }
  async function studentKeys(el, ctx) {
    if (!el) return;
    var esc = ctx.esc;
    try {
      var out = await call(ctx, 'studentKeys');
      if (!out.rows.length) { el.innerHTML = ''; return; }
      el.innerHTML = '<div class="card"><h2 style="font-size:1.15rem;margin-bottom:.4rem">Worksheet answer keys</h2><p class="muted" style="margin-top:0">Check your answers for worksheets whose deadline has passed.</p>' +
        out.rows.map(function (r) { return '<div style="padding:.55rem 0;border-top:1px solid var(--line)"><button type="button" class="link" data-ws-key="' + esc(r.HomeworkID) + '"><b>' + esc(r.Title) + '</b></button><div class="muted" style="font-size:.85rem">' + esc(r.SubjectName) + ' · due ' + esc(when(r.DueAt)) + '</div></div>'; }).join('') + '</div>';
      Array.prototype.forEach.call(el.querySelectorAll('[data-ws-key]'), function (b) { b.addEventListener('click', function () { ctx.busy(b, function () { return studentOpen(ctx, b.getAttribute('data-ws-key')); }); }); });
    } catch (e) { el.innerHTML = ''; }
  }

  window.CMZWorksheets = { view: view, studentOpen: studentOpen, studentKeys: studentKeys };
})();
