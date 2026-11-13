/* Creative Math Zone — Doubt portal (shared by student, teacher and admin portals).
   Usage: CMZDoubts.view(main, ctx) where ctx = { api, esc, toast, busy, openDlg, closeDlg, fmtTime, role, token }
   role is 'STUDENT', 'TEACHER' or 'ADMIN'. */
(function () {
  'use strict';
  var STYLE = '.dz-tabs{display:flex;gap:.4rem;flex-wrap:wrap;margin:0 0 1rem}' +
    '.dz-tabs button{border:1px solid var(--line,#d9dee7);background:transparent;border-radius:999px;padding:.45rem .9rem;font:inherit;cursor:pointer;color:inherit}' +
    '.dz-tabs button[aria-selected=true]{background:var(--ink,#16243b);color:#fff;border-color:var(--ink,#16243b)}' +
    '.dz-filters{display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:1rem}.dz-filters select,.dz-filters input{padding:.5rem .6rem;border:1px solid var(--line,#d9dee7);border-radius:8px;font:inherit;min-width:0;max-width:100%;background:var(--paper,#fff);color:inherit}' +
    '.dz-filters input{flex:1 1 180px}' +
    '.dz-item{display:block;width:100%;text-align:left;font:inherit;color:inherit;cursor:pointer;margin-bottom:.7rem}' +
    '.dz-item:hover{border-color:var(--pencil,#f3b11c)}' +
    '.dz-meta{font-size:.86rem;opacity:.75;margin-top:.25rem}' +
    '.dz-counts{display:flex;gap:.9rem;flex-wrap:wrap;font-size:.86rem;margin-top:.5rem;opacity:.85}' +
    '.dz-photos{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.7rem}' +
    '.dz-photos .dz-ph{width:120px;height:120px;border-radius:8px;border:1px solid var(--line,#d9dee7);display:grid;place-items:center;font-size:.8rem;overflow:hidden;background:rgba(0,0,0,.03);cursor:zoom-in;padding:0}' +
    '.dz-photos img{width:100%;height:100%;object-fit:cover}' +
    '.dz-ans{border-top:1px solid var(--line,#d9dee7);padding:.9rem 0}' +
    '.dz-ans.teacher{border-left:4px solid #1f8a4c;padding-left:.8rem}' +
    '.dz-ans.pending{border-left:4px solid var(--pencil,#f3b11c);padding-left:.8rem}' +
    '.dz-body{white-space:pre-wrap;margin-top:.4rem;overflow-wrap:anywhere}' +
    '.dz-actions{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.8rem}' +
    '.dz-badge{display:inline-block;font-size:.78rem;font-weight:600;padding:.12rem .5rem;border-radius:999px;background:#e5f4ea;color:#1f6b3d;margin-left:.3rem}' +
    '.dz-full{max-width:100%;max-height:75vh;display:block;margin:auto}' +
    '.dz-form textarea,.dz-form input,.dz-form select{width:100%;box-sizing:border-box;padding:.6rem;border:1px solid var(--line,#d9dee7);border-radius:8px;font:inherit;background:var(--paper,#fff);color:inherit}' +
    '.dz-form label{display:block;margin-bottom:.8rem}.dz-form label>span{display:block;font-weight:600;margin-bottom:.3rem}' +
    '.dz-similar{font-size:.88rem;margin:-.3rem 0 .8rem}' +
    '.dz-lb td,.dz-lb th{padding:.45rem .5rem;text-align:left}.dz-lb tr.me{background:rgba(243,177,28,.15)}';
  function addStyle() {
    if (document.getElementById('dz-style')) return;
    var s = document.createElement('style'); s.id = 'dz-style'; s.textContent = STYLE; document.head.appendChild(s);
  }
  function fmtWhen(v) {
    var d = new Date(v);
    return isNaN(d.getTime()) ? '' : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  var STATUS = { OPEN: ['Open', 'warn'], CLAIMED: ['Teacher working', 'warn'], ANSWERED: ['Answered', 'ok'], RESOLVED: ['Solved ✓', 'ok'] };
  function statusPill(esc, s, hidden) {
    var v = STATUS[s] || [s, ''];
    return '<span class="pill ' + v[1] + '">' + esc(v[0]) + '</span>' + (hidden ? ' <span class="pill bad">Hidden</span>' : '');
  }
  function fnUrl() { var c = window.CMZ_CONFIG || {}; return String(c.supabaseUrl || '').replace(/\/$/, '') + '/functions/v1/doubt-files'; }
  function headers(ctx, json) {
    var c = window.CMZ_CONFIG || {}, h = { apikey: c.supabasePublishableKey, Authorization: 'Bearer ' + ctx.token() };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  /* Shrink a phone photo to a small JPEG in the browser before upload (saves storage and data). */
  function compress(file) {
    return new Promise(function (resolve, reject) {
      if (!/^image\//.test(file.type || '')) { reject({ error: 'Only photos (JPG, PNG, WebP) can be added.' }); return; }
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var max = 1600, w = img.naturalWidth, h = img.naturalHeight, scale = Math.min(1, max / Math.max(w, h));
        var tries = [0.78, 0.65, 0.5], i = 0;
        (function attempt() {
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(w * scale)); canvas.height = Math.max(1, Math.round(h * scale));
          var g = canvas.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
          g.drawImage(img, 0, 0, canvas.width, canvas.height);
          var data = canvas.toDataURL('image/jpeg', tries[i]), b64 = data.slice(data.indexOf(',') + 1), size = Math.floor(b64.length * 3 / 4);
          if (size > 900 * 1024 && i < tries.length - 1) { i++; attempt(); return; }
          if (size > 900 * 1024 && scale > 0.4) { scale *= 0.75; attempt(); return; }
          resolve({ mime: 'image/jpeg', data: b64, size: size });
        })();
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject({ error: 'This photo could not be read. Try a JPG or PNG.' }); };
      img.src = url;
    });
  }
  async function uploadPhotos(ctx, doubtId, answerId, files) {
    var list = Array.prototype.slice.call(files || []), temp = 0;
    for (var k = 0; k < list.length; k++) {
      var p = await compress(list[k]);
      var res = await fetch(fnUrl(), { method: 'POST', headers: headers(ctx, true),
        body: JSON.stringify({ action: 'upload', doubtId: doubtId, answerId: answerId || '', mimeType: p.mime, data: p.data }) });
      var out = await res.json().catch(function () { return {}; });
      if (!res.ok) throw { error: out.error || 'A photo could not be uploaded.' };
      if (out.savedTo === 'temporary') temp++;
    }
    return temp;
  }
  var blobCache = {};
  async function photoUrl(ctx, fileId) {
    if (blobCache[fileId]) return blobCache[fileId];
    var res = await fetch(fnUrl() + '?file=' + encodeURIComponent(fileId), { headers: headers(ctx, false) });
    if (!res.ok) { var e = await res.json().catch(function () { return {}; }); throw { error: e.error || 'Could not load photo.' }; }
    blobCache[fileId] = URL.createObjectURL(await res.blob());
    return blobCache[fileId];
  }
  function photosHtml(esc, files) {
    if (!files || !files.length) return '';
    return '<div class="dz-photos">' + files.map(function (f) {
      return f.Expired ? '<div class="dz-ph">Photo removed</div>'
        : '<button type="button" class="dz-ph" data-dz-photo="' + esc(f.FileID) + '">Loading…</button>';
    }).join('') + '</div>';
  }
  function loadPhotos(ctx, root) {
    Array.prototype.forEach.call(root.querySelectorAll('[data-dz-photo]'), function (b) {
      photoUrl(ctx, b.getAttribute('data-dz-photo')).then(function (u) {
        b.innerHTML = '<img alt="Doubt photo" src="' + u + '">';
        b.addEventListener('click', function () { ctx.openDlg('Photo', '<img class="dz-full" alt="Doubt photo" src="' + u + '">', ''); });
      }).catch(function (e) { b.textContent = (e && e.error) || 'Unavailable'; b.style.cursor = 'default'; });
    });
  }
  function photoInput(label) {
    return '<label><span>' + label + '</span><input name="photos" type="file" accept="image/*" multiple>' +
      '<small class="muted">Up to 3 photos. They are made smaller automatically before upload.</small></label>';
  }
  function checkPhotos(input) {
    var n = input && input.files ? input.files.length : 0;
    if (n > 3) throw { error: 'Choose up to 3 photos.' };
    return n;
  }

  /* ---------------- list ---------------- */
  var state = { tab: null, subjectId: '', status: '', search: '' };
  function tabsFor(role) {
    if (role === 'STUDENT') return [['feed', 'Class doubts'], ['mine', 'My doubts'], ['top', 'Top helpers']];
    if (role === 'TEACHER') return [['feed', 'My subjects'], ['pending', 'Needs approval'], ['all', 'All doubts'], ['top', 'Top helpers']];
    return [['all', 'All doubts'], ['stats', 'Teacher stats'], ['top', 'Top helpers']];
  }
  async function view(main, ctx) {
    addStyle();
    var esc = ctx.esc, tabs = tabsFor(ctx.role);
    if (!state.tab || !tabs.some(function (t) { return t[0] === state.tab; })) state.tab = tabs[0][0];
    var intro = ctx.role === 'STUDENT' ? 'Ask your doubts, help classmates, and earn points when a teacher approves your answer.'
      : ctx.role === 'TEACHER' ? 'Solve doubts from your subjects and approve good answers from students.' : 'All doubts across the centre.';
    main.innerHTML = '<div class="head"><div><h1>Doubts</h1><p>' + esc(intro) + '</p></div>' +
      (ctx.role === 'STUDENT' ? '<button class="btn primary" id="dz-ask" type="button">Ask a doubt</button>' : '') + '</div>' +
      '<div class="dz-tabs" role="tablist">' + tabs.map(function (t) {
        return '<button type="button" role="tab" data-dz-tab="' + t[0] + '" aria-selected="' + (t[0] === state.tab) + '">' + esc(t[1]) + '</button>';
      }).join('') + '</div><div id="dz-body"><div class="cmz-loader"><i></i></div></div>';
    Array.prototype.forEach.call(main.querySelectorAll('[data-dz-tab]'), function (b) {
      b.addEventListener('click', function () { state.tab = b.getAttribute('data-dz-tab'); view(main, ctx).catch(function (e) { ctx.toast(e.error || 'Could not load.', true); }); });
    });
    var body = main.querySelector('#dz-body');
    if (state.tab === 'top') return leaderboard(body, ctx);
    if (state.tab === 'stats') return stats(body, ctx);
    var data = await ctx.api('doubts.list', { scope: state.tab, subjectId: state.subjectId, status: state.status, search: state.search });
    var ask = main.querySelector('#dz-ask');
    if (ask) {
      if (!data.canAsk) ask.disabled = true;
      ask.addEventListener('click', function () { askDialog(main, ctx, data.subjects); });
    }
    body.innerHTML = '<div class="dz-filters"><select id="dz-subject" aria-label="Subject"><option value="">All subjects</option>' +
      data.subjects.map(function (s) { return '<option value="' + esc(s.id) + '"' + (s.id === state.subjectId ? ' selected' : '') + '>' + esc(s.name) + '</option>'; }).join('') +
      '</select><select id="dz-status" aria-label="Status"><option value="">Any status</option>' +
      ['OPEN', 'CLAIMED', 'ANSWERED', 'RESOLVED'].map(function (s) { return '<option value="' + s + '"' + (s === state.status ? ' selected' : '') + '>' + STATUS[s][0] + '</option>'; }).join('') +
      '</select><input id="dz-search" type="search" placeholder="Search title or chapter" value="' + esc(state.search) + '"></div>' +
      (data.rows.length ? data.rows.map(function (d) {
        return '<button type="button" class="card dz-item" data-dz-open="' + esc(d.DoubtID) + '">' +
          '<div style="display:flex;justify-content:space-between;gap:.6rem;flex-wrap:wrap;align-items:flex-start"><b>' + esc(d.Title) + '</b><span>' + statusPill(esc, d.Status, d.Hidden) + '</span></div>' +
          '<div class="dz-meta">' + esc(d.SubjectName) + (d.Chapter ? ' · ' + esc(d.Chapter) : '') + ' · Class ' + esc(d.ClassName) + ' · ' + (d.IsMine ? 'You' : esc(d.StudentName)) + ' · ' + esc(fmtWhen(d.CreatedAt)) + '</div>' +
          '<div class="dz-counts"><span>💬 ' + d.Answers + ' answer' + (d.Answers === 1 ? '' : 's') + '</span><span>🙋 ' + d.MeToo + ' me too</span>' +
          (d.Photos ? '<span>📷 ' + d.Photos + '</span>' : '') + (d.Pending ? '<span><b>⏳ ' + d.Pending + ' to approve</b></span>' : '') +
          (d.ClaimedBy ? '<span>👩‍🏫 ' + esc(d.ClaimedBy) + '</span>' : '') + '</div></button>';
      }).join('') : '<div class="card empty"><b>No doubts here yet</b>' +
        (ctx.role === 'STUDENT' && state.tab === 'mine' ? 'Tap “Ask a doubt” to post your first one.' : 'New doubts will appear here.') + '</div>');
    var reload = function () { view(main, ctx).catch(function (e) { ctx.toast(e.error || 'Could not load.', true); }); };
    body.querySelector('#dz-subject').addEventListener('change', function (e) { state.subjectId = e.target.value; reload(); });
    body.querySelector('#dz-status').addEventListener('change', function (e) { state.status = e.target.value; reload(); });
    var t; body.querySelector('#dz-search').addEventListener('input', function (e) { clearTimeout(t); t = setTimeout(function () { state.search = e.target.value; reload(); }, 400); });
    Array.prototype.forEach.call(body.querySelectorAll('[data-dz-open]'), function (b) {
      b.addEventListener('click', function () { detail(main, ctx, b.getAttribute('data-dz-open')).catch(function (e) { ctx.toast(e.error || 'Could not open.', true); }); });
    });
  }

  function askDialog(main, ctx, subjects) {
    var esc = ctx.esc;
    ctx.openDlg('Ask a doubt',
      '<form class="dz-form" id="dz-ask-form">' +
      '<label><span>Subject</span><select name="subjectId" required><option value="">Choose…</option>' + subjects.map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>'; }).join('') + '</select></label>' +
      '<label><span>Chapter / topic (optional)</span><input name="chapter" maxlength="120" placeholder="e.g. Trigonometry"></label>' +
      '<label><span>Your question in one line</span><input name="title" maxlength="200" required placeholder="e.g. How to find sin 75° without a calculator?"></label>' +
      '<div class="dz-similar" id="dz-similar"></div>' +
      '<label><span>Details (optional)</span><textarea name="body" rows="4" maxlength="4000" placeholder="What did you try? Where are you stuck?"></textarea></label>' +
      photoInput('Photos of the question (optional)') + '</form>',
      '<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" id="dz-post" type="button">Post doubt</button>',
      function (d) {
        var form = d.querySelector('#dz-ask-form'), timer;
        var findSimilar = function () {
          var words = String(form.elements.title.value || '').split(/\s+/).filter(function (w) { return w.length > 3; }).sort(function (a, b) { return b.length - a.length; });
          var box = d.querySelector('#dz-similar');
          if (!words.length) { box.innerHTML = ''; return; }
          ctx.api('doubts.list', { scope: 'feed', subjectId: form.elements.subjectId.value, search: words[0] }).then(function (r) {
            var hits = r.rows.slice(0, 3);
            box.innerHTML = hits.length ? '<b>Similar doubts already asked:</b><ul style="margin:.3rem 0 0 1rem;padding:0">' + hits.map(function (h) {
              return '<li><button type="button" class="link" data-dz-sim="' + esc(h.DoubtID) + '">' + esc(h.Title) + '</button> · ' + esc((STATUS[h.Status] || [h.Status])[0]) + '</li>';
            }).join('') + '</ul>' : '';
            Array.prototype.forEach.call(box.querySelectorAll('[data-dz-sim]'), function (b) {
              b.addEventListener('click', function () { ctx.closeDlg(); detail(main, ctx, b.getAttribute('data-dz-sim')); });
            });
          }).catch(function () {});
        };
        form.elements.title.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(findSimilar, 500); });
        form.elements.subjectId.addEventListener('change', findSimilar);
        d.querySelector('#dz-post').addEventListener('click', function (ev) {
          ctx.busy(ev.target, async function () {
            if (!form.elements.subjectId.value) throw { error: 'Choose a subject.' };
            if (String(form.elements.title.value).trim().length < 3) throw { error: 'Write your question in one line.' };
            var n = checkPhotos(form.elements.photos);
            var r = await ctx.api('doubts.create', { subjectId: form.elements.subjectId.value, chapter: form.elements.chapter.value,
              title: form.elements.title.value, body: form.elements.body.value });
            var temp = 0;
            if (n) { ev.target.textContent = 'Uploading photos…'; temp = await uploadPhotos(ctx, r.DoubtID, '', form.elements.photos.files); }
            ctx.closeDlg(); ctx.toast('Doubt posted.' + (temp ? ' Photos will move to Google Drive shortly.' : ''));
            state.tab = 'mine'; detail(main, ctx, r.DoubtID);
          });
        });
      });
  }

  /* ---------------- detail ---------------- */
  async function detail(main, ctx, doubtId) {
    addStyle();
    var esc = ctx.esc;
    main.innerHTML = '<div class="cmz-loader"><i></i></div>';
    var r = await ctx.api('doubts.get', { doubtId: doubtId }), d = r.doubt, can = r.can;
    var when = function (v) { return esc(fmtWhen(v)); };
    var answersHtml = r.answers.length ? r.answers.map(function (a) {
      var cls = a.Status === 'PENDING' ? 'pending' : (a.AuthorType === 'TEACHER' ? 'teacher' : '');
      var who = a.FollowUp ? esc(a.AuthorName) + ' (asked this doubt)' : esc(a.AuthorName) + (a.AuthorType === 'TEACHER' ? ' · Teacher' : '');
      var badge = a.AuthorType === 'STUDENT' && !a.FollowUp && a.Status === 'APPROVED' ? '<span class="dz-badge">✓ Verified by ' + esc(a.ReviewedBy || 'teacher') + (a.Points ? ' · +' + a.Points + ' pts' : '') + '</span>' : '';
      var state2 = a.Status === 'PENDING' ? ' <span class="pill warn">Waiting for teacher approval</span>'
        : a.Status === 'REJECTED' ? ' <span class="pill bad">Not approved</span>' : a.Status === 'HIDDEN' ? ' <span class="pill bad">Hidden</span>' : '';
      return '<div class="dz-ans ' + cls + '"><div><b>' + who + '</b>' + badge + state2 + '</div><div class="dz-meta">' + when(a.CreatedAt) + '</div>' +
        (a.Body ? '<div class="dz-body">' + esc(a.Body) + '</div>' : '') + photosHtml(esc, a.Files) +
        (a.Status === 'REJECTED' && a.ReviewNote ? '<div class="dz-meta" style="opacity:1"><b>Teacher note:</b> ' + esc(a.ReviewNote) + '</div>' : '') +
        '<div class="dz-actions">' +
        (can.review && a.Status === 'PENDING' ? '<button class="btn small primary" type="button" data-dz-approve="' + esc(a.AnswerID) + '">Approve</button><button class="btn small" type="button" data-dz-reject="' + esc(a.AnswerID) + '">Not correct</button>' : '') +
        (can.hide && a.Status === 'APPROVED' ? '<button class="btn small" type="button" data-dz-hide-ans="' + esc(a.AnswerID) + '">Hide</button>' : '') +
        (can.hide && a.Status === 'HIDDEN' ? '<button class="btn small" type="button" data-dz-unhide-ans="' + esc(a.AnswerID) + '">Show again</button>' : '') +
        '</div></div>';
    }).join('') : '<p class="muted">No answers yet.</p>';
    var answerLabel = d.IsMine ? 'Add more details / still confused?' : ctx.role === 'STUDENT' ? 'Know the answer? Help your classmate' : 'Your answer';
    main.innerHTML = '<p><button type="button" class="link" id="dz-back">← All doubts</button></p>' +
      '<div class="card"><div style="display:flex;justify-content:space-between;gap:.6rem;flex-wrap:wrap;align-items:flex-start"><h1 style="font-size:1.35rem;margin:0">' + esc(d.Title) + '</h1><span>' + statusPill(esc, d.Status, d.Hidden) + '</span></div>' +
      '<div class="dz-meta">' + esc(d.SubjectName) + (d.Chapter ? ' · ' + esc(d.Chapter) : '') + ' · Class ' + esc(d.ClassName) + ' · asked by ' + (d.IsMine ? 'you' : esc(d.StudentName)) + ' · ' + when(d.CreatedAt) +
      (d.ClaimedBy ? ' · ' + esc(d.ClaimedBy) + ' is solving this' : '') + '</div>' +
      (d.Body ? '<div class="dz-body">' + esc(d.Body) + '</div>' : '') + photosHtml(esc, d.Files) +
      '<div class="dz-actions">' +
      (can.meToo ? '<button class="btn small" type="button" id="dz-metoo">' + (d.MeTooMine ? '✓ I have this doubt too' : '🙋 Me too') + ' (' + d.MeToo + ')</button>' : '<span class="muted" style="align-self:center">🙋 ' + d.MeToo + ' me too</span>') +
      (can.claim ? '<button class="btn small primary" type="button" id="dz-claim">I’ll solve this</button>' : '') +
      (can.release ? '<button class="btn small" type="button" id="dz-release">Let another teacher take it</button>' : '') +
      (can.resolve && d.Status !== 'RESOLVED' && r.answers.some(function (a) { return a.Status === 'APPROVED' && !a.FollowUp; }) ? '<button class="btn small primary" type="button" id="dz-resolve">Got it — mark solved</button>' : '') +
      (can.resolve && d.Status === 'RESOLVED' ? '<button class="btn small" type="button" id="dz-reopen">Reopen</button>' : '') +
      (can.hide ? '<button class="btn small" type="button" id="dz-hide">' + (d.Hidden ? 'Show doubt again' : 'Hide doubt') + '</button>' : '') +
      '</div></div>' +
      '<section class="card"><h2 style="font-size:1.15rem;margin:0 0 .3rem">Answers</h2>' + answersHtml + '</section>' +
      aiPanelHtml(esc, r.ai, can) +
      (can.answer ? '<section class="card"><form class="dz-form" id="dz-answer"><label><span>' + esc(answerLabel) + '</span>' +
        '<textarea name="body" rows="5" maxlength="6000" placeholder="Explain step by step…"></textarea></label>' + photoInput('Photos of your working (optional)') +
        (ctx.role === 'STUDENT' && !d.IsMine ? '<p class="muted" style="margin-top:0">A teacher checks your answer before others can see it. Approved answers earn points.</p>' : '') +
        '<button class="btn primary" type="submit">Post</button></form></section>' : '');
    loadPhotos(ctx, main);
    var again = function (msg) { if (msg) ctx.toast(msg); detail(main, ctx, doubtId).catch(function (e) { ctx.toast(e.error || 'Could not load.', true); }); };
    main.querySelector('#dz-back').addEventListener('click', function () { view(main, ctx).catch(function (e) { ctx.toast(e.error || 'Could not load.', true); }); });
    var on = function (sel, fn) { var el = main.querySelector(sel); if (el) el.addEventListener('click', function (ev) { ctx.busy(ev.target, fn); }); };
    on('#dz-metoo', async function () { await ctx.api('doubts.meToo', { doubtId: doubtId }); again(); });
    on('#dz-claim', async function () { await ctx.api('doubts.claim', { doubtId: doubtId }); again('You are now solving this doubt.'); });
    on('#dz-release', async function () { await ctx.api('doubts.claim', { doubtId: doubtId, release: true }); again('Released for other teachers.'); });
    on('#dz-resolve', async function () { await ctx.api('doubts.resolve', { doubtId: doubtId, resolved: true }); again('Marked as solved. Great!'); });
    on('#dz-reopen', async function () { await ctx.api('doubts.resolve', { doubtId: doubtId, resolved: false }); again('Doubt reopened.'); });
    on('#dz-hide', async function () {
      if (!d.Hidden && !confirm('Hide this doubt from students?')) return;
      await ctx.api('doubts.hide', { doubtId: doubtId, hidden: !d.Hidden }); again(d.Hidden ? 'Doubt is visible again.' : 'Doubt hidden.');
    });
    Array.prototype.forEach.call(main.querySelectorAll('[data-dz-approve]'), function (b) {
      b.addEventListener('click', function () { ctx.busy(b, async function () { var x = await ctx.api('doubts.review', { answerId: b.getAttribute('data-dz-approve'), approve: true }); again('Answer approved' + (x.points ? ' (+' + x.points + ' points to the student).' : '.')); }); });
    });
    Array.prototype.forEach.call(main.querySelectorAll('[data-dz-reject]'), function (b) {
      b.addEventListener('click', function () {
        var note = prompt('Tell the student what is wrong (they will see this):');
        if (!note || !note.trim()) return;
        ctx.busy(b, async function () { await ctx.api('doubts.review', { answerId: b.getAttribute('data-dz-reject'), approve: false, note: note.trim() }); again('Feedback sent.'); });
      });
    });
    Array.prototype.forEach.call(main.querySelectorAll('[data-dz-hide-ans],[data-dz-unhide-ans]'), function (b) {
      b.addEventListener('click', function () {
        var hide = b.hasAttribute('data-dz-hide-ans'), id = b.getAttribute(hide ? 'data-dz-hide-ans' : 'data-dz-unhide-ans');
        ctx.busy(b, async function () { await ctx.api('doubts.hide', { answerId: id, hidden: hide }); again(hide ? 'Answer hidden.' : 'Answer visible again.'); });
      });
    });
    wireAiPanel(main, ctx, doubtId);
    var form = main.querySelector('#dz-answer');
    if (form) form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var btn = form.querySelector('button[type=submit]');
      ctx.busy(btn, async function () {
        var n = checkPhotos(form.elements.photos), text = String(form.elements.body.value || '').trim();
        if (!text && !n) throw { error: 'Write an answer or add a photo.' };
        var res = await ctx.api('doubts.answer', { doubtId: doubtId, body: text, hasPhotos: n > 0 });
        if (n) { btn.textContent = 'Uploading photos…'; await uploadPhotos(ctx, doubtId, res.AnswerID, form.elements.photos.files); }
        again(res.status === 'PENDING' ? 'Sent to the teacher for approval.' : res.followUp ? 'Added. The doubt is open again for teachers.' : 'Answer posted.');
      });
    });
  }

  /* ---------------- free AI draft (teachers only) ---------------- */
  function aiPanelHtml(esc, ai, can) {
    if (!ai || !ai.enabled) return '';
    if (!ai.configured) return '<section class="card dz-ai"><b>✨ AI draft</b><p class="muted" style="margin:.3rem 0 0">The free AI assistant is not set up yet. The Super Admin can add the key in Settings → AI assistant.</p></section>';
    var d = ai.draft;
    return '<section class="card dz-ai" id="dz-ai"><div style="display:flex;justify-content:space-between;gap:.6rem;flex-wrap:wrap;align-items:center">' +
      '<b>✨ AI draft solution</b><button class="btn small" type="button" id="dz-ai-go">' + (d ? 'Try again' : 'Get AI draft') + '</button></div>' +
      '<p class="muted" style="margin:.3rem 0 .6rem;font-size:.86rem">Only teachers see this. AI can make mistakes — check every step before posting. Only the question and its photos are sent, never the student’s name.</p>' +
      '<div id="dz-ai-body">' + (d ? aiDraftHtml(esc, d, can) : '') + '</div></section>';
  }
  function aiDraftHtml(esc, d, can) {
    return '<div class="dz-body" style="background:rgba(243,177,28,.10);border:1px dashed var(--pencil,#f3b11c);border-radius:8px;padding:.7rem">' + esc(d.Body) + '</div>' +
      '<div class="dz-meta">' + esc(fmtWhen(d.CreatedAt)) + '</div>' +
      (can.answer ? '<div class="dz-actions"><button class="btn small primary" type="button" id="dz-ai-use">Use in my answer</button></div>' : '');
  }
  function wireAiPanel(main, ctx, doubtId) {
    var box = main.querySelector('#dz-ai');
    if (!box) return;
    var current = null;
    var bindUse = function () {
      var use = main.querySelector('#dz-ai-use');
      if (use) use.addEventListener('click', function () {
        var ta = main.querySelector('#dz-answer textarea[name=body]');
        var text = current || (main.querySelector('#dz-ai-body .dz-body') || {}).textContent || '';
        if (!ta) return;
        ta.value = text; ta.focus(); ta.scrollIntoView({ behavior: 'smooth', block: 'center' });
        ctx.toast('Draft copied into your answer. Check it, edit if needed, then press Post.');
      });
    };
    bindUse();
    var go = main.querySelector('#dz-ai-go');
    if (go) go.addEventListener('click', function () {
      ctx.busy(go, async function () {
        go.textContent = 'Thinking… (up to a minute)';
        main.querySelector('#dz-ai-body').innerHTML = '<div class="cmz-loader"><i></i></div>';
        try {
          var res = await fetch(fnUrl(), { method: 'POST', headers: headers(ctx, true), body: JSON.stringify({ action: 'aiDraft', doubtId: doubtId }) });
          var out = await res.json().catch(function () { return {}; });
          if (!res.ok || !out.draft) throw { error: out.error || 'The AI could not make a draft. Try again.' };
          current = out.draft.Body;
          var canAnswer = !!main.querySelector('#dz-answer');
          main.querySelector('#dz-ai-body').innerHTML = aiDraftHtml(ctx.esc, out.draft, { answer: canAnswer });
          bindUse();
          go.textContent = 'Try again';
        } catch (e) {
          main.querySelector('#dz-ai-body').innerHTML = '<p class="muted">' + ctx.esc((e && e.error) || 'AI draft failed.') + '</p>';
          go.textContent = 'Get AI draft';
          throw e;
        }
      });
    });
  }

  /* ---------------- leaderboard & stats ---------------- */
  function monthPicker(esc, value) {
    return '<label class="dz-filters" style="align-items:center"><span>Month</span><input type="month" id="dz-month" value="' + esc(value) + '" style="flex:0 1 180px"></label>';
  }
  async function leaderboard(body, ctx, month) {
    var esc = ctx.esc, r = await ctx.api('doubts.leaderboard', { month: month || '' });
    body.innerHTML = monthPicker(esc, r.month) + '<div class="card"><h2 style="font-size:1.15rem;margin:0 0 .3rem">Top helpers · ' + esc(r.monthLabel) + '</h2>' +
      '<p class="muted" style="margin-top:0">' + (ctx.role === 'STUDENT' ? 'Students of Class ' + esc(r.className) + '. You have <b>' + r.myPoints + '</b> points this month.' : 'Points are earned when a teacher approves a student’s answer.') + '</p>' +
      (r.rows.length ? '<div class="tablewrap"><table class="dz-lb" style="width:100%;border-collapse:collapse"><thead><tr><th>#</th><th>Student</th>' + (ctx.role === 'STUDENT' ? '' : '<th>Class</th>') + '<th>Approved answers</th><th>Points</th></tr></thead><tbody>' +
        r.rows.map(function (x) {
          var medal = x.Rank === 1 ? '🥇' : x.Rank === 2 ? '🥈' : x.Rank === 3 ? '🥉' : x.Rank;
          return '<tr class="' + (x.IsMe ? 'me' : '') + '"><td>' + medal + '</td><td>' + esc(x.Name) + (x.IsMe ? ' (you)' : '') + '</td>' + (ctx.role === 'STUDENT' ? '' : '<td>' + esc(x.ClassName) + '</td>') + '<td>' + x.Answers + '</td><td><b>' + x.Points + '</b></td></tr>';
        }).join('') + '</tbody></table></div>' : '<p class="muted">No approved student answers yet this month.</p>') + '</div>';
    body.querySelector('#dz-month').addEventListener('change', function (e) { leaderboard(body, ctx, e.target.value).catch(function (x) { ctx.toast(x.error || 'Could not load.', true); }); });
  }
  async function stats(body, ctx, month) {
    var esc = ctx.esc, r = await ctx.api('doubts.stats', { month: month || '' }), t = r.totals;
    var stat = function (v, l) { return '<div class="card" style="flex:1 1 140px"><b style="font-size:1.5rem">' + esc(v) + '</b><div class="muted">' + esc(l) + '</div></div>'; };
    body.innerHTML = monthPicker(esc, r.month) +
      '<div style="display:flex;gap:.7rem;flex-wrap:wrap">' + stat(t.posted, 'Doubts posted') + stat(t.open, 'Still open') + stat(t.answered, 'Answered') + stat(t.resolved, 'Solved') +
      stat(t.avgResponseHours == null ? '—' : t.avgResponseHours + ' h', 'Avg. first reply') + '</div>' +
      '<div class="card"><h2 style="font-size:1.15rem;margin:0 0 .5rem">Teachers · ' + esc(r.monthLabel) + '</h2>' +
      (r.teachers.length ? '<div class="tablewrap"><table class="stack"><thead><tr><th>Teacher</th><th>Answers</th><th>Student answers reviewed</th><th>Avg. first reply</th></tr></thead><tbody>' +
        r.teachers.map(function (x) { return '<tr><td data-l="Teacher">' + esc(x.Name) + '</td><td data-l="Answers">' + x.Answers + '</td><td data-l="Reviewed">' + x.Reviews + '</td><td data-l="Avg. first reply">' + (x.AvgFirstResponseHours == null ? '—' : x.AvgFirstResponseHours + ' h') + '</td></tr>'; }).join('') +
        '</tbody></table></div>' : '<p class="muted">No teacher activity this month.</p>') + '</div>';
    body.querySelector('#dz-month').addEventListener('change', function (e) { stats(body, ctx, e.target.value).catch(function (x) { ctx.toast(x.error || 'Could not load.', true); }); });
  }

  window.CMZDoubts = { view: view };
})();
