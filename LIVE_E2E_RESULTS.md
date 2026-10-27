# Live Cloud Tutor authentication and lesson checks

Tested against https://bitvarunranjan.github.io/Learning-quiz/ on 27 October 2026,
using a dedicated alias of the user-authorized inbox and a generated test-only
password. No real user's password was requested, read or modified. No test
credentials or auth tokens are included in source, reports or screenshots.

## Reproduced and fixed

- Email confirmation returned to localhost. The user confirmed the failure;
  the Supabase dashboard showed Site URL http://localhost:3000 and no redirect
  allowlist. Site URL now uses the exact deployed LearnLoop URL, and the same
  exact URL is allowlisted. No wildcard redirects were added. Email confirmation
  remains enabled.
- Incorrect login showed only Request failed (400). The client now maps known
  Auth error codes to fixed actionable messages, with safe fallbacks. Arbitrary
  server text, email addresses and credentials are never echoed.
- Signup and confirmation resend now explicitly pass the current return page.
  Return URLs strip query/fragment data, allow HTTPS or local development only,
  and cannot contain embedded credentials.
- On return from confirmation, the app removes auth credentials/error details
  from the address bar and shows a fixed notice. It never trusts a URL fragment
  as an authenticated user session; password sign-in is still required.
- Resend confirmation works independently of the password input, allowing an
  unconfirmed learner to request a new link without entering their password.

## Executed live scenarios

- Real signup API succeeded, test account was confirmed, and password login
  loaded the approved lesson catalog.
- Blank response: diagnose, zero attempts.
- Instruction override: blocked, zero attempts.
- Incorrect attempts: Socratic hint, explanation, then remediation.
- Correct response: verification requested.
- Intervening incorrect response: verification reset.
- Two consecutive correct responses: completion, seven counted attempts.
- Logout and page reload: signed out as designed.
- Wrong password: rejected by real Auth API with invalid_credentials.
- Correct login and session resume: completion and seven attempts persisted.
- Database inspection independently confirmed the completed session state.

Automated regression coverage includes error-code sanitization, non-JSON errors,
throttling, signup/resend return URLs, invalid redirect origins, URL credential
cleanup, confirmation error notices, and the existing client/tutor behaviors.
The browser regression uses mocked cloud responses for these edge cases; it is
separate from the real-account live tests listed above. CI runs Python and Node
unit suites; browser regression is run locally in a fresh Chrome test profile.

A fresh confirmation-link round trip after deployment is verified separately
in the delivered final live-test report. This file intentionally contains no
mailbox links, test-account IDs, generated passwords, or auth credentials.
