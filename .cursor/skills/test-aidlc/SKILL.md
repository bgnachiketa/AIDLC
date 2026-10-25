---
name: test-aidlc
description: Run discovered validation commands and store their results. Invoke only when the user types /test-aidlc in chat.
disable-model-invocation: true
---

# /test-aidlc

The user invoked this command from an installed AIDLC plugin. Do the work in this session.

- Claude Code: `/aidlc:test-aidlc`
- Codex: the `test-aidlc` skill from the installed plugin
- VS Code: the matching AIDLC command from the installed VSIX

Do not run npm, npx, a package script, or an `aidlc` binary. Do not install Node.js. This command has no npm dependency and no Node.js dependency.

## Steps

- Read `AGENTS.md` and `.aidlc/config.yaml` when they exist.
- Run the validation commands already recorded in `.aidlc/config.yaml`, or the scripts already present in the repository. Do not install AIDLC and do not add a test runner.
- Record pass, fail, or not-run on the active plan, including a short failure summary.
- A command that did not run is not a pass. Keep a failed or skipped required check visible.
- Do not replace the repository's test framework.
- Redact secrets before writing evidence.
- Treat `.aidlc/plans/<id>.json` as the plan of record. The Markdown view is not task state.
- Do not report a command, test, commit, or pull request as successful unless you actually completed it and saw the result.
- Do not force-push, bypass hooks, merge automatically, or run a destructive migration.

## Command

`/test-aidlc`
