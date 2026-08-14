# generic knowledge

## 2026-08-14: PR review-response lessons (dynamic pricing PR #82)

1. Agent .md frontmatter "Unknown agent" root cause was a MISSING closing "---" delimiter (parseFrontmatter returns {} silently → agent skipped by loadAgentsFromDir), not the model field. Fix: insert second "---" after the last frontmatter key. Diagnostic: node -e "require('/home/xubuntu/.local/npm-prefix/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js').parseFrontmatter(fs.readFileSync(file,'utf8'))" — empty {} vs parsed keys.
2. workflow-audit gating applies to custom registerTool tools too: new tools must be added to ALL PHASE_TOOLS sets or they self-lock. edit/write are blocked in plan/review — move to active via audit_set_phase tool before editing. capture phase blocks subagent entirely (write knowledge via bash instead).
3. GitHub anti-slop (peakoss/anti-slop v0.2.1, pr-check.yml): require-description + require-pr-template + strict section string; the strict string "✅ 提交前检查项 / Checklist" may NOT literally appear in the template (lenient match, pr-quality passed anyway); require-linked-issue commented out (not enforced); detect-spam-usernames + min-account-age 30 (account age matters).
4. Maintainer demanded REAL test output (go test -p 2 ./..., go vet ./..., gofmt -l .), CI links, commit SHA, and NO checklist items without evidence. Reviewer found 3 overclaims (Redis-restore clamp test, per-call billing test, config validation) — all genuinely missing; had to ADD tests + re-push (commit 61bf1b9) + re-verify + update description. Lesson: grep for claimed test names before writing them into a PR description; maintainers DO check.
5. gofmt -l . on upstream repo flags controller/finance_export.go — pre-existing, NOT in the PR; must be disclosed, never auto-formatted.
6. CI pre-existing failures (Rust, AUR) confirmed by checking the SAME job names on upstream main commit via GitHub API (commits/{sha}/check-runs).
7. PR was ~47 commits behind upstream main — disclosed in description; rebase left as explicit follow-up.
8. Local staging worktree already contained the PR content as uncommitted A/M changes identical to 77d1e68 (git diff 77d1e68 empty) — verify with git diff before assuming fetch/checkout needed.
