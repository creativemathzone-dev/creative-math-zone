/* Optional passkey layer for the existing password-based CMZ portals.
   This uses only the public Supabase key. Server-side revocation uses the
   secret key inside the Edge Function, never in the browser. */
(function () {
  const cfg = window.CMZ_CONFIG || {};
  const sdk = window.supabase;
  if (!sdk || !cfg.supabaseUrl || !cfg.supabasePublishableKey) return;

  let client;
  try {
    client = sdk.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
      auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false, experimental: { passkey: true } },
    });
  } catch (error) {
    console.warn('Passkey sign-in is unavailable in this browser.', error);
    return;
  }

  const report = error => ({ error: error && (error.message || error.error_description) || 'Passkey operation failed.' });
  // "Keep me signed in" (students and teachers only): the sign-in renews itself, so keep the
  // saved renewal token up to date or it would stop working.
  client.auth.onAuthStateChange((_event, session) => {
    try {
      const raw = localStorage.getItem('cmz_keep');
      if (!raw || !session || !session.refresh_token) return;
      const keep = JSON.parse(raw);
      if (keep.refresh !== session.refresh_token) localStorage.setItem('cmz_keep', JSON.stringify({ type: keep.type, refresh: session.refresh_token }));
    } catch (e) { /* storage blocked: the person just signs in again */ }
  });
  window.CMZPasskey = {
    async refresh(refreshToken) {
      try {
        const { data, error } = await client.auth.refreshSession({ refresh_token: refreshToken });
        return error || !data.session ? { error: report(error).error } : { session: data.session };
      } catch (error) { return { error: report(error).error }; }
    },
    async signIn() {
      const { data, error } = await client.auth.signInWithPasskey();
      return error ? { error: report(error).error } : { session: data && data.session };
    },
    async setSession(accessToken, refreshToken) {
      // A damaged saved token must not leave the page blank: report it, never throw.
      try {
        const { data, error } = await client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
        return error ? { error: report(error).error } : { session: data.session };
      } catch (error) { return { error: report(error).error }; }
    },
    async register() {
      const { data, error } = await client.auth.registerPasskey();
      return error ? { error: report(error).error } : { passkey: data };
    },
    async list() {
      const { data, error } = await client.auth.passkey.list();
      return error ? { error: report(error).error } : { passkeys: data || [] };
    },
    async remove(passkeyId) {
      const { error } = await client.auth.passkey.delete({ passkeyId });
      return error ? { error: report(error).error } : {};
    },
    async signOut() {
      const { error } = await client.auth.signOut({ scope: 'local' });
      return error ? { error: report(error).error } : {};
    },
    renderManager(container, addButton, escapeHtml, notify) {
      if (!container || !addButton) return;
      const render = async () => {
        container.innerHTML = '<span class="muted">Loading passkeys…</span>';
        const result = await this.list();
        if (result.error) { container.innerHTML = '<p class="muted">Passkeys are not available yet. Use your password sign-in.</p>'; return; }
        const passkeys = Array.isArray(result.passkeys) ? result.passkeys : [];
        container.innerHTML = passkeys.length ? passkeys.map(key => '<div class="row" style="display:flex;align-items:center;justify-content:space-between;gap:.75rem;padding:.65rem 0;border-top:1px solid var(--line)"><span><b>' + escapeHtml(key.friendly_name || 'Passkey') + '</b><small class="muted" style="display:block">Added ' + escapeHtml(key.created_at ? new Date(key.created_at).toLocaleDateString() : 'date unavailable') + '</small></span><button class="btn small" type="button" data-passkey-remove="' + escapeHtml(key.id) + '">Remove</button></div>').join('') : '<p class="muted">No passkey is registered on this account yet.</p>';
      };
      const reload = () => render().catch(error => { container.textContent = error.message || 'Could not load passkeys.'; });
      addButton.addEventListener('click', async () => {
        addButton.disabled = true;
        try {
          const result = await this.register();
          if (result.error) throw new Error(result.error);
          notify('Passkey added. You can now use this device to sign in.');
          await render();
        } catch (error) { notify(error.message || 'Could not add a passkey.', true); }
        finally { addButton.disabled = false; }
      });
      container.addEventListener('click', async event => {
        const button = event.target.closest('[data-passkey-remove]');
        if (!button) return;
        if (!window.confirm('Remove this passkey from your account?')) return;
        button.disabled = true;
        const result = await this.remove(button.dataset.passkeyRemove);
        if (result.error) notify(result.error, true); else notify('Passkey removed.');
        await render();
      });
      reload();
    },
    watch(callback) {
      return client.auth.onAuthStateChange((_event, session) => callback(session));
    },
  };
})();
