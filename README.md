# LearnLoop Integrated MVP Demo v0.1

Open `index.html` in Chrome or Safari on a computer. It runs locally without installation, a server, or an API key. Select **Teacher** to import `example_import.json`, approve imported questions, and publish a quiz; select **Student** to attempt it; then select **Analytics** to inspect separate practice and exam metrics.

Included: seeded school, competitive exam, and skills questions; JSON import validation for Sprint 1 schema; teacher review queue; subject-based quiz creation; untimed practice with feedback; timed exam with auto-submission while page remains open; simple rule-based adaptive question ordering using previous practice accuracy; local analytics; admin content overview.

**Prototype limitations:** browser-only localStorage (not cloud synced), no login or role security, no reliable background timing if tab/device sleeps, no production-grade adaptive psychometrics, no server-side scoring, no accessibility/security audit, and no real multiuser deployment. Do not use for consequential examinations or sensitive student data. The next production stage is to connect Supabase Auth, Postgres/RLS, a server-authoritative exam service, and persistent analytics.
