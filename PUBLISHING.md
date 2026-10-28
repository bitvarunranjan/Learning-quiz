# Publishing and operating LearnLoop

The app is hosted on GitHub Pages from main at
https://bitvarunranjan.github.io/Learning-quiz/ . Supabase provides Auth,
question/quiz storage and transactional tutor RPCs. No Python server is required.

Do not rerun the one-time SQL scripts on the linked project. New installations
apply tie_v01.sql then tie_bank.sql. Changes should use reviewed additive
migrations and run both database check scripts with rollback fixtures.

Publisher permission is a separate administrative decision. The current email
allowlist is empty. Demo Teacher/Admin login does not authorize cloud publishing.
Only approved content and published quizzes are exported; attempts, local users,
passwords and tokens are excluded. Learners can practice the imported content
without publisher permission.

GitHub connector writes were unavailable; publishing uses the signed-in GitHub
browser session. This does not configure native Git credentials. Never paste
service-role keys, passwords or tokens into source or chat.
