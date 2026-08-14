---
description: Review current changes for defects and regressions
argument-hint: "[scope]"
---
Review ${ARGUMENTS:-the current working tree changes}. Inspect the relevant surrounding code and tests.

Lead with concrete findings ordered by severity. For each finding, include a file and line reference, impact, and a concise fix direction. Focus on correctness, security, behavioral regressions, concurrency, error handling, and missing tests. Do not edit files unless I ask. If there are no findings, say so and list remaining test gaps or residual risk.
