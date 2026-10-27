# Publishing and operating this integration

The Supabase backend is installed in the existing LearnLoop project. Do not
rerun supabase/tie_v01.sql there. The browser/Python integration is on the
feat/learnloop-tie-v01 review branch of bitvarunranjan/Learning-quiz.
Review the pull request and its checks before merging into main. This change
has not been merged or deployed as a website.

The GitHub connector returned HTTP 403 for writes and reports no app
installation. Publishing used the user's authenticated GitHub browser session;
that does not configure native Git credentials or grant connector access.
Future automated pushes need a properly authorized GitHub App connection or
an authenticated Git installation. Do not send passwords or tokens in chat.

For local development:

```sh
git clone --branch feat/learnloop-tie-v01 https://github.com/bitvarunranjan/Learning-quiz.git
cd Learning-quiz
python3 -B -m unittest discover -s tests -v
node --test tests/tie-client.test.cjs
python3 -m http.server 8000
```

Open localhost:8000, then Cloud Tutor. It points to the existing configured
Supabase backend. The source ZIP contains the same files; its patch was prepared
against main commit 869faa8a9c6ed4f1134f4efbb760834b49058072. If applying the patch
to a separate clone, use git am and resolve any conflicts instead of force-pushing.

Cloud tutor sessions use real authentication. The old demo login, question bank,
exams and analytics remain local. Do not rerun database setup in the existing
project, or replace its published tutor data with test fixtures.
