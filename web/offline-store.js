/* Offline mode: a copy of what a signed-in person viewed, kept on their own phone
   (IndexedDB, this browser/app only). Shown when there is no internet, with an
   "Offline — saved on …" bar. Sign out deletes that person's copy. */
(function () {
  'use strict';
  var DB = 'cmz-offline', STORE = 'reads', OUT = 'outbox', NOTES = 'notes', dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('no indexedDB')); return; }
      var req = indexedDB.open(DB, 3);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        if (!db.objectStoreNames.contains(OUT)) db.createObjectStore(OUT, { keyPath: 'id', autoIncrement: true }).createIndex('owner', 'owner');
        if (!db.objectStoreNames.contains(NOTES)) db.createObjectStore(NOTES, { keyPath: 'id', autoIncrement: true }).createIndex('owner', 'owner');
      };
      // Another open tab still uses the older version: let it close so this one can upgrade.
      req.onblocked = function () { reject(new Error('Close other Creative Math Zone tabs and try again.')); };
      req.onsuccess = function () { var db = req.result; db.onversionchange = function () { db.close(); dbp = null; }; resolve(db); };
      req.onerror = function () { reject(req.error); };
    });
    dbp.catch(function () { dbp = null; });
    return dbp;
  }
  function tx(mode, fn, store) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store || STORE, mode), s = t.objectStore(store || STORE), out = fn(s);
        t.oncomplete = function () { resolve(out && 'result' in out ? out.result : undefined); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }
  var bar = null;
  function showBar(at) {
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'offline-bar'; bar.setAttribute('role', 'status');
      bar.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:60;background:#102447;color:#fff;border:1px solid #ffc629;' +
        'border-radius:999px;padding:.25rem .8rem;font-size:.78rem;box-shadow:0 4px 14px rgba(0,0,0,.2);max-width:calc(100% - 24px);text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      document.body.appendChild(bar);
    }
    var when = at ? new Date(at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
    bar.textContent = '📴 Offline' + (when ? ' · saved ' + when : ' · showing saved data');
    bar.title = 'No internet — showing what was saved on this phone';
    bar.hidden = false;
  }
  function hideBar() { if (bar) bar.hidden = true; }
  window.CMZOffline = {
    key: function (owner, action, payload) { return owner + '|' + action + '|' + JSON.stringify(payload || {}); },
    put: function (key, data) { return tx('readwrite', function (s) { s.put({ data: data, at: Date.now() }, key); }).catch(function () {}); },
    get: function (key) { return tx('readonly', function (s) { return s.get(key); }).catch(function () { return undefined; }); },
    // Delete everything saved for one person (on sign out).
    clearOwner: function (owner) {
      if (!owner) return Promise.resolve();
      return tx('readwrite', function (s) {
        var range = IDBKeyRange.bound(owner + '|', owner + '|￿');
        var c = s.openCursor(range);
        c.onsuccess = function () { var cur = c.result; if (cur) { cur.delete(); cur.continue(); } };
      }).catch(function () {});
    },
    // A network failure (not a server "no"): no internet, or the server could not be reached.
    isNetworkError: function (e) { return !navigator.onLine || (e && (e.code === 'NETWORK' || /fetch|network|load failed/i.test(String(e.error || e.message || '')))); },
    offline: showBar,
    online: hideBar,
  };

  /* ---------- Outbox: things written offline (homework, doubts), sent automatically later ----------
     Each item keeps its text and the real photo/file data on the phone until it is sent.
     A sender is registered per kind; it may update item.progress so a half-sent item resumes. */
  var senders = {}, listeners = [], flushing = false;
  function changed(owner) { listeners.forEach(function (fn) { try { fn(owner); } catch (e) {} }); }
  var O = {
    register: function (kind, send) { senders[kind] = send; },
    onChange: function (fn) { listeners.push(fn); },
    add: function (owner, item) {
      var rec = { owner: owner, kind: item.kind, label: item.label || '', payload: item.payload || {}, files: item.files || [],
        progress: {}, status: 'WAITING', error: '', createdAt: Date.now() };
      return tx('readwrite', function (s) { return s.add(rec); }, OUT).then(function (id) { changed(owner); return id; });
    },
    list: function (owner) {
      return tx('readonly', function (s) { return s.index('owner').getAll(owner); }, OUT).then(function (rows) { return rows || []; }).catch(function () { return []; });
    },
    save: function (rec) { return tx('readwrite', function (s) { s.put(rec); }, OUT); },
    remove: function (id, owner) { return tx('readwrite', function (s) { s.delete(id); }, OUT).then(function () { changed(owner); }); },
    clearOwner: function (owner) {
      return O.list(owner).then(function (rows) { return Promise.all(rows.map(function (r) { return O.remove(r.id, owner); })); });
    },
    // Sends waiting items one by one. Stops at the first network failure (still offline);
    // a refusal from the server (e.g. deadline passed) marks that item FAILED with the reason.
    flush: async function (owner, onSent) {
      if (flushing || !owner || !navigator.onLine) return 0;
      flushing = true; var sent = 0;
      try {
        var rows = (await O.list(owner)).filter(function (r) { return r.status === 'WAITING'; }).sort(function (a, b) { return a.createdAt - b.createdAt; });
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i], send = senders[r.kind];
          if (!send) continue;
          try {
            await send(r, function () { return O.save(r); });
            await O.remove(r.id, owner); sent++;
            if (onSent) onSent(r);
          } catch (e) {
            if (window.CMZOffline.isNetworkError(e)) break;
            r.status = 'FAILED'; r.error = String((e && (e.error || e.message)) || 'The server did not accept it.'); await O.save(r); changed(owner);
          }
        }
      } finally { flushing = false; }
      return sent;
    },
  };
  window.CMZOutbox = O;

  /* ---------- My Notes: personal notes kept only on this phone (never sent to the server) ---------- */
  window.CMZNoteStore = {
    list: function (owner) { return tx('readonly', function (s) { return s.index('owner').getAll(owner); }, NOTES).then(function (r) { return r || []; }); },
    save: function (note) { return tx('readwrite', function (s) { return s.put(note); }, NOTES); },
    remove: function (id) { return tx('readwrite', function (s) { s.delete(id); }, NOTES); },
    clearOwner: function (owner) {
      return window.CMZNoteStore.list(owner).then(function (rows) { return Promise.all(rows.map(function (r) { return window.CMZNoteStore.remove(r.id); })); });
    },
  };
  // Ask the phone not to clear this app's storage when space runs low (best effort).
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
})();
