# LearnLoop + Tutor Intelligence Engine v0.1

LearnLoop's existing offline quiz dashboard now includes **Cloud Tutor**, a real
Supabase-authenticated guided-practice workspace with persistent tutor sessions.
The repository also contains a dependency-free Python tutor module, an adapter
for the existing LearnLoop question shape, and a Python client for the cloud API.

## Use the app

Serve this directory and open the address printed by Python:

```sh
python3 -m http.server 8000
# Open http://localhost:8000
```

Open **Cloud Tutor · Guided practice** at the top. Sign in with a Supabase email
account or select Create account. If email confirmation is enabled, confirm your
email before signing in. Use **Resend confirmation** if needed. Confirmation links
return to the deployed page; credentials are removed from the return URL and you
sign in with your password. Select a published practice set or the approved question bank, choose a question, then Start lesson. Select an option and send your response. After completion, Next question advances within the selected set. **Combining groups** remains available as a sample. Incorrect
responses move through a hint, explanation and remediation. A correct response
asks you to check your reasoning; another consecutive correct response completes
practice. Recent cloud sessions can be resumed after signing in again.

Cloud authentication and refresh tokens stay in memory; reloading signs you out
of this page, but keeps progress in Supabase. Cloud sign-out is separate from the
old demo login. No passwords or tokens are placed in localStorage by Cloud Tutor.
Use HTTPS when hosting the app; localhost is suitable for development.

The original Student/Teacher/Admin demo remains below the Cloud Tutor panel:
import example_import.json, approve questions, publish quizzes, practice, take
local timed exams, and inspect local analytics. It still uses simulated roles
and browser localStorage. Cloud Tutor now uses the approved question bank and published practice quizzes in Supabase. The initial import contains eight questions and four published quizzes; three practice quizzes appear in Cloud Tutor, while the timed exam remains separate. Offline edits remain local until an authorized educator explicitly publishes them. Exam results and demo analytics are not uploaded.

## Architecture

```text
index.html → tie-ui.js → tie-client.js → Supabase Auth + public.tie_* RPCs
                                                ↓
                                   tie_private lessons/sessions/requests
Python SupabaseTutor ────────────────────────────┘
Python TutorEngine + offline adapters: independent local use, no network
```

Hosted tutoring executes in PostgreSQL transactions, not in a Python web server
or an Edge Function. This avoids adding a separate Python hosting dependency.
The Python cloud client uses the same RPC API as the browser; the local Python
engine is the offline implementation. Both follow the documented policy, but
are separate implementations with shared behavioral test scenarios, not a single
shared runtime. Python uses Unicode casefold; PostgreSQL uses database lower
casing. Non-ASCII case equivalences can differ; author/test aliases explicitly.

The public configuration in tie-config.js points to the existing LearnLoop
Supabase project. Its publishable key is intended for clients. No service-role
key, database password, or secret key is included.

## Python

Python 3.9+. No runtime packages or network needed for the local engine:

```sh
python3 -m learnloop_tie
python3 -B -m unittest discover -s tests -v
```

```python
from learnloop_tie import SupabaseTutor

# Obtain a current user access token through your application's Supabase Auth flow.
# The client does not handle sign-in/refresh; instantiate it with a renewed token.
tutor = SupabaseTutor(SUPABASE_URL, PUBLISHABLE_KEY, USER_ACCESS_TOKEN)
lessons = tutor.lessons()
# Generate and retain these IDs BEFORE network calls so retries are idempotent.
from uuid import uuid4
session_id, request_id = str(uuid4()), str(uuid4())
start = tutor.start(lessons[0]['id'], session_id)
feedback = tutor.submit(session_id, 'my response', request_id)
progress = tutor.resume(session_id)
```

For local structured lessons use `from_offline_modules` with records containing
`id`, `prompt`, `accepted_answers` (list of strings), `hint`, `explanation`,
`remediation`, `approved` (boolean, default false).

For the actual index.html localStorage `db.questions` format:

```python
from learnloop_tie import from_learnloop_questions

engine = from_learnloop_questions(questions, {
    'm1': {
        'hint': 'Which factors give the middle coefficient?',
        'explanation': 'Compare the sum and product of the candidate roots.',
        'remediation': 'Practice multiplying two binomials first.',
        'approved': True,
    },
    # Supply reviewed instructional text for every question passed in.
})
decision = engine.start('learner-session', 'm1')
print(decision.to_dict())
```

Only questions marked approved AND separately approved instructional records run.
The adapter accepts the correct option's text, not its letter or index. Original
quiz explanations often reveal answers; the adapter requires separately authored
instructional text. Local engines are one per learner, caller-serialized, and
in-memory. Keys remain accessible to the Python host and in the old HTML demo;
only the cloud path isolates its answer keys from clients.

## Policy and API

| Trigger | Action |
| --- | --- |
| Start or blank input | diagnose |
| First incorrect attempt | socratic_hint |
| Second incorrect attempt | explanation |
| Further incorrect attempts | remediation |
| Correct response | verification required |
| Next consecutive correct response | verification complete |
| Recognized override, unreviewed or overlapping content | blocked |

A wrong answer resets pending verification. Blank and recognized override inputs
do not consume attempts. Each decision has `action`, `message`, `reason`,
`attempt_count`, `mastered`. The mastered flag means repeated correctness on one
item, not proof of conceptual mastery, transfer, or durable learning. Progress
remains complete after later submissions. Blocked feedback cannot confer mastery.

Authenticated JSON POST endpoints under `/rest/v1/rpc/`:

