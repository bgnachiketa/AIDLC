---
name: aidlc
description: Index of AIDLC lifecycle skills. Use before non-trivial repository changes.
---

# AIDLC

Shared lifecycle state lives in `.aidlc/` and is safe to use from Claude Code, Codex, Cursor, VS Code, or a plain terminal.

| Action | Chat command |
| --- | --- |
| Explain AIDLC commands, safety rules, and host setup. | `/help-aidlc` |
| Create or resume a schema-validated implementation plan before changing application code. | `/plan-aidlc` |
| Detect the repository and generate host instructions without duplicating user-authored files. | `/init-aidlc` |
| Validate the active plan and advance the next ready task. Record evidence; do not invent code or test results. | `/execute-aidlc` |
| Run the repository's real validation commands and store pass, fail, or not-run evidence. | `/test-aidlc` |
| Create a scoped commit that excludes secrets and unrelated files. | `/commit-aidlc` |
| Push a feature branch and open or update a pull request targeting the base branch. | `/push-aidlc` |

These are chat slash commands. They do not require npm or an `aidlc` package.

Technology skills are added only for stacks detected in this repository.
