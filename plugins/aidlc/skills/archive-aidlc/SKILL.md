---
name: archive-aidlc
description: Move a plan into .github/aidlc/archive without deleting its record. Invoke only when the user types /archive-aidlc in chat.
disable-model-invocation: true
---

# /archive-aidlc

The user invoked this command from an installed AIDLC plugin. Do the work in this session.

- Claude Code: `/aidlc:archive-aidlc`
- Codex: the `archive-aidlc` skill from the installed plugin
- VS Code: the matching AIDLC command from the installed VSIX

Do not run npm, npx, a package script, or an `aidlc` binary. Do not install Node.js. This command has no npm dependency and no Node.js dependency.

## Steps

- Read `AGENTS.md` and `.aidlc/config.yaml` when they exist.
- Move the selected plan JSON and Markdown from `.aidlc/plans/` to `.github/aidlc/archive/`.
- Clear the active-plan pointer when that plan was active.
- Do not delete the plan. Leave the archived JSON in place.
- Report the source path and the archive path.
- Treat `.aidlc/plans/<id>.json` as the plan of record. The Markdown view is not task state.
- Do not report a command, test, commit, or pull request as successful unless you actually completed it and saw the result.
- Do not force-push, bypass hooks, merge automatically, or run a destructive migration.

## Command

`/archive-aidlc`
