# Verified integration results — 27 October 2026

## Scope and remote state

Source inspected: bitvarunranjan/Learning-quiz main commit
869faa8a9c6ed4f1134f4efbb760834b49058072. The existing app has three files and
uses localStorage/demo roles. Its question bank and quiz analytics remain local.
The Python module is now in this repository, with a local question-shape adapter
and a Supabase RPC client. Hosted execution is PostgreSQL, not Python hosting.

LearnLoop Supabase project: oxsztvxpwuwlkowlgtwk (existing project).
Applied migrations via the connected Supabase tool:

- learnloop_tie_v01: private tables, functions, grants, sample lesson.
- learnloop_tie_normalization_fix: repaired an ambiguous SQL variable found by
  the first database test run.
- learnloop_tie_blocked_progress_guard: blocked feedback cannot confer mastery.

supabase/tie_v01.sql consolidates the final schema for fresh setup. It is not an
idempotent script to rerun on the existing project. No Supabase CLI was installed;
these changes used the connector's migration tool rather than invented CLI
migration filenames. Existing application tables and Auth settings were unchanged.

## Executed verification

- Python 3.9.6: **38 tests passed**, no skips. Covers all tutor actions, edge cases,
  output guards, existing LearnLoop shape adapter, Supabase client request/auth
  handling, and sanitized transport errors. Python demo and compilation passed.
- Node 24.22.1: **10 client tests passed**, no skips. Covers credential validation,
  sign-in, RPC requests, refresh, expiry, sign-out failures, confirmation signup,
  route allowlisting, and sanitized errors. JavaScript syntax checks passed.
- Headless Chrome/Playwright: browser smoke passed with MOCKED cloud responses.
  Exercises sign-in, lesson start, lost-response retry preserving UUID/body,
  verification, session resume, sign-out, no tokens in web storage, original
  offline quiz completion, and 390px mobile overflow. No uncaught page errors.
- Actual Supabase database: tests/database_checks.sql passed under authenticated
  roles/JWT claims. Covers state transitions, exact grading, no expression eval,
  verification reset, retry conflicts, Unicode normalization, answer overlap,
  private table/helper denial, cross-user read/write/start denial, unapproved and
  revoked content, input length and null validation, and ownership of history.
  All synthetic auth users, lessons, sessions and requests were rolled back.
- Actual HTTPS API: Auth settings returned HTTP 200 and email auth is enabled.
  All five tutor RPCs rejected anonymous requests with HTTP 401. These checks
  created no accounts and sent no email.
- Post-test database: one sample lesson, zero sessions, zero requests, zero
  synthetic @example.invalid accounts. Existing question/quiz tables are empty.
- Security advisor: INFO only, RLS enabled without policies. Three pre-existing
  notices for the original tables, three intentional default-deny private tables.
  There were no warning/error findings in the returned security advisor report.
  Client table privileges are revoked; access is through ownership-checked RPCs.
  Remediation background: https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy

The default Playwright browser binary was absent; the tests used installed
Chrome in a fresh headless profile. Browser launch and live HTTP verification
needed execution outside the restricted sandbox. No existing browser profile
was accessed. The changelog Markdown endpoint could not be fetched, so the
current official HTML changelog and database authorization documentation were
reviewed. Explicit function grants avoid relying on automatic API exposure.

## Verification limits

No real user email/password sign-in, email delivery, or confirmation-link flow
was exercised end to end. Browser auth behavior was mocked; backend authenticated
behavior used database role/JWT simulation. Concurrency is guarded by transaction
locks, but no concurrent load benchmark was run. Supabase quotas have not been
exhaustion-tested. SQL and Python Unicode case mapping differ outside the tested
aliases; explicitly author/test aliases for supported languages. No full content
safety classifier, semantic answer leak detector, or transfer assessment exists.

GitHub connector branch/tree writes returned HTTP 403 and native Git initially
had no stored credentials. After the user signed in, the review branch
feat/learnloop-tie-v01 was created and the files published through GitHub's
browser upload interface. No connector installation or extra access grants were
added. Main is unchanged; the review branch is the integration publication.
The included workflow runs unit tests when pushed and on pull requests; current
remote results are available in the repository's Actions/Checks pages.

The Supabase additions above are live. No GitHub Pages/hosting deployment or
production launch is claimed. All 13 deployed TIE function bodies were compared
with the consolidated SQL source by body hash and matched. The ZIP's extracted
copy passed the same Python and Node suites, and its CRC integrity check passed.
