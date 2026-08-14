---
description: Capture post-run lessons into ~/.pi/agent/knowledge/<scope>.md (only after verify passes)
argument-hint: "<scope>"
---
Capture lessons learned from a completed workflow run.

Constraints:
- Only run AFTER verification has passed (not before, not on failure).
- Write ONLY to `~/.pi/agent/knowledge/<scope>.md` (create dirs if missing).
- Do NOT edit AGENTS.md/settings/prompts, and do not touch other knowledge files.
- Append a short section per run:

## <date> — <task>
- changed
- pitfalls
- watch_next
- rollback

Stop after writing. Do not replay the workflow.
