/* Creative Math Zone — free app notifications (Web Push).
   CMZPush.state()            -> 'unsupported' | 'ios-install' | 'blocked' | 'on' | 'off'
   CMZPush.enable(api, token) -> asks permission, subscribes this phone, saves it on the server
   CMZPush.disable(api)       -> unsubscribes this phone
   CMZPush.test(token)        -> sends a test notification to this account's phones */
(function () {
  'use strict';
  function fnUrl(q) { var c = window.CMZ_CONFIG || {}; return String(c.supabaseUrl || '').replace(/\/$/, '') + '/functions/v1/notify' + (q || ''); }
  function b64ToBytes(s) {
    var pad = '='.repeat((4 - s.length % 4) % 4), raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length); for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i); return out;
  }
  function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }
  function standalone() { return window.matchMedia && window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
  function supported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
  async function registration() {
    var reg = await navigator.serviceWorker.getRegistration('./');
    if (!reg) reg = await navigator.serviceWorker.register('./service-worker.js', { scope: './' });
    return navigator.serviceWorker.ready.then(function (r) { return r || reg; });
  }
  async function state() {
    if (!supported()) return isIOS() && !standalone() ? 'ios-install' : 'unsupported';
    if (Notification.permission === 'denied') return 'blocked';
    try { var reg = await registration(), sub = await reg.pushManager.getSubscription(); return sub && Notification.permission === 'granted' ? 'on' : 'off'; }
    catch (e) { return 'off'; }
  }
  async function enable(api) {
    if (!supported()) throw { error: isIOS() ? 'On iPhone, first add this site to the Home Screen (Share → Add to Home Screen), open it from there, then turn on notifications.' : 'This browser does not support notifications. Use Chrome.' };
    var perm = await Notification.requestPermission();
    if (perm !== 'granted') throw { error: 'Notifications were not allowed. Allow them in the browser’s site settings and try again.' };
    var res = await fetch(fnUrl('?vapid=1'), { headers: { apikey: (window.CMZ_CONFIG || {}).supabasePublishableKey } });
    var key = (await res.json()).publicKey;
    if (!key) throw { error: 'Could not set up notifications. Try again later.' };
    var reg = await registration(), sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
    await api('push.subscribe', { subscription: sub.toJSON() });
    return true;
  }
  async function disable(api) {
    var reg = await registration(), sub = await reg.pushManager.getSubscription();
    if (!sub) return true;
    try { await api('push.unsubscribe', { endpoint: sub.endpoint }); } catch (e) {}
    await sub.unsubscribe();
    return true;
  }
  async function test(token) {
    var c = window.CMZ_CONFIG || {};
    var res = await fetch(fnUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: c.supabasePublishableKey, Authorization: 'Bearer ' + token },
      body: JSON.stringify({ action: 'test' }) });
    var out = await res.json().catch(function () { return {}; });
    if (!res.ok) throw { error: out.error || 'Could not send a test notification.' };
    return out;
  }
  // Keep the server copy fresh: if this phone is already subscribed, re-save it after sign-in.
  async function refresh(api) {
    try { if (!supported() || Notification.permission !== 'granted') return; var reg = await registration(), sub = await reg.pushManager.getSubscription(); if (sub) await api('push.subscribe', { subscription: sub.toJSON() }); } catch (e) {}
  }
  window.CMZPush = { state: state, enable: enable, disable: disable, test: test, refresh: refresh };
})();
