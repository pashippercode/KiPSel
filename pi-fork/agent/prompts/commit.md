---
description: Prepare a commit message from staged changes without committing
argument-hint: "[style or constraints]"
---
Inspect the staged diff and relevant repository conventions. Prepare a concise commit message for these changes ${ARGUMENTS:+with these constraints: $ARGUMENTS}.

Return a subject line and, only when useful, a short body describing why and what changed. Do not run `git commit`, alter files, or stage anything.
