export const HOST_COMMANDS = [
  { canonical: "help-aidlc", vscode: "aidlc.help", title: "AIDLC: Help" },
  { canonical: "plan-aidlc", vscode: "aidlc.plan", title: "AIDLC: Plan Change" },
  { canonical: "init-aidlc", vscode: "aidlc.init", title: "AIDLC: Initialize Repository" },
  { canonical: "execute-aidlc", vscode: "aidlc.execute", title: "AIDLC: Execute Plan" },
  { canonical: "test-aidlc", vscode: "aidlc.test", title: "AIDLC: Run Validation" },
  { canonical: "commit-aidlc", vscode: "aidlc.commit", title: "AIDLC: Commit Planned Changes" },
  { canonical: "push-aidlc", vscode: "aidlc.push", title: "AIDLC: Push and Open Pull Request" },
  { canonical: "archive-aidlc", vscode: "aidlc.archive", title: "AIDLC: Archive Plan" },
  { canonical: "audit-aidlc", vscode: "aidlc.audit", title: "AIDLC: Write Changelog Audit" },
] as const;
