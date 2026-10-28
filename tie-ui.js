(function () {
  'use strict';
  const host = document.getElementById('tieCloudHost');
  const client = new TieClient(LEARNLOOP_CLOUD.url, LEARNLOOP_CLOUD.publishableKey);
  const returnTo = location.origin + location.pathname;
  const authReturn = TieClient.authReturn(location.href);
  if (authReturn) history.replaceState(null, '', authReturn.cleanURL);
  const node = id => document.getElementById(id);
  let sessionId = null, pendingStart = null, pendingSubmit = null, busy = false;
  let catalog = {lessons: [], quizzes: [], can_publish: false}, visibleLessons = [], savedHistory = [];
  let currentOptions = [], selectedOption = null;
  host.innerHTML = `<h2>LearnLoop Cloud Tutor</h2>
    <p class="muted">Practice approved questions or work through a published practice quiz. Progress is saved to your account.</p>
    <form id="tieAuth"><div class="grid">
      <div class="field"><label for="tieEmail">Email</label><input id="tieEmail" type="email" autocomplete="username" required></div>
      <div class="field"><label for="tiePassword">Password</label><input id="tiePassword" type="password" autocomplete="current-password" minlength="8" required></div>
    </div><div class="row"><button class="btn" type="submit">Sign in</button>
      <button class="btn secondary" id="tieSignup" type="button">Create account</button>
      <button class="btn secondary" id="tieResend" type="button">Resend confirmation</button></div></form>
    <div id="tieWorkspace" hidden>
      <div class="row"><button class="btn secondary" id="tieSignout">Sign out of Cloud Tutor</button>
        <button class="btn secondary" id="tieRefresh">Refresh lessons and history</button>
        <button class="btn secondary" id="tiePublish" hidden>Publish approved local content</button></div>
      <p id="tieCatalogInfo" class="muted"></p>
      <div class="grid"><div class="field"><label for="tieQuiz">Practice set</label><select id="tieQuiz"></select></div>
        <div class="field"><label for="tieLesson">Question</label><select id="tieLesson"></select></div></div>
      <button class="btn" id="tieStart">Start lesson</button>
      <h3>Recent cloud sessions</h3><div id="tieHistory" class="row"></div>
      <div id="tiePractice" hidden><p id="tieQuestionInfo" class="muted"></p><h3 id="tiePrompt"></h3>
        <p id="tieDecision" class="notice" aria-live="polite"></p>
        <form id="tieResponseForm"><div id="tieOptions" role="group" aria-label="Answer options"></div>
          <label id="tieResponseLabel" for="tieResponse">Your response</label>
          <textarea id="tieResponse" maxlength="4000"></textarea>
          <button class="btn" type="submit">Send response</button></form>
        <button class="btn" id="tieNext" hidden>Next question</button>
      </div></div><p id="tieStatus" role="status" aria-live="polite"></p>`;
  function status(text) { node('tieStatus').textContent = text; }
  function loggedIn(value) {
    node('tieAuth').hidden = value; node('tieWorkspace').hidden = !value;
    if (!value) {
      sessionId = null; pendingStart = null; pendingSubmit = null;
      currentOptions = []; selectedOption = null; visibleLessons = []; savedHistory = [];
      catalog = {lessons: [], quizzes: [], can_publish: false};
      node('tiePractice').hidden = true; node('tieHistory').replaceChildren();
      node('tieLesson').replaceChildren(); node('tieQuiz').replaceChildren(); node('tieResponse').value = '';
    }
    node('tiePassword').value = '';
  }
  async function run(operation) {
    if (busy) return;
    busy = true; host.querySelectorAll('button,select').forEach(b => b.disabled = true); status('Working…');
    try { await operation(); }
    catch (err) {
      if (err.status >= 400 && err.status < 500) { pendingStart = null; pendingSubmit = null; }
      if (!client.auth) loggedIn(false);
      status(err.message + (pendingStart || pendingSubmit ? ' Press the same button to retry.' : ''));
    } finally {
      busy = false; host.querySelectorAll('button,select').forEach(b => b.disabled = false);
      if (sessionId && node('tieResponseForm').dataset.mastered === 'true') node('tieResponseForm').hidden = true;
    }
  }
  function option(value, label) {
    const el = document.createElement('option'); el.value = value; el.textContent = label; return el;
  }
  async function loadQuestions(desiredId) {
    visibleLessons = node('tieQuiz').value ? await client.rpc('tie_quiz_questions', {p_quiz_id: node('tieQuiz').value}) : catalog.lessons;
    node('tieLesson').replaceChildren(...visibleLessons.map((l,i) => option(l.id, `${i+1}. ${l.title}`)));
    if (visibleLessons.some(l => l.id === desiredId)) node('tieLesson').value = desiredId;
    updateProgress();
  }
  function updateProgress() {
    const completed = new Set(savedHistory.filter(s => s.mastered).map(s => s.lesson_id));
    const total = visibleLessons.length, done = visibleLessons.filter(l => completed.has(l.id)).length;
    const bankSize = catalog.lessons.filter(l => l.question_id).length;
    node('tieCatalogInfo').textContent = `${bankSize} approved bank questions · ${catalog.quizzes.length} published practice quizzes · ${done}/${total} selected questions have a recent completed session`;
    const index = visibleLessons.findIndex(l => l.id === node('tieLesson').value);
    const item = visibleLessons[index];
    node('tieQuestionInfo').textContent = item ? `Question ${index+1} of ${total}${item.subject ? ' · '+item.subject : ''}${item.topic ? ' · '+item.topic : ''}` : '';
    node('tieNext').hidden = node('tieResponseForm').dataset.mastered !== 'true' || index < 0 || index >= total-1;
  }
  async function refresh() {
    const desiredId = node('tieLesson').value, quiz = node('tieQuiz').value;
    catalog = await client.rpc('tie_catalog'); savedHistory = await client.rpc('tie_history');
    node('tieQuiz').replaceChildren(option('', 'Approved question bank'), ...catalog.quizzes.map(q => option(q.id, `${q.title} (${q.question_count} questions)`)));
    if (catalog.quizzes.some(q => q.id === quiz)) node('tieQuiz').value = quiz;
    node('tiePublish').hidden = !catalog.can_publish;
    await loadQuestions(desiredId);
    node('tieHistory').replaceChildren(...savedHistory.map(s => {
      const title = catalog.lessons.find(l => l.id === s.lesson_id)?.title || 'Saved question';
      const button = document.createElement('button'); button.className = 'btn secondary';
      button.textContent = `${title} · ${s.attempt_count} attempts${s.mastered ? ' · complete' : ''}`;
      button.addEventListener('click', () => run(async () => {
        if (pendingSubmit || pendingStart) throw new Error('Retry the pending request first.');
        const data = await client.rpc('tie_get', {p_session_id: s.session_id});
        if (!visibleLessons.some(l => l.id === data.lesson_id)) { node('tieQuiz').value = ''; await loadQuestions(data.lesson_id); }
        node('tieLesson').value = data.lesson_id; sessionId = s.session_id;
        show(data.decision, data.prompt, data.options || []); status('Session resumed.');
      })); return button;
    }));
    return catalog.lessons.length;
  }
  function show(decision, prompt, options) {
    node('tiePractice').hidden = false;
    if (prompt !== undefined) node('tiePrompt').textContent = prompt;
    if (options !== undefined) {
      currentOptions = options; selectedOption = null;
      node('tieOptions').replaceChildren(...options.map((text,i) => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'option';
        button.textContent = `${String.fromCharCode(65+i)}. ${text}`; button.setAttribute('aria-pressed','false');
        button.addEventListener('click', () => {
          selectedOption = text;
          [...node('tieOptions').children].forEach((b,j) => { b.classList.toggle('selected',j===i); b.setAttribute('aria-pressed',String(j===i)); });
        }); return button;
      }));
      node('tieResponse').hidden = options.length > 0; node('tieResponseLabel').hidden = options.length > 0;
    }
    const action = decision.action.replace(/_/g, ' ');
    node('tieDecision').textContent = `${action}: ${decision.message || 'This content needs educator review.'} (${decision.attempt_count} attempts)`;
    node('tieResponseForm').dataset.mastered = String(decision.mastered); node('tieResponseForm').hidden = decision.mastered;
    updateProgress();
  }
  async function startLesson() {
    if (pendingSubmit) throw new Error('Retry the pending response first.');
    if (!pendingStart) {
      if (!node('tieLesson').value) throw new Error('No reviewed question is available.');
      pendingStart = {p_session_id: crypto.randomUUID(), p_lesson_id: node('tieLesson').value};
    }
    const targetId = pendingStart.p_lesson_id;
    const data = await client.rpc('tie_start', pendingStart);
    pendingStart = null; sessionId = data.session_id; pendingSubmit = null; node('tieLesson').value = targetId;
    node('tieResponse').value = ''; show(data.decision, data.prompt || data.decision.message, data.options || []);
    status(data.session_id ? 'Lesson started.' : 'Lesson blocked for review.'); await refresh();
  }
  node('tieAuth').addEventListener('submit', e => { e.preventDefault(); run(async () => {
    await client.signIn(node('tieEmail').value.trim(), node('tiePassword').value);
    loggedIn(true); const count = await refresh(); status(count ? 'Choose a lesson or resume a session.' : 'No reviewed lessons available.');
  }); });
  node('tieSignup').addEventListener('click', () => {
    if (!node('tieAuth').reportValidity()) return;
    run(async () => {
      const signedIn = await client.signUp(node('tieEmail').value.trim(), node('tiePassword').value, returnTo); node('tiePassword').value = '';
      if (signedIn) { loggedIn(true); await refresh(); status('Account ready. Choose a lesson.'); }
      else status('Check your email to confirm your account, then sign in here.');
    });
  });
  node('tieResend').addEventListener('click', () => {
    if (!node('tieEmail').reportValidity()) return;
    run(async () => { await client.resendConfirmation(node('tieEmail').value.trim(), returnTo); node('tiePassword').value = '';
      status('If an account needs confirmation, a new link has been requested. Check your email.'); });
  });
  node('tieSignout').addEventListener('click', () => run(async () => { try { await client.signOut(); } finally { loggedIn(false); } status('Signed out of Cloud Tutor.'); }));
  node('tieRefresh').addEventListener('click', () => run(async () => { await refresh(); status('Lessons and history refreshed.'); }));
  node('tieStart').addEventListener('click', () => run(startLesson));
  node('tieQuiz').addEventListener('change', () => run(async () => {
    if (pendingStart || pendingSubmit) throw new Error('Retry the pending request first.');
    sessionId = null; node('tiePractice').hidden = true; node('tieResponseForm').dataset.mastered = 'false';
    await loadQuestions(); status('Practice set selected. Choose a question to start.');
  }));
  node('tieLesson').addEventListener('change', () => { sessionId = null; node('tiePractice').hidden = true; node('tieResponseForm').dataset.mastered = 'false'; updateProgress(); });
  node('tieNext').addEventListener('click', () => run(async () => {
    const index = visibleLessons.findIndex(l => l.id === node('tieLesson').value);
    if (index < 0 || index >= visibleLessons.length-1) throw new Error('You reached the last question.');
    node('tieLesson').value = visibleLessons[index+1].id; await startLesson();
  }));
  node('tieResponseForm').addEventListener('submit', e => { e.preventDefault(); run(async () => {
    if (!sessionId) throw new Error('Start a lesson first.');
    if (!pendingSubmit) {
      if (currentOptions.length && selectedOption === null) throw new Error('Choose an option before submitting.');
      pendingSubmit = {p_session_id: sessionId, p_response: currentOptions.length ? selectedOption : node('tieResponse').value, p_request_id: crypto.randomUUID()};
    }
    const decision = await client.rpc('tie_submit', pendingSubmit); pendingSubmit = null; show(decision); node('tieResponse').value = '';
    status(decision.mastered ? 'Practice complete. Repeated correctness is a practice signal.' : 'Response saved.'); await refresh();
  }); });
  function publishLocal() {
    document.getElementById('tieCloud').open = true;
    if (!client.auth) return status('Sign in to Cloud Tutor with an approved educator account to publish local content.');
    if (!catalog.can_publish) return status('Publishing requires an educator permission granted by the LearnLoop owner.');
    run(async () => {
      if (pendingStart || pendingSubmit) throw new Error('Retry the pending request first.');
      const payload = typeof window.learnloopCloudExport === 'function' ? window.learnloopCloudExport() : null;
      if (!payload || !payload.questions.length) throw new Error('There are no approved local questions to publish.');
      const result = await client.rpc('tie_publish_bank',{p_payload:payload}); await refresh();
      status(`${result.questions} approved questions and ${result.quizzes} published quizzes connected. Timed exams remain outside guided practice.`);
    });
  }
  node('tiePublish').addEventListener('click',publishLocal);
  window.addEventListener('learnloop:publish',publishLocal);
  if (authReturn) { document.getElementById('tieCloud').open = true; status(authReturn.message); }
})();
