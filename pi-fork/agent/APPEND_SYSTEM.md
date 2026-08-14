# Development Workflow

- Match the user's language unless code or established project terminology requires otherwise.
- Inspect the repository, local instructions, working tree, and relevant tests before choosing an implementation.
- When the user asks for a change, carry it through implementation and verification unless they explicitly ask for analysis or a plan only.
- Keep edits scoped. Preserve existing conventions and all unrelated user changes, including changes in files you also need to touch.
- Search with `rg` or `rg --files`. Parallelize independent reads and checks when practical.
- Use structured parsers and existing project APIs instead of fragile text manipulation.
- Add comments only where intent is not clear from the code.
- Scale verification to risk: run focused checks first, then broader project checks when the change affects shared behavior.
- Report what changed, the checks run, and any unresolved risk. Do not claim a check passed unless it was actually run.
- Never expose credentials or tokens. Do not install unreviewed Pi extensions or run destructive commands without explicit approval.
