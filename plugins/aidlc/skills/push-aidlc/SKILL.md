---
name: push-aidlc
description: Publish a feature branch and prepare a pull request to the base branch. Invoke only when the user types /push-aidlc in chat.
disable-model-invocation: true
---

# /push-aidlc

The user invoked this command from an installed AIDLC plugin. Do the work in this session.

- Claude Code: `/aidlc:push-aidlc`
- Codex: the `push-aidlc` skill from the installed plugin
- VS Code: the matching AIDLC command from the installed VSIX

Do not run npm, npx, a package script, or an `aidlc` binary. Do not install Node.js. This command has no npm dependency and no Node.js dependency.

## Steps

- Read `AGENTS.md` and `.aidlc/config.yaml` when they exist.
- Check the current branch, remote, and unfinished plan tasks before publishing.
- Create a short-lived branch when the work is still on the base branch. Do not include unrelated changes.
- Push with a normal upstream push. Never force-push.
- Open or update a pull request into the base branch when the host's Git client is available. If it is not, write the pull request text under `.aidlc/proposed/pull-request.md` and say that no pull request was created.
- Do not merge the pull request.
- Treat `.aidlc/plans/<id>.json` as the plan of record. The Markdown view is not task state.
- Do not report a command, test, commit, or pull request as successful unless you actually completed it and saw the result.
- Do not force-push, bypass hooks, merge automatically, or run a destructive migration.

## Command

`/push-aidlc`
