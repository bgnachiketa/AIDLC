---
name: plan-aidlc
description: Create or resume an implementation plan before changing application code. Invoke only when the user types /plan-aidlc in chat.
disable-model-invocation: true
---

# /plan-aidlc

The user invoked this command from an installed AIDLC plugin. Do the work in this session.

- Claude Code: `/aidlc:plan-aidlc`
- Codex: the `plan-aidlc` skill from the installed plugin
- VS Code: the matching AIDLC command from the installed VSIX

Do not run npm, npx, a package script, or an `aidlc` binary. Do not install Node.js. This command has no npm dependency and no Node.js dependency.

## Steps

- Read `AGENTS.md` and `.aidlc/config.yaml` when they exist.
- Inspect the relevant code, tests, and existing `.aidlc/plans/*.json` files.
- Write a schema-valid plan under `.aidlc/plans/` and point `.aidlc/state/active-plan.json` at it. Do not edit application source.
- Ask only when a missing fact changes scope, behavior, data safety, security, or acceptance criteria.
- Leave the plan in `needs-clarification` or `awaiting-approval`. Do not mark it approved unless the user approves it in chat.
- If an equivalent plan already exists, resume it. Do not replace an unrelated active plan.
- Treat `.aidlc/plans/<id>.json` as the plan of record. The Markdown view is not task state.
- Do not report a command, test, commit, or pull request as successful unless you actually completed it and saw the result.
- Do not force-push, bypass hooks, merge automatically, or run a destructive migration.

## Command

`/plan-aidlc`
