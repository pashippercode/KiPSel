---
description: Debug a failure with evidence, then fix it
argument-hint: "<symptom>"
---
Debug this failure: $ARGUMENTS

1. Reproduce it first with the narrowest command that shows the symptom.
2. Inspect the relevant code path, recent changes (`git diff`, `git log -p` if available), and error output before theorizing.
3. State the root cause with evidence, then apply the minimal fix.
4. Re-run the reproduction to confirm, and report the exact commands and before/after outcome.
