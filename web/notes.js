/* Creative Math Zone — My Notes (offline step 3).
   A personal notebook per subject, kept ONLY on this phone (never sent to the server).
   Works fully offline. Photos are shrunk before saving. Backup = download a file; Restore = pick it. */
(function () {
  'use strict';
  var STYLE = '.nt-tools{display:flex;gap:.5rem;flex-wrap:wrap;margin:.2rem 0 1rem}.nt-tools input{flex:1 1 200px;min-width:0;padding:.6rem .75rem;border:1px solid var(--line,#d9dee7);border-radius:10px;font:inherit}' +
    '.nt-chips{display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:.9rem}.nt-chip{border:1px solid var(--line,#d9dee7);background:transparent;border-radius:999px;padding:.3rem .75rem;font:inherit;font-size:.86rem;cursor:pointer;color:inherit}' +
    '.nt-chip[aria-pressed=true]{background:#102447;color:#fff;border-color:#102447}.nt-card{display:block;width:100%;text-align:left;font:inherit;color:inherit;cursor:pointer}' +
    '.nt-snip{white-space:pre-wrap;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;margin:.35rem 0 0;color:var(--ink-2,#38475d)}' +
    '.nt-photos{display:flex;gap:.4rem;flex-wrap:wrap;margin:.5rem 0}.nt-photos figure{margin:0;position:relative}.nt-photos img{width:84px;height:84px;object-fit:cover;border-radius:8px;border:1px solid var(--line,#d9dee7);cursor:pointer}' +
    '.nt-photos button{position:absolute;top:-6px;right:-6px;width:24px;height:24px;border-radius:50%;border:0;background:#b42318;color:#fff;cursor:pointer;line-height:1}' +
    '.nt-text{width:100%;box-sizing:border-box;min-height:14rem;padding:.7rem;border:1px solid var(--line,#d9dee7);border-radius:10px;font:inherit;line-height:1.55}';
  function addStyle() { if (document.getElementById('nt-style')) return; var s = document.createElement('style'); s.id = 'nt-style'; s.textContent = STYLE; document.head.appendChild(s); }
  function store() { if (!window.CMZNoteStore) throw { error: 'Notes are not available in this browser.' }; return window.CMZNoteStore; }
  function when(t) { return new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      if (!/^image\//.test(file.type || '')) { reject({ error: 'Only photos can be added to notes.' }); return; }
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var scale = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * scale)); c.height = Math.max(1, Math.round(img.naturalHeight * scale));
        var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.72));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject({ error: 'Could not read that photo.' }); };
      img.src = url;
    });
  }
  var st = { subject: '', q: '' };

  async function view(main, ctx) {
    addStyle();
    var esc = ctx.esc, owner = ctx.owner();
    if (!owner) throw { error: 'Sign in to use My Notes.' };
    var notes = (await store().list(owner)).sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    var subjects = [];
    try { subjects = await ctx.subjects(); } catch (e) { /* offline with nothing saved: notes still work */ }
    var names = subjects.slice();
    notes.forEach(function (n) { if (n.subject && names.indexOf(n.subject) < 0) names.push(n.subject); });
    var q = st.q.trim().toLowerCase();
    var shown = notes.filter(function (n) { return (!st.subject || n.subject === st.subject) && (!q || (n.title + ' ' + n.text).toLowerCase().indexOf(q) >= 0); });
    main.innerHTML = '<div class="head"><div><h1>My notes</h1><p>Your own notebook — kept only on this phone, works without internet.</p></div><button class="btn primary" type="button" id="nt-new">＋ New note</button></div>' +
      '<div class="nt-tools"><input id="nt-q" type="search" placeholder="Search my notes" value="' + esc(st.q) + '"></div>' +
      '<div class="nt-chips">' + [''].concat(names).map(function (s) { return '<button type="button" class="nt-chip" data-sub="' + esc(s) + '" aria-pressed="' + (st.subject === s) + '">' + (s ? esc(s) : 'All subjects') + '</button>'; }).join('') + '</div>' +
      (shown.length ? shown.map(function (n) {
        return '<button type="button" class="card nt-card" data-note="' + n.id + '"><div style="display:flex;justify-content:space-between;gap:.6rem;flex-wrap:wrap"><b>' + esc(n.title || 'Untitled note') + '</b>' +
          '<span class="pill">' + esc(n.subject || 'General') + '</span></div><div class="muted" style="font-size:.82rem">' + esc(when(n.updatedAt)) + ((n.photos || []).length ? ' · 📷 ' + n.photos.length : '') + '</div>' +
          (n.text ? '<p class="nt-snip">' + esc(n.text) + '</p>' : '') + '</button>';
      }).join('') : '<div class="card empty"><b>' + (notes.length ? 'No notes match' : 'No notes yet') + '</b>' + (notes.length ? 'Try another subject or search.' : 'Tap “New note” to write class notes, formulas or a photo of the board.') + '</div>') +
      '<section class="card" style="margin-top:1rem"><h2 style="font-size:1.05rem;margin:0 0 .3rem">Keep your notes safe</h2>' +
      '<p class="muted" style="margin:0 0 .6rem;font-size:.88rem">Notes are stored only on this phone (' + notes.length + ' note' + (notes.length === 1 ? '' : 's') + '). Download a backup file now and then — if you change or reset your phone, use Restore to bring them back.</p>' +
      '<div style="display:flex;gap:.5rem;flex-wrap:wrap"><button class="btn" type="button" id="nt-backup">⬇ Download backup</button><button class="btn" type="button" id="nt-restore">⬆ Restore from backup</button>' +
      (notes.length ? '<button class="btn danger" type="button" id="nt-wipe">Delete all my notes</button>' : '') + '<input type="file" id="nt-file" accept=".json,application/json" hidden></div></section>';
    var reload = function () { view(main, ctx).catch(function (e) { ctx.toast(e.error || 'Could not load notes.', true); }); };
    main.querySelector('#nt-new').addEventListener('click', function () { edit(ctx, owner, null, names, reload); });
    var t; main.querySelector('#nt-q').addEventListener('input', function (e) { clearTimeout(t); t = setTimeout(function () { st.q = e.target.value; reload(); }, 250); });
    Array.prototype.forEach.call(main.querySelectorAll('[data-sub]'), function (b) { b.addEventListener('click', function () { st.subject = b.getAttribute('data-sub'); reload(); }); });
    Array.prototype.forEach.call(main.querySelectorAll('[data-note]'), function (b) {
      b.addEventListener('click', function () { var n = notes.filter(function (x) { return String(x.id) === b.getAttribute('data-note'); })[0]; edit(ctx, owner, n, names, reload); });
    });
    main.querySelector('#nt-backup').addEventListener('click', function () { backup(ctx, notes); });
    var file = main.querySelector('#nt-file');
    main.querySelector('#nt-restore').addEventListener('click', function () { file.click(); });
    file.addEventListener('change', function () { if (file.files[0]) restore(ctx, owner, file.files[0]).then(reload); });
    var wipe = main.querySelector('#nt-wipe');
    if (wipe) wipe.addEventListener('click', async function () {
      if (!confirm('Delete all ' + notes.length + ' notes from this phone? Download a backup first if you may need them. This cannot be undone.')) return;
      await store().clearOwner(owner); ctx.toast('All notes deleted from this phone.'); reload();
    });
  }

  function edit(ctx, owner, note, names, done) {
    var esc = ctx.esc, n = note ? JSON.parse(JSON.stringify(note)) : { owner: owner, subject: st.subject || '', title: '', text: '', photos: [], createdAt: Date.now() };
    var opts = ['<option value="">General</option>'].concat(names.map(function (s) { return '<option value="' + esc(s) + '"' + (n.subject === s ? ' selected' : '') + '>' + esc(s) + '</option>'; })).join('');
    ctx.openDlg(note ? 'Edit note' : 'New note',
      '<form id="nt-f"><label class="f"><span>Subject</span><select name="subject">' + opts + '</select></label>' +
      '<label class="f"><span>Title</span><input name="title" maxlength="120" placeholder="e.g. Quadratic formula" value="' + esc(n.title) + '"></label>' +
      '<label class="f"><span>Note</span><textarea name="text" class="nt-text" maxlength="20000" placeholder="Write anything: class notes, formulas, doubts to ask…">' + esc(n.text) + '</textarea></label>' +
      '<div class="nt-photos" id="nt-ph"></div><label class="f"><span>Add photos (up to 6)</span><input type="file" name="photos" accept="image/*" multiple></label></form>',
      (note ? '<button class="btn danger" type="button" id="nt-del">Delete</button>' : '') + '<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="button" id="nt-save">Save</button>',
      function (d) {
        var f = d.querySelector('#nt-f');
        var drawPhotos = function () {
          d.querySelector('#nt-ph').innerHTML = n.photos.map(function (p, i) { return '<figure><img src="' + p + '" alt="Photo ' + (i + 1) + '" data-big="' + i + '"><button type="button" aria-label="Remove photo" data-rm="' + i + '">✕</button></figure>'; }).join('');
          Array.prototype.forEach.call(d.querySelectorAll('[data-rm]'), function (b) { b.addEventListener('click', function () { n.photos.splice(+b.getAttribute('data-rm'), 1); drawPhotos(); }); });
          Array.prototype.forEach.call(d.querySelectorAll('[data-big]'), function (im) { im.addEventListener('click', function () { var w = window.open(); if (w) w.document.write('<img src="' + n.photos[+im.getAttribute('data-big')] + '" style="max-width:100%">'); }); });
        };
        drawPhotos();
        f.elements.photos.addEventListener('change', async function () {
          var files = Array.prototype.slice.call(f.elements.photos.files || []);
          for (var i = 0; i < files.length && n.photos.length < 6; i++) { try { n.photos.push(await shrink(files[i])); } catch (e) { ctx.toast(e.error, true); } }
          if (files.length && n.photos.length >= 6) ctx.toast('A note can have up to 6 photos.');
          f.elements.photos.value = ''; drawPhotos();
        });
        d.querySelector('#nt-save').addEventListener('click', async function () {
          n.subject = f.elements.subject.value; n.title = f.elements.title.value.trim(); n.text = f.elements.text.value;
          if (!n.title && !n.text.trim() && !n.photos.length) { ctx.toast('Write something or add a photo first.', true); return; }
          n.updatedAt = Date.now();
          try { await store().save(n); } catch (e) { ctx.toast('Could not save — the phone may be out of space.', true); return; }
          ctx.closeDlg(); ctx.toast('Note saved on this phone.'); done();
        });
        var del = d.querySelector('#nt-del');
        if (del) del.addEventListener('click', async function () { if (!confirm('Delete this note?')) return; await store().remove(n.id); ctx.closeDlg(); ctx.toast('Note deleted.'); done(); });
      });
  }

  function backup(ctx, notes) {
    if (!notes.length) { ctx.toast('There are no notes to back up yet.'); return; }
    var data = { format: 'cmz-notes-v1', exportedAt: new Date().toISOString(), notes: notes.map(function (n) { return { subject: n.subject, title: n.title, text: n.text, photos: n.photos || [], createdAt: n.createdAt, updatedAt: n.updatedAt }; }) };
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    a.download = 'my-notes-' + new Date().toISOString().slice(0, 10) + '.json'; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 30000);
    ctx.toast('Backup downloaded. Keep it in Google Drive or send it to yourself.');
  }
  async function restore(ctx, owner, file) {
    var data;
    try { data = JSON.parse(await file.text()); } catch (e) { ctx.toast('That is not a notes backup file.', true); return; }
    if (!data || data.format !== 'cmz-notes-v1' || !Array.isArray(data.notes)) { ctx.toast('That is not a notes backup file.', true); return; }
    var have = await store().list(owner), seen = {};
    have.forEach(function (n) { seen[n.createdAt + '|' + n.title] = true; });
    var added = 0;
    for (var i = 0; i < data.notes.length; i++) {
      var n = data.notes[i];
      if (!n || seen[n.createdAt + '|' + n.title]) continue; // already here: skip duplicates
      var photos = (Array.isArray(n.photos) ? n.photos : []).filter(function (p) { return /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(String(p)); }).slice(0, 6);
      await store().save({ owner: owner, subject: String(n.subject || '').slice(0, 80), title: String(n.title || '').slice(0, 120), text: String(n.text || '').slice(0, 20000),
        photos: photos, createdAt: Number(n.createdAt) || Date.now(), updatedAt: Number(n.updatedAt) || Date.now() });
      added++;
    }
    ctx.toast(added ? added + ' note(s) restored.' : 'Nothing new to restore — these notes are already here.');
  }

  window.CMZNotes = { view: view };
})();
