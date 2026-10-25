# AIDLC for VS Code

Install `aidlc-vscode-0.1.0.vsix` in VS Code or Cursor. You do not need Node.js or npm to install or use it. The VSIX contains the lifecycle commands. It does not bundle a model and it does not require GitHub Copilot or another AI extension.

## Commands

- AIDLC: Help
- AIDLC: Initialize Repository
- AIDLC: Plan Change
- AIDLC: Execute Plan
- AIDLC: Run Validation
- AIDLC: Commit Planned Changes
- AIDLC: Push and Open Pull Request
- AIDLC: Archive Plan
- AIDLC: Write Changelog Audit

Progress appears as a notification. Logs go to the **AIDLC** output channel. A running validation or execution can be cancelled from the notification. Cancellation does not report success.

## Settings

- `aidlc.yes`: skip the confirmation dialog. This still cannot force-push or run destructive migrations.
- `aidlc.dryRun`: preview init, commit, and publish without writing.

## Install

```bash
code --install-extension aidlc-vscode-0.1.0.vsix
```

Use `cursor --install-extension` when installing into Cursor. Restart the editor, then run **AIDLC: Initialize Repository** from the Command Palette.

## Develop

Building the VSIX from this repository uses Node.js 22 or newer. People who only install the VSIX do not need that toolchain.

```bash
npm install
npm run build -w aidlc-vscode
npx --prefix extensions/vscode @vscode/vsce package --no-dependencies --allow-missing-repository
```

Open this repository in VS Code or Cursor and start the **Run AIDLC Extension** launch configuration. The extension host loads `extensions/vscode/dist/extension.js`. The build copies skill templates into the bundle so initialization works without a separate package install.

The same actions are available from the terminal through `aidlc` when the extension is not installed.
