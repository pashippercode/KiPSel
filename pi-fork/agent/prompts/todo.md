---
description: Scan the repo for TODO/FIXME markers and triage them
argument-hint: "[path or scope]"
---
Scan ${ARGUMENTS:-the current repository} for TODO, FIXME, HACK, and XXX markers using `rg`. Group the findings by file, classify each as actionable / stale / critical (with a one-line reason), and propose a short fix suggestion for the top few. Do not edit files unless asked.
