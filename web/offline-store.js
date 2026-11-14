/* Offline mode: a copy of what a signed-in person viewed, kept on their own phone
   (IndexedDB, this browser/app only). Shown when there is no internet, with an
   "Offline — saved on …" bar. Sign out deletes that person's copy. */
(function () {
  'use strict';
  var DB = 'cmz-offline', STORE = 'reads', dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('no indexedDB')); return; }
      var req = indexedDB.open(DB, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    dbp.catch(function () { dbp = null; });
    return dbp;
  }
  function tx(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode), s = t.objectStore(STORE), out = fn(s);
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
        'border-radius:999px;padding:.35rem .9rem;font-size:.82rem;box-shadow:0 4px 14px rgba(0,0,0,.2);max-width:calc(100% - 24px);text-align:center';
      document.body.appendChild(bar);
    }
    var when = at ? new Date(at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
    bar.textContent = '📴 Offline — showing what was saved' + (when ? ' on ' + when : '');
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
})();
