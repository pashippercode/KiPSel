---
description: Generate a changelog from git history
argument-hint: "[tag range, e.g. v1.0..HEAD]"
---
Generate a changelog for ${ARGUMENTS:-the unreleased changes since the last tag}. Find the range with `git tag` / `git log`; if the repo has no git history, fall back to summarizing recent file changes by modification time. Group entries by type (Features, Fixes, Refactors, Docs, Chores), keep lines short and user-facing, and state the exact git command used. Do not edit files.
