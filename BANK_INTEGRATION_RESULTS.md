# Question bank integration verification

- Imported 8 existing approved questions and 4 published quizzes into Supabase.
- Cloud catalog exposes 3 practice quizzes; timed exams remain separate.
- Python: 39 tests passed. Browser client: 19 tests passed.
- Mocked Chrome regression passed: authentication, MCQ validation/grading,
  next question, resume, retries, mobile layout, offline quiz compatibility;
  no uncaught page errors.
- Both database suites passed using authenticated roles and rollback fixtures.
  Checked answer-field redaction, quiz order, answer zero, verification, revoked
  and changed content, cross-user isolation, forged role rejection, publisher
  validation, idempotent import and atomic rollback on invalid imports.
- Owner publisher access was not granted. The allowlist remains empty.

Initial builtin questions also exist in the public offline HTML; this import
provides guided practice, not secure exam content. Multiple-choice options are
visible stimulus, while server grading fields are excluded from tutor responses.
Recent progress covers 20 sessions; sessions practice individual questions.
