/* No third-party runtime dependencies. Tokens stay in memory, never localStorage. */
(function (root) {
  'use strict';
  class TieClient {
    constructor(url, key, fetcher = globalThis.fetch.bind(globalThis)) {
      const origin = new URL(url);
      if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
        throw new Error('Expected an HTTPS Supabase origin.');
      }
      if (!key || key.startsWith('sb_secret_')) throw new Error('Use a publishable key.');
      if (!key.startsWith('sb_publishable_')) {
        try {
          const payload = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
          if (payload.role !== 'anon') throw new Error();
        } catch (_) { throw new Error('Use a publishable or legacy anon key.'); }
      }
      this.url = origin.origin; this.key = key; this.fetcher = fetcher; this.auth = null;
    }
    async request(path, body, token) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await this.fetcher(this.url + path, {
          method: 'POST', signal: controller.signal,
          headers: {apikey: this.key, 'Content-Type': 'application/json', ...(token ? {Authorization: 'Bearer ' + token} : {})},
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          const err = new Error(res.status === 401 ? 'Please sign in again.' : `Request failed (${res.status}).`);
          err.status = res.status; throw err;
        }
        if (res.status === 204) return null;
        return await res.json();
      } catch (err) {
        if (err.name === 'AbortError' || err instanceof TypeError) throw new Error('Connection interrupted. Retry the same request.');
        throw err;
      } finally { clearTimeout(timer); }
    }
    async signIn(email, password) {
      this.auth = null;
      const data = await this.request('/auth/v1/token?grant_type=password', {email, password});
      this.auth = data; return data.user;
    }
    async signUp(email, password) {
      const data = await this.request('/auth/v1/signup', {email, password});
      this.auth = data.access_token ? data : null;
      return Boolean(this.auth);
    }
    async token() {
      if (!this.auth) throw new Error('Please sign in.');
      if (this.auth.expires_at * 1000 < Date.now() + 30000) {
        try { this.auth = await this.request('/auth/v1/token?grant_type=refresh_token', {refresh_token: this.auth.refresh_token}); }
        catch (err) { this.auth = null; throw err; }
      }
      return this.auth.access_token;
    }
    async rpc(name, body = {}) {
      if (!['tie_lessons','tie_start','tie_submit','tie_get','tie_history'].includes(name)) throw new Error('Unsupported tutor operation.');
      try { return await this.request('/rest/v1/rpc/' + name, body, await this.token()); }
      catch (err) { if (err.status === 401) this.auth = null; throw err; }
    }
    async signOut() {
      const token = this.auth && this.auth.access_token;
      this.auth = null; // Local sign-out must complete even if the network is unavailable.
      if (token) await this.request('/auth/v1/logout', {}, token);
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = {TieClient};
  else root.TieClient = TieClient;
})(globalThis);
