---
name: commit-aidlc
description: Commit scoped changes with secret and unrelated-file checks. Invoke only when the user types /commit-aidlc in chat.
disable-model-invocation: true
---

# /commit-aidlc

The user invoked this command from an installed AIDLC plugin. Do the work in this session.

- Claude Code: `/aidlc:commit-aidlc`
- Codex: the `commit-aidlc` skill from the installed plugin
- VS Code: the matching AIDLC command from the installed VSIX

Do not run npm, npx, a package script, or an `aidlc` binary. Do not install Node.js. This command has no npm dependency and no Node.js dependency.

## Steps

- Read `AGENTS.md` and `.aidlc/config.yaml` when they exist.
- Inspect the branch, staged files, unstaged files, and untracked files.
- Stage only files that belong to the approved plan. Leave secrets, environment files, and unrelated user edits unstaged.
- Create a normal commit with a Conventional Commit subject. Do not amend, force-push, or skip hooks.
- Refuse the commit when a required quality gate failed, unless the user explicitly authorizes an exception and you record that exception on the plan.
- Store the commit hash on the plan after the commit succeeds.
- Treat `.aidlc/plans/<id>.json` as the plan of record. The Markdown view is not task state.
- Do not report a command, test, commit, or pull request as successful unless you actually completed it and saw the result.
- Do not force-push, bypass hooks, merge automatically, or run a destructive migration.

## Command

`/commit-aidlc`
