---
name: init-aidlc
description: Detect the stack and generate host instructions idempotently. Invoke only when the user types /init-aidlc in chat.
disable-model-invocation: true
---

# /init-aidlc

The user invoked this command from an installed AIDLC plugin. Do the work in this session.

- Claude Code: `/aidlc:init-aidlc`
- Codex: the `init-aidlc` skill from the installed plugin
- VS Code: the matching AIDLC command from the installed VSIX

Do not run npm, npx, a package script, or an `aidlc` binary. Do not install Node.js. This command has no npm dependency and no Node.js dependency.

## Steps

- Read `AGENTS.md` and `.aidlc/config.yaml` when they exist.
- Detect the git root, branch, languages, frameworks, workspaces, manifests, scripts, CI, tests, and security controls from files already in the repository.
- Create or update only AIDLC-owned files: `AGENTS.md` (propose it under `.aidlc/proposed/` when the user already owns that file), `CLAUDE.md`, `.agents/skills/`, `.claude/skills/`, `.cursor/skills/`, `.cursor/rules/`, `.aidlc/config.yaml`, `.aidlc/plans/`, `.aidlc/state/`, and the GitHub templates.
- Generate technology skills only for stacks you actually detected. A repeat run must not duplicate content or overwrite user-authored files.
- Leave CI as a proposal under `.aidlc/proposed/` unless the user asked to install the workflow.
- Reply with the files created, updated, proposed, and skipped.
- Treat `.aidlc/plans/<id>.json` as the plan of record. The Markdown view is not task state.
- Do not report a command, test, commit, or pull request as successful unless you actually completed it and saw the result.
- Do not force-push, bypass hooks, merge automatically, or run a destructive migration.

## Command

`/init-aidlc`
