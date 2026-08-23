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
  - **Todo**: the live execution checklist; maintain status with `workflow(action=todo_write)` (legacy alias `todo_write`), not by rewriting the approved plan.
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

**Phase switching**: you (the orchestrator) MUST call `workflow(action=phase_set)` (legacy alias `audit_set_phase`, when available) when entering each phase (plan → active → review → verify → capture). The statusline shows the current phase. If a subagent's configured model fails (429/unknown), use `subagent_set_model` to temporarily reroute it to an available model (session-scoped).

########################################
## Step 0 — Normalize (read-only)
The orchestrator should convert the user request directly into a short canonical `SPEC`; do not call `prompt-critic` by default.

Only when ambiguity materially blocks scope or acceptance criteria, choose exactly one bounded aid: either one `llm_query` **or** one `prompt-critic` subagent. Never call both for the same request, and never use either for repository exploration.

Store final canonical spec as `SPEC` (short). Do not preserve long prose.

Then anchor the session goal to the SPEC (Codex-style truncation anchor): call `workflow(action=goal_set)` (legacy alias `update_goal`) with `objective` = the SPEC goal sentence only. Keep approval scope/files in the Plan, not in the Goal. If a matching goal already exists, skip resetting it. Keep the Goal ≤ 2 lines and self-contained: it is the ONLY context guaranteed to survive compaction.

########################################
## Step 1 — Read-only scout
Use `subagent` with `agent: "scout"` only when the relevant files or invariants are not already known. A scout is read-only and should return compressed findings; for a small, familiar change, the orchestrator may inspect directly and skip this LLM call.
If the task spans clearly independent areas, use at most two read-only scouts in parallel, with disjoint scopes.

########################################
## Step 2 — Deep-think plan (read-only)
For multi-file, security-sensitive, concurrency-sensitive, or uncertain tasks, use `subagent` with `agent: "planner"` once on `{previous}` context (SPEC + scout notes). For small, well-understood tasks, the orchestrator may write the plan directly without another LLM call. If used, Planner MUST output:
1) Goal
2) Plan steps (numbered, each <= 1 file edit)
3) Files to Modify
4) New Files (if any)
5) Risks
6) Scope/risk summary for `workflow_submit_plan`; do not treat planner prose or natural-language “yes” as approval.

The Plan is an approval contract, not a progress checklist. After structured approval, initialize the live checklist with `workflow(action=todo_write)`; update todo status as work proceeds without rewriting the Plan unless files, commands, or scope change.

STOP if user rejects.

########################################
## Step 3 — Implement (write-capable ONLY after approval)
Only after `workflow_approve_plan` approves the current `planHash` and `revision`, and you have entered **Phase active**, implement the approved steps. For small local edits the orchestrator may write directly; use one `worker` only when delegation materially helps or the plan has independent bounded work. Natural-language “yes” alone is not structured authorization.
- Keep changes strictly inside approved files.
- Before implementation, create/update a `workflow(action=todo_write)` checklist whose items mirror the approved Plan steps.
- Mark checklist items as completed or blocked as work proceeds; do not create Plan revisions merely to record progress or command output.
- For parallel subagent tasks, provide disjoint `scope` roots; set `readOnly: true` only when the task performs no writes. Overlapping mutation scopes are serialized.
- For long independent work, `background: true` returns immediately with a job id; continue the main task, then inspect `subagent_jobs` or consume the completion follow-up. Use `subagent_cancel` when the result is no longer needed. Background work is still bounded by declared scope and is cancelled when the parent session shuts down.
- Each `worker` run should show exit + diff summary (via output).

########################################
## Step 4 — Review loop (read-only)
For security, authentication, permissions, concurrency, migrations, public API, or unresolved uncertainty, call `reviewer` once with `git diff`/current workspace state. For ordinary low-risk changes, the orchestrator may perform the structured read-only review directly. Do not add an `llm_query` or `optimize_prompt` call merely to duplicate a review.
Reviewer MUST output structured findings:
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

########################################
## Async subagent dispatch (detached background jobs)
For long, independent work (scout/planner/reviewer on large or unfamiliar scope), launch with `background: true`: the call returns immediately with a job id; continue the orchestrator's current step, then consume the completion follow-up or poll `subagent_jobs`. Use `subagent_cancel` when the result is no longer needed. Do NOT use background for sequential chains (scout-and-plan / implement / implement-and-review) — those pass output via {previous} and must stay synchronous. Background jobs are bounded by declared scope and cancelled on parent session shutdown.

