---
description: Enter full workflow mode; read-only analysis → plan → implement (parallel workers gated) → review loop → minimal verify → capture lessons
argument-hint: "<task/goal>"
---
You are in WORKFLOW MODE. Task: $@

This workflow is AUTHORITATIVE. It takes precedence over normal chit-chat, free-form polish, or incremental improvements. You must execute it in strict order.

########################################
## Global rules
########################################
- No editing unless you are in the STEP assigned to editing.
- Read-only steps MUST NOT call write/edit.
- Write/edit steps MUST NOT touch protected paths (locatrix chart, .git, auth.json, .env, play_controller.gd, etc.).
- Never restart or degrade existing user work (“survive my own edits”).
- For model/tool routing: subagents use `agent` from `~/.pi/agent/agents/*`; follow their tool constraints.
- Subagents may call `deliver(title, content, urgent?)` to proactively push blockers/critical findings into the main session (urgent:true triggers a follow-up turn). Use sparingly.
- Before delegating fuzzy tasks, consider `optimize_prompt` (independent model via `promptOptimizerModel` in `~/.pi/agent/subagent-config.json`), or set `optimizePrompt: true` on the subagent call.
- Never print secrets, tokens, or private credentials.
- Keep these workflow artifacts separate:
  - **Goal**: one stable, self-contained outcome; update it only when the user changes the objective.
  - **Todo**: the live execution checklist; maintain status with `todo_write`, not by rewriting the approved plan.
  - **Approved Plan**: the immutable scope contract for files, commands, risks, and rollback; submit a new revision only when scope changes.
- Workflow ends only when verification passes and capture is approved (or user aborts).

########################################
## Phase markers
########################################
You SHOULD keep these phrases in your reasoning so audit/status tools can trace:
- **Phase plan** (you only analyze/spec)
- **Phase active** (ONLY validation-reviewed write happens) 
- **Phase review** (read-only review; you inspect a diff)
- **Phase verify** (run minimum checks; label outcomes honestly)
- **Phase capture** (write only `~/.pi/agent/knowledge/<scope>.md`)

**Phase switching**: you (the orchestrator) MUST call the `audit_set_phase` tool (when available) when entering each phase (plan → active → review → verify → capture). The statusline shows the current phase. If a subagent's configured model fails (429/unknown), use `subagent_set_model` to temporarily reroute it to an available model (session-scoped).

########################################
## Step 0 — Optimize (read-only)
Use `subagent` with `agent: "prompt-critic"` to convert the user input into a canonical spec (JSON only). If `score < 8` or openQuestions is materially blocking, run `prompt-critic` again once on the original query (same input).

Store final canonical spec as `SPEC` (short). Do not preserve long prose.

Then anchor the session goal to the SPEC (Codex-style truncation anchor): call `update_goal` with `objective` = the SPEC goal sentence only. Keep approval scope/files in the Plan, not in the Goal. If a matching goal already exists, skip resetting it. Keep the Goal ≤ 2 lines and self-contained: it is the ONLY context guaranteed to survive compaction.

########################################
## Step 1 — Read-only scout
Use `subagent` with `agent: "scout"` to gather only indispensable files, key code, and invariants. Scout/agent MUST NOT edit.
If you suspect the task spans multiple areas, split into 2 read-only parallel scouts, but never before hat SPEC is clear.

########################################
## Step 2 — Deep-think plan (read-only)
Use `subagent` with `agent: "planner"` on `{previous}` context (SPEC + scout notes). Planner MUST output:
1) Goal
2) Plan steps (numbered, each <= 1 file edit)
3) Files to Modify
4) New Files (if any)
5) Risks
6) Decision Point sentence: “Proceed with implementation using this plan? (yes/no)”

The Plan is an approval contract, not a progress checklist. After structured approval, initialize the live checklist with `todo_write`; update todo status as work proceeds without rewriting the Plan unless files, commands, or scope change.

STOP if user rejects.

########################################
## Step 3 — Implement (write-capable ONLY after approval)
Only after `workflow_approve_plan` approves the current `planHash` and `revision`, and you have entered **Phase active**, launch `worker` (subagent) per approved plan step. Natural-language “yes” alone is not structured authorization.
- Keep changes strictly inside approved files.
- Before implementation, create/update a `todo_write` checklist whose items mirror the approved Plan steps.
- Mark checklist items as completed or blocked as work proceeds; do not create Plan revisions merely to record progress or command output.
- If plan has >1 independent edits, run them sequentially unless the plan explicitly states “safe parallel”.
- Each `worker` run should show exit + diff summary (via output).

########################################
## Step 4 — Review loop (read-only)
Immediately call `reviewer` with `git diff`/current workspace state. Reviewer MUST output structured findings:
- Critical (must fix) | file:line | impact | 
- Warnings (should fix) | file:line | impact
- Suggestions (consider) | file:line | impact
- Summary (pass/fail + residual risk)

If Critical exist → run `worker` once per critical item (or rework SPEC once), then immediately re-review.

Max 3 review-rework rounds unless user aborts.

########################################
## Step 5 — Verify (minimal)
Run the smallest affordable checks from `tools/VALIDATE_INDEX.md` scoped to changes:
- path/type-labeled, not “implied” passes
- only report “passed” when command actually ran
- if fails: fix once by edit/write inside approved scope, then re-verify

########################################
## Step 6 — Capture lessons (write-only after success)
Only after verify has `passed`, call `capture-lesson` with the right scope (locatrix / pi / generic). If scope未达到, skip.
It appends a compact entry to `~/.pi/agent/knowledge/<scope>.md`.

########################################
## Output format on completion
- Outcome (what changed, why)
- Files changed (each with one-line reason)
- Verification results (exact commands + labels: passed/failed/partial/not run/blocked)
- Residual risks (what remains to watch)
- Rollback path (how to reverse, or notes if capture was rejected)

########################################
## Usage of side-channel /btw
You may insert ONLY ONE `btw:` clarification when current step lacks a critical value and the context size is large. Max 2 sentences. Example: `btw：确认本次变更不需要同步 Zed extension rev`. Do NOT ask multi-part choices, do NOT pause for >1 minute, and do NOT use it to re-enter user numbering.
