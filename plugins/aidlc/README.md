# AIDLC plugin

This directory is the installable plugin for Claude Code and Codex. It contains Markdown skills only. Installing it does not require Node.js or npm.

## Claude Code

From a terminal, load it for one session:

```bash
claude --plugin-dir /absolute/path/to/AIDLC/plugins/aidlc
```

Or install it from this repository's marketplace inside Claude Code:

```text
/plugin marketplace add /absolute/path/to/AIDLC
/plugin install aidlc@aidlc
```

The commands fall into three phases: inception (`init`, `plan`), construction (`execute`, `test`, `commit`), and operation (`push`, `archive`, `audit`).

Then start a new session and type:

```text
/aidlc:init-aidlc
/aidlc:plan-aidlc
/aidlc:execute-aidlc
/aidlc:test-aidlc
/aidlc:commit-aidlc
/aidlc:push-aidlc
/aidlc:archive-aidlc
/aidlc:audit-aidlc
/aidlc:help-aidlc
```

`/aidlc:archive-aidlc` moves a plan to `.github/aidlc/archive`. `/aidlc:audit-aidlc` writes a short summary to `CHANGELOG.md`.

Claude Code prefixes every plugin skill with the plugin name. `/aidlc:init-aidlc` is the chat command. It is not an npm script.

## Codex

Install `plugins/aidlc` from the Codex plugin directory, or add this folder as a local plugin. The manifest is `plugin.json`, with a Codex-compatible copy at `.codex-plugin/plugin.json`.

After installation, invoke the `init-aidlc` skill from the plugin. The other skills are `plan-aidlc`, `execute-aidlc`, `test-aidlc`, `commit-aidlc`, `push-aidlc`, `archive-aidlc`, `audit-aidlc`, and `help-aidlc`.

## VS Code

The editor install is a VSIX, not this folder. See `extensions/vscode/README.md`. Installing that VSIX does not require a separate Node.js or npm install.
