---
name: audit-aidlc
description: Write a brief plan audit to CHANGELOG.md at the repository root. Invoke only when the user types /audit-aidlc in chat.
disable-model-invocation: true
---

# /audit-aidlc

The user invoked this command from an installed AIDLC plugin. Do the work in this session.

- Claude Code: `/aidlc:audit-aidlc`
- Codex: the `audit-aidlc` skill from the installed plugin
- VS Code: the matching AIDLC command from the installed VSIX

Do not run npm, npx, a package script, or an `aidlc` binary. Do not install Node.js. This command has no npm dependency and no Node.js dependency.

## Steps

- Read `AGENTS.md` and `.aidlc/config.yaml` when they exist.
- Write or update `CHANGELOG.md` at the repository root.
- Include each active and archived plan with its id, title, status, and a short requirement.
- Replace only the managed audit section. Keep any other changelog text.
- Do not invent plans that are not on disk.
- Treat `.aidlc/plans/<id>.json` as the plan of record. The Markdown view is not task state.
- Do not report a command, test, commit, or pull request as successful unless you actually completed it and saw the result.
- Do not force-push, bypass hooks, merge automatically, or run a destructive migration.

## Command

`/audit-aidlc`
