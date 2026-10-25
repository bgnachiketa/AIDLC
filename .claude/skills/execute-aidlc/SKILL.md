---
name: execute-aidlc
description: Advance the approved plan and record real task evidence. Invoke only when the user types /execute-aidlc in chat.
disable-model-invocation: true
---

# /execute-aidlc

The user invoked this command from an installed AIDLC plugin. Do the work in this session.

- Claude Code: `/aidlc:execute-aidlc`
- Codex: the `execute-aidlc` skill from the installed plugin
- VS Code: the matching AIDLC command from the installed VSIX

Do not run npm, npx, a package script, or an `aidlc` binary. Do not install Node.js. This command has no npm dependency and no Node.js dependency.

## Steps

- Read `AGENTS.md` and `.aidlc/config.yaml` when they exist.
- Load the active plan JSON. Stop when it is missing, cancelled, waiting for clarification, or not approved.
- Advance the next ready task in this session. Inspect the code, make the smallest change that task allows, and record evidence on the plan.
- Do not invent test results. A verify step is complete only after the project's existing command exits successfully.
- Resume by stable task id. Do not repeat a completed task.
- Stop and report the blocker when a required check fails outside the approved scope.
- Treat `.aidlc/plans/<id>.json` as the plan of record. The Markdown view is not task state.
- Do not report a command, test, commit, or pull request as successful unless you actually completed it and saw the result.
- Do not force-push, bypass hooks, merge automatically, or run a destructive migration.

## Command

`/execute-aidlc`