| Endpoint | JSON body | Response |
| --- | --- | --- |
| tie_catalog | `{}` | reviewed lessons, published practice quizzes, publisher capability |
| tie_quiz_questions | `{p_quiz_id}` | ordered question metadata without grading keys |
| tie_publish_bank | `{p_payload}` | validated import counts; authorized educators only |
| tie_lessons | `{}` | reviewed lesson metadata |
| tie_start | `{p_session_id,p_lesson_id}` | `{session_id,decision}`; a retry also returns prompt/lesson_id |
| tie_submit | `{p_session_id,p_response,p_request_id}` | decision |
| tie_get | `{p_session_id}` | `{session_id,lesson_id,prompt,options,decision}` |
| tie_history | `{}` | latest 20 owned sessions, counts and completion |

IDs for sessions and requests are UUIDs. Reuse IDs and the exact same body after
network errors. Reusing a request ID with different text fails. Reopening the same
session does not reset progress. Starts are serialized per learner; submissions
lock the session row. State and retry records update atomically. Responses are
limited to 4000 characters; sessions to 100 per learner, requests to 200 per
session. These are storage limits, not comprehensive rate limiting. Error 54000
means a quota is exhausted; an administrator must manage retention.

## Guardrails and database setup

`supabase/tie_v01.sql` is the consolidated, one-time setup for a NEW deployment.
It has already been applied to the linked LearnLoop project, with follow-up fixes.
Do not run the setup again there. See VERIFIED_RESULTS.md for applied migration
names and verification boundaries. The private schema is not exposed by the app;
all tables have RLS and no direct anon/authenticated table privileges. Public RPC
wrappers are security invokers. Narrow security-definer implementations live in
the private schema, use an empty search_path, and check auth.uid() ownership.

For a NEW deployment, apply `supabase/tie_v01.sql`, then
`supabase/tie_bank.sql` once. Both are already installed here. The bank update
was applied as migrations `learnloop_bank_schema`, `learnloop_bank_rpc`, followed
by the content seed. Do not repeat these scripts on the existing deployment.
The import source is `content/learnloop-bank.json`.

Cloud Tutor reads approved questions through reviewed private lessons. Published
practice quizzes are shown only when every linked question is eligible, in quiz
order. Withdrawn quizzes leave the set list; approved individual questions remain
available in the bank. Editing a source question invalidates its lesson until
republished, and stale session snapshots are rejected. Each session practices one
question; this is not a formal graded quiz attempt. Recent completion indicators
cover the latest 20 sessions, not lifetime progress.

The Teacher workspace's Publish approved bank to Cloud Tutor action exports only
approved questions and published quizzes. It requires a real authenticated account
with a trusted teacher/admin profile or a verified email explicitly allowlisted
by an administrator. Demo roles and user-supplied Auth metadata grant no rights.
No owner email has been granted publishing permission. The publisher API validates
all records atomically, reuses unchanged builtin records, and rejects duplicate
options, invalid keys, and answer-revealing instructional text. Optional `tutor`
hint/explanation/remediation fields support reviewed instructions; otherwise
answer-free generic instructions are used. Original quiz explanations are never
copied into pre-answer feedback.

Guardrails normalize and check EVERY feedback message against answer aliases at
whole-token boundaries; an overlap returns a blocked decision with an empty
message. Catalog titles and free-response prompts are also filtered. Reviewed multiple-choice prompts and choice texts are stimulus and may contain the correct answer; the API never labels which choice is correct. Literal matches
handle regex metacharacters safely. The override detector recognizes a narrow
set of instruction-changing requests. Learner responses are never executed or
interpolated into messages. Hosted response text is not stored: retry records
contain a SHA-256 digest and the decision. A digest is not anonymization; the
private session snapshot still contains trusted lesson data and keys.

These checks do not detect semantic/encoded leaks or classify arbitrary harmful
content. Common-word answers can cause legitimate text to be blocked. Content
approval is an educator attestation, not an automated safety guarantee. There is
no generative model, open-ended answer grading, partial credit, or exam security.

Database advisor INFO notices about RLS without policies are expected for these
private default-deny tables; client access is solely through checked functions.
The existing public question/quiz tables also remain default-deny.
See [Supabase's explanation](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy).

## Tests

```sh
python3 -B -m unittest discover -s tests -v
node --test tests/tie-client.test.cjs
node --check tie-client.js
node --check tie-ui.js
```

A GitHub Actions workflow is included to run these checks after publishing. No Supabase credentials are needed for unit
checks. `tests/database_checks.sql` and `tests/bank_database_checks.sql` run against a configured database as admin;
it uses authenticated roles/JWT claims and rolls back all fixture accounts and
rows. Do not replace it with a test on real learner records.
`python3 -B tests/live_http_checks.py` makes read-only calls to the configured
project: checks email auth and rejects anonymous RPC access; it creates no users.

`tests/browser-smoke.cjs` requires Playwright (development only) and Chromium or
Chrome. Install Playwright in your development tooling, then:

```sh
node tests/browser-smoke.cjs
# Optional: CHROME_PATH=/path/to/chrome node tests/browser-smoke.cjs
```

The browser suite mocks cloud responses and tests login, start, replay after a
network failure, verification, resume, sign-out, token storage, mobile overflow,
and the original offline quiz flow. It is not a live account sign-in test.
Bank integration checks and limitations are in BANK_INTEGRATION_RESULTS.md.
See PUBLISHING.md for operational details.

Live signup/login/lesson verification and subsequent authentication fixes are
recorded in LIVE_E2E_RESULTS.md.
