<!-- aidlc:managed agents -->
# Agent instructions

This repository uses AIDLC. The same plan, standards, and quality gates apply in Claude Code, Codex, Cursor, VS Code, and the terminal.
`.aidlc/plans/*.json` is the plan of record. Do not treat a Markdown checkbox as task state.
Host files such as `CLAUDE.md`, `.cursor/rules`, and `.agents/skills` point here. If they disagree, this file wins for shared policy and the host skill wins only for how to invoke a command.

## Lifecycle

Inception: `/init-aidlc`, then `/plan-aidlc`. Wait for approval before construction.
Construction: `/execute-aidlc`, `/test-aidlc`, `/commit-aidlc`.
Operation: `/push-aidlc`, `/archive-aidlc`, `/audit-aidlc`.

Invoke these from the chat window. They are not npm scripts and they do not add a package dependency.
A coding agent may edit application code while executing an approved task. Do not invent that edit or a passing test.

## Safety

- Preserve unrelated user changes and pre-existing dirty files.
- Do not stage secrets, credentials, or environment files.
- Do not force-push, skip hooks, bypass branch protection, or merge a pull request.
- Do not run a destructive database operation unless the plan and the user explicitly allow it.
- Do not claim a command succeeded when it was not run or it failed.
- Do not weaken a security control to make a check pass.

## Repository

- Node.js (high, application) in ., extensions/vscode, packages/aidlc

Project directories: ., extensions/vscode, packages/aidlc

## Commands

- `.` lint: `npm run lint` (package.json scripts.lint)
- `.` typecheck: `npm run typecheck` (package.json scripts.typecheck)
- `.` test: `npm run test` (package.json scripts.test)
- `.` build: `npm run build` (package.json scripts.build)
- `extensions/vscode` lint: `npm run lint` (package.json scripts.lint)
- `extensions/vscode` typecheck: `npm run typecheck` (package.json scripts.typecheck)
- `extensions/vscode` test: `npm run test` (package.json scripts.test)
- `extensions/vscode` build: `npm run build` (package.json scripts.build)
- `packages/aidlc` lint: `npm run lint` (package.json scripts.lint)
- `packages/aidlc` typecheck: `npm run typecheck` (package.json scripts.typecheck)
- `packages/aidlc` test: `npm run test` (package.json scripts.test)
- `packages/aidlc` build: `npm run build` (package.json scripts.build)

## Skills

- `nodejs` in `.agents/skills/aidlc-nodejs/SKILL.md` and `.claude/skills/aidlc-nodejs/SKILL.md`

## Quality gates

Required: test.
Optional: lint, typecheck, build.

## Trunk-based development

- Integrate through `main`.
- Use a short-lived branch and a pull request.
- Keep commits reviewable. Do not accumulate a long-lived development branch.

## Assumptions

None recorded.

<!-- aidlc:end agents -->
