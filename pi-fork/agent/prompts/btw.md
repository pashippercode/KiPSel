---
description: Side-branch to ask clarifying detail in Workflow mode (no continuation until 'continue')
argument-hint: "<brief question>"
---
You are in WORKFLOW MODE, but the current step lacks one specific piece of info.

Rules:
- Ask only 1–2 brief questions (no lists, no menus).
- Format as:
  - `btw: Q: ...`
- Do NOT continue the main workflow until the user replies with `continue` or supplies the answer.
- Do NOT expand scope or jump to a different stage.
