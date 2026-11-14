/* CMZ Android app helpers. Runs ONLY inside the CMZ app (Capacitor); does nothing in a browser.
   - Phone Back button: closes pop-ups / menu / receipt, then goes Home, then leaves the app.
   - Printing and "Save as PDF": Android's own Print screen (native CmzPrint plugin).
   - Downloads (homework files, CSV lists, note backups): Android's share / save menu.
   - Web links (class materials, WhatsApp): open outside the app. */
(function () {
  'use strict';
  var C = window.Capacitor;
  if (!C || !C.isNativePlatform || !C.isNativePlatform()) return;
  document.documentElement.classList.add('cmz-native');
  function plugin(name) { try { return (C.Plugins && C.Plugins[name]) || (C.registerPlugin ? C.registerPlugin(name) : null); } catch (e) { return null; } }
  var App = plugin('App'), Browser = plugin('Browser'), Fs = plugin('Filesystem'), Share = plugin('Share'), Printer = plugin('CmzPrint');
  function say(msg, bad) { if (typeof window.toast === 'function') window.toast(msg, bad); else if (typeof toast === 'function') toast(msg, bad); }
  function openOutside(url) { if (Browser) Browser.open({ url: String(url) }).catch(function () { location.href = url; }); else location.href = url; }

  // Fingerprint/passkey sign-in is not available inside the app yet (password + "Remember me" works).
  var css = document.createElement('style');
  css.textContent = '.cmz-native #passkey-login,.cmz-native #passkey-add,.cmz-native #passkey-list{display:none!important}';
  document.head.appendChild(css);

  /* ---------- Back button ---------- */
  if (App) App.addListener('backButton', function () {
    var dlg = document.getElementById('dlg');
    if (dlg && dlg.open) { dlg.close(); return; }
    var side = document.getElementById('side');
    if (side && side.classList.contains('open')) { side.classList.remove('open'); return; }
    if (document.getElementById('doc-overlay') && typeof closeDoc === 'function') { closeDoc(); return; }
    /* global S, go */
    if (typeof S === 'object' && S && S.user && S.view && S.view !== 'dashboard' && typeof go === 'function') { go('dashboard'); return; }
    if (App.minimizeApp) App.minimizeApp(); else App.exitApp();
  });

  /* ---------- Printing / Save as PDF ---------- */
  function printHtml(html, title) {
    if (!Printer) { say('Printing is not available in this version of the app. Please use the website on a computer.', true); return; }
    html = String(html || '').replace(/<script[\s\S]*?<\/script>/gi, '');
    Printer.printHtml({ html: html, title: title || document.title || 'Creative Math Zone' }).catch(function () { say('Could not open printing.', true); });
  }
  // Pages that print build a new window with window.open('') and document.write(...).
  function printWindow() {
    var html = '', w = {
      closed: false, focus: function () {}, print: function () {}, close: function () { w.closed = true; },
      document: { title: '', open: function () {}, write: function (h) { html += h; }, writeln: function (h) { html += h + '\n'; },
        close: function () { setTimeout(function () { printHtml(html); }, 60); } },
      location: {},
    };
    Object.defineProperty(w.location, 'href', { set: function (u) { if (/^https?:/i.test(u)) openOutside(u); } });
    return w;
  }
  window.open = function (url) {
    if (url && /^https?:/i.test(String(url))) { openOutside(url); return null; }
    return printWindow();
  };
  // Receipts and report cards print the current page with print styles.
  window.print = function () {
    var copy = document.documentElement.cloneNode(true);
    Array.prototype.forEach.call(copy.querySelectorAll('script, dialog, #toast'), function (n) { n.remove(); });
    printHtml('<!doctype html>' + copy.outerHTML);
  };

  /* ---------- "New version of CMZ available" ----------
     Website changes reach the app by themselves. Only a new app build (icon, native parts)
     needs installing: the app compares its build number with /downloads/cmz-version.json. */
  var lastCheck = 0;
  function checkForUpdate() {
    if (!App || !App.getInfo || Date.now() - lastCheck < 6 * 3600000) return;
    lastCheck = Date.now();
    Promise.all([App.getInfo(), fetch('/downloads/cmz-version.json?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; })])
      .then(function (out) {
        var info = out[0], latest = out[1];
        if (!latest || !(Number(latest.versionCode) > Number(info.build))) return;
        try { if (sessionStorage.getItem('cmz_update_later') === String(latest.versionCode)) return; } catch (e) {}
        if (document.getElementById('cmz-update')) return;
        var bar = document.createElement('div');
        bar.id = 'cmz-update'; bar.setAttribute('role', 'alert');
        bar.style.cssText = 'position:fixed;left:12px;right:12px;bottom:86px;z-index:70;background:#102447;color:#fff;border:2px solid #ffc629;border-radius:14px;' +
          'padding:.8rem .9rem;box-shadow:0 8px 24px rgba(0,0,0,.3);display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;font-size:.92rem';
        bar.innerHTML = '<span style="flex:1 1 180px">🎉 <b>New version of CMZ</b> (' + String(latest.versionName || '').replace(/[^\w.]/g, '') + ') is ready.</span>' +
          '<button type="button" id="cmz-update-go" style="border:0;border-radius:10px;background:#ffc629;color:#142746;font:inherit;font-weight:800;padding:.5rem .9rem">Update</button>' +
          '<button type="button" id="cmz-update-later" style="border:1px solid #ffffff55;border-radius:10px;background:none;color:#fff;font:inherit;padding:.5rem .8rem">Later</button>';
        document.body.appendChild(bar);
        bar.querySelector('#cmz-update-go').addEventListener('click', function () {
          openOutside('https://creativemathzone.in/downloads/CMZ.apk');
          bar.querySelector('span').innerHTML = '⬇ Downloading… When it finishes, open it and tap <b>Update</b>. You stay signed in.';
        });
        bar.querySelector('#cmz-update-later').addEventListener('click', function () {
          try { sessionStorage.setItem('cmz_update_later', String(latest.versionCode)); } catch (e) {}
          bar.remove();
        });
      })
      .catch(function () { /* offline: check again later */ });
  }
  if (document.readyState === 'complete') setTimeout(checkForUpdate, 3000);
  else window.addEventListener('load', function () { setTimeout(checkForUpdate, 3000); });
  if (App) App.addListener('resume', function () { setTimeout(checkForUpdate, 1500); });

  /* ---------- Downloads -> share / save menu ---------- */
  function toBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader(); r.onload = function () { resolve(String(r.result).split(',')[1] || ''); }; r.onerror = reject; r.readAsDataURL(blob);
    });
  }
  function saveAndShare(href, name) {
    if (!Fs || !Share) { say('Saving files is not available in this version of the app.', true); return; }
    name = String(name || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'file';
    fetch(href).then(function (r) { return r.blob(); }).then(toBase64)
      .then(function (data) { return Fs.writeFile({ path: name, data: data, directory: 'CACHE' }); })
      .then(function (res) { return Share.share({ title: name, files: [res.uri], dialogTitle: 'Save or open ' + name }); })
      .catch(function (e) { if (!/cancel/i.test(String(e && (e.message || e)))) say('Could not save the file.', true); });
  }
  var nativeClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.hasAttribute('download') && /^(blob:|data:)/.test(this.href)) { saveAndShare(this.href, this.getAttribute('download')); return; }
    if (/^https?:/i.test(this.href) && (this.target === '_blank' || this.host !== location.host)) { openOutside(this.href); return; }
    return nativeClick.call(this);
  };
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    if (a.hasAttribute('download') && /^(blob:|data:)/.test(a.href)) { ev.preventDefault(); ev.stopImmediatePropagation(); saveAndShare(a.href, a.getAttribute('download')); return; }
    if (/^https?:/i.test(a.href) && (a.target === '_blank' || a.host !== location.host)) { ev.preventDefault(); openOutside(a.href); }
  }, true);
})();
