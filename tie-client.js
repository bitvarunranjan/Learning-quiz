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
          let details = {};
          try { details = await res.json(); } catch (_) { /* Keep a safe fallback for non-JSON errors. */ }
          const code = typeof details?.error_code === 'string' ? details.error_code : details?.code;
          const messages = new Map([
            ['invalid_credentials', 'Email or password is incorrect.'],
            ['email_not_confirmed', 'Confirm your email before signing in.'],
            ['email_address_invalid', 'Enter a valid email address.'],
            ['email_address_not_authorized', 'Confirmation email delivery is restricted. Contact the LearnLoop owner.'],
            ['email_provider_disabled', 'Email account creation is currently disabled.'],
            ['signup_disabled', 'Account creation is currently disabled.'],
            ['weak_password', 'Choose a stronger password with at least eight characters.'],
            ['over_email_send_rate_limit', 'Too many confirmation emails requested. Please wait before trying again.']
          ]);
          // Never echo arbitrary server messages, HTML, email addresses or tokens.
          const known = path.startsWith('/auth/v1/') ? messages.get(code) : null;
          const fallback = res.status === 429 ? 'Too many requests. Please wait a few minutes and try again.' :
            res.status === 401 ? 'Please sign in again.' : `Request failed (${res.status}).`;
          const err = new Error(known || fallback);
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
    static redirectQuery(redirectTo) {
      if (!redirectTo) return '';
      const target = new URL(redirectTo);
      const local = target.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(target.hostname);
      if ((!local && target.protocol !== 'https:') || target.username || target.password) {
        throw new Error('Expected an HTTPS confirmation return URL.');
      }
      return '?redirect_to=' + encodeURIComponent(target.origin + target.pathname);
    }
    static authReturn(href) {
      const url = new URL(href);
      const hash = new URLSearchParams(url.hash.slice(1));
      const keys = ['access_token','refresh_token','expires_at','expires_in','token_type','type',
        'error','error_code','error_description','code','token_hash'];
      const hasReturn = ['access_token','refresh_token','error','error_code'].some(k => hash.has(k)) ||
        ['error','error_code','code','token_hash'].some(k => url.searchParams.has(k));
      if (!hasReturn) return null;
      const failed = hash.has('error') || hash.has('error_code') || url.searchParams.has('error') || url.searchParams.has('error_code');
      for (const key of keys) { hash.delete(key); url.searchParams.delete(key); }
      url.hash = hash.toString();
      return {cleanURL: url.href, message: failed ?
        'This confirmation link is invalid or expired. Try signing in or resend confirmation.' :
        'Confirmation link opened. Sign in to continue.'};
    }
    async signUp(email, password, redirectTo) {
      const data = await this.request('/auth/v1/signup' + TieClient.redirectQuery(redirectTo), {email, password});
      this.auth = data.access_token ? data : null;
      return Boolean(this.auth);
    }
    async resendConfirmation(email, redirectTo) {
      return this.request('/auth/v1/resend' + TieClient.redirectQuery(redirectTo), {type: 'signup', email});
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
