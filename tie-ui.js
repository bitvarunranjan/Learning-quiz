(function () {
  'use strict';
  const host = document.getElementById('tieCloudHost');
  const client = new TieClient(LEARNLOOP_CLOUD.url, LEARNLOOP_CLOUD.publishableKey);
  const returnTo = location.origin + location.pathname;
  const authReturn = TieClient.authReturn(location.href);
  if (authReturn) history.replaceState(null, '', authReturn.cleanURL);
  const node = id => document.getElementById(id);
  let sessionId = null, pendingStart = null, pendingSubmit = null, busy = false;
  // A network retry retains exactly the same UUID and body. No progress comes from the browser.
  host.innerHTML = `<h2>LearnLoop Cloud Tutor</h2>
    <p class="muted">Guided practice with saved progress. Sign in with your cloud account.</p>
    <form id="tieAuth"><div class="grid">
      <div class="field"><label for="tieEmail">Email</label><input id="tieEmail" type="email" autocomplete="username" required></div>
      <div class="field"><label for="tiePassword">Password</label><input id="tiePassword" type="password" autocomplete="current-password" minlength="8" required></div>
    </div><div class="row"><button class="btn" type="submit">Sign in</button>
      <button class="btn secondary" id="tieSignup" type="button">Create account</button>
      <button class="btn secondary" id="tieResend" type="button">Resend confirmation</button></div></form>
    <div id="tieWorkspace" hidden>
      <div class="row"><button class="btn secondary" id="tieSignout">Sign out of Cloud Tutor</button>
        <button class="btn secondary" id="tieRefresh">Refresh lessons and history</button></div>
      <div class="field"><label for="tieLesson">Lesson</label><select id="tieLesson"></select></div>
      <button class="btn" id="tieStart">Start lesson</button>
      <h3>Recent cloud sessions</h3><div id="tieHistory"></div>
      <div id="tiePractice" hidden><h3 id="tiePrompt"></h3>
        <p id="tieDecision" class="notice" aria-live="polite"></p>
        <form id="tieResponseForm"><label for="tieResponse">Your response</label>
          <textarea id="tieResponse" maxlength="4000"></textarea>
          <button class="btn" type="submit">Send response</button></form>
      </div></div><p id="tieStatus" role="status" aria-live="polite"></p>`;
  function status(text) { node('tieStatus').textContent = text; }
  function loggedIn(value) {
    node('tieAuth').hidden = value; node('tieWorkspace').hidden = !value;
    if (!value) {
      sessionId = null; pendingStart = null; pendingSubmit = null;
      node('tiePractice').hidden = true; node('tieHistory').replaceChildren();
      node('tieLesson').replaceChildren(); node('tieResponse').value = '';
    }
    node('tiePassword').value = '';
  }
  async function run(operation) {
    if (busy) return;
    busy = true; host.querySelectorAll('button').forEach(b => b.disabled = true);
    status('Working…');
    try { await operation(); }
    catch (err) {
      if (err.status >= 400 && err.status < 500) { pendingStart = null; pendingSubmit = null; }
      if (!client.auth) loggedIn(false);
      status(err.message + (pendingStart || pendingSubmit ? ' Press the same button to retry.' : ''));
    } finally {
      busy = false; host.querySelectorAll('button').forEach(b => b.disabled = false);
      if (sessionId && node('tieResponseForm').dataset.mastered === 'true') node('tieResponseForm').hidden = true;
    }
  }
  async function refresh() {
    const lessons = await client.rpc('tie_lessons');
    node('tieLesson').replaceChildren(...lessons.map(l => {
      const option = document.createElement('option'); option.value = l.id; option.textContent = l.title; return option;
    }));
    node('tieHistory').replaceChildren(...(await client.rpc('tie_history')).map(s => {
      const button = document.createElement('button'); button.className = 'btn secondary';
      button.textContent = `${s.lesson_id} · ${s.attempt_count} attempts${s.mastered ? ' · complete' : ''}`;
      button.addEventListener('click', () => run(async () => {
        if (pendingSubmit || pendingStart) throw new Error('Retry the pending request first.');
        const data = await client.rpc('tie_get', {p_session_id: s.session_id});
        sessionId = s.session_id; show(data.decision, data.prompt); status('Session resumed.');
      })); return button;
    }));
    return lessons.length;
  }
  function show(decision, prompt) {
    node('tiePractice').hidden = false;
    if (prompt !== undefined) node('tiePrompt').textContent = prompt;
    const action = decision.action.replace(/_/g, ' ');
    node('tieDecision').textContent = `${action}: ${decision.message || 'This content needs educator review.'} (${decision.attempt_count} attempts)`;
    node('tieResponseForm').dataset.mastered = String(decision.mastered);
    node('tieResponseForm').hidden = decision.mastered;
  }
  node('tieAuth').addEventListener('submit', e => { e.preventDefault(); run(async () => {
    await client.signIn(node('tieEmail').value.trim(), node('tiePassword').value);
    loggedIn(true); const count = await refresh(); status(count ? 'Choose a lesson or resume a session.' : 'No reviewed lessons available.');
  }); });
  node('tieSignup').addEventListener('click', () => {
    if (!node('tieAuth').reportValidity()) return;
    run(async () => {
      const signedIn = await client.signUp(node('tieEmail').value.trim(), node('tiePassword').value, returnTo);
      node('tiePassword').value = '';
      if (signedIn) { loggedIn(true); await refresh(); status('Account ready. Choose a lesson.'); }
      else status('Check your email to confirm your account, then sign in here.');
    });
  });
  node('tieResend').addEventListener('click', () => {
    if (!node('tieEmail').reportValidity()) return;
    run(async () => {
      await client.resendConfirmation(node('tieEmail').value.trim(), returnTo);
      node('tiePassword').value = '';
      status('If an account needs confirmation, a new link has been requested. Check your email.');
    });
  });
  node('tieSignout').addEventListener('click', () => run(async () => {
    try { await client.signOut(); } finally { loggedIn(false); }
    status('Signed out of Cloud Tutor.');
  }));
  node('tieRefresh').addEventListener('click', () => run(async () => { await refresh(); status('Lessons and history refreshed.'); }));
  node('tieStart').addEventListener('click', () => run(async () => {
    if (pendingSubmit) throw new Error('Retry the pending response first.');
    if (!pendingStart) {
      if (!node('tieLesson').value) throw new Error('No reviewed lesson is available.');
      pendingStart = {p_session_id: crypto.randomUUID(), p_lesson_id: node('tieLesson').value};
    }
    const data = await client.rpc('tie_start', pendingStart);
    pendingStart = null; sessionId = data.session_id; pendingSubmit = null;
    node('tieResponse').value = '';
    show(data.decision, data.prompt || data.decision.message);
    status(data.session_id ? 'Lesson started.' : 'Lesson blocked for review.');
    await refresh();
  }));
  node('tieResponseForm').addEventListener('submit', e => { e.preventDefault(); run(async () => {
    if (!sessionId) throw new Error('Start a lesson first.');
    if (!pendingSubmit) pendingSubmit = {p_session_id: sessionId, p_response: node('tieResponse').value, p_request_id: crypto.randomUUID()};
    const decision = await client.rpc('tie_submit', pendingSubmit);
    pendingSubmit = null; show(decision); node('tieResponse').value = '';
    status(decision.mastered ? 'Practice complete. Repeated correctness is a practice signal.' : 'Response saved.');
    await refresh();
  }); });
  if (authReturn) {
    document.getElementById('tieCloud').open = true;
    status(authReturn.message);
  }
})();
