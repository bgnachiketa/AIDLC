const COMMANDS: Record<string, { summary: string; usage: string; notes: string[] }> = {
  "help-aidlc": {
    summary: "Show commands, hosts, lifecycle, safety rules, and troubleshooting.",
    usage: "aidlc help-aidlc [topic]",
    notes: [
      "Topics: commands, technologies, hosts, init, lifecycle, safety, troubleshooting, and any command name.",
      "aidlc --help and <command> --help show the shorter Commander help for that command.",
    ],
  },
  "plan-aidlc": {
    summary: "Create, resume, approve, or select a schema-validated implementation plan.",
    usage: 'aidlc plan-aidlc --title "Add export" --type feature "Add a CSV export for paid invoices"',
    notes: [
      "Planning writes .aidlc/plans/<id>.json and a Markdown view. It does not edit application source.",
      "The JSON file is authoritative. Do not infer completion from the Markdown table.",
      "An unrelated active plan is never replaced unless you pass --switch.",
      "An equivalent open plan is resumed.",
      "Blocking questions keep the plan in needs-clarification. --approve will not override them unless you also pass --accept-assumptions.",
    ],
  },
  "init-aidlc": {
    summary: "Detect the repository and generate host instructions idempotently.",
    usage: "aidlc init-aidlc --yes",
    notes: [
      "Detects React, Angular, Next.js, Node.js, Express, Java, Spring Boot, Python, FastAPI, Flask, and Django, including mixed monorepos.",
      "Re-running init does not duplicate managed sections or overwrite user-authored files.",
      "When ownership is ambiguous, a proposal is written under .aidlc/proposed/.",
      "CI workflows are proposed, not installed, unless you pass --with-ci. Existing workflows are not replaced.",
      "--dry-run prints the change list and writes nothing.",
    ],
  },
  "execute-aidlc": {
    summary: "Advance the approved plan, run ready verification, and emit the next work packet.",
    usage: 'aidlc execute-aidlc --yes',
    notes: [
      "Refuses a plan that is missing, unapproved, cancelled, or blocked on clarification.",
      "Completes an inspect task from recorded planning evidence, runs a ready verify command, and stops at the next implementation task.",
      "The CLI does not generate application code. The coding agent implements the work packet and then records evidence.",
      'aidlc execute-aidlc --task T2 --complete --evidence "Added validation and tests"',
      "A verify task is completed only after its command exits successfully.",
    ],
  },
  "test-aidlc": {
    summary: "Run discovered format, lint, type, test, build, and optional security checks.",
    usage: "aidlc test-aidlc --yes",
    notes: [
      "Uses the repository's own scripts. It does not install a new test framework.",
      "A required check that is missing, cancelled, or failed stays visible and makes the command exit non-zero.",
      "Formatter scripts that rewrite files are not selected. Configure a check script such as format:check.",
      "Security checks also require network approval. Pass --include-security --yes.",
      "Results are stored on the active plan when one exists.",
    ],
  },
  "commit-aidlc": {
    summary: "Create a scoped conventional commit without secrets or unrelated files.",
    usage: 'aidlc commit-aidlc --yes',
    notes: [
      "Never stages the whole worktree. Pre-existing dirty files captured when the plan was created stay unstaged.",
      "Sensitive paths and high-confidence secret contents are excluded even with --include.",
      "Required quality gates must have passing, current evidence unless you pass --allow-failed-gates and --exception.",
      "Does not amend, skip hooks, or create an empty commit unless you explicitly pass --amend.",
      "--dry-run shows the files and message.",
    ],
  },
  "archive-aidlc": {
    summary: "Move the selected plan into .github/aidlc/archive.",
    usage: "aidlc archive-aidlc --yes",
    notes: [
      "Moves the plan JSON and Markdown out of .aidlc/plans.",
      "Clears the active-plan pointer when that plan was active.",
      "Does not delete the plan. The archived JSON remains the record.",
    ],
  },
  "audit-aidlc": {
    summary: "Write a brief plan audit to CHANGELOG.md at the repository root.",
    usage: "aidlc audit-aidlc --yes",
    notes: [
      "Lists active and archived plans with id, title, status, and a short requirement.",
      "Updates only the managed audit section. Other changelog text is kept.",
    ],
  },
  "push-aidlc": {
    summary: "Push a feature branch and open or update a pull request targeting the base branch.",
    usage: "aidlc push-aidlc --yes",
    notes: [
      "Refuses to publish from the base branch when unrelated or uncommitted work is present.",
      "Creates a feature branch from a clean base branch when a plan is active.",
      "Does not force-push, bypass hooks, or merge.",
      "Uses the GitHub CLI when it is installed and authenticated. Otherwise it writes .aidlc/proposed/pull-request.md and does not claim a pull request exists.",
    ],
  },
};

export function formatHelp(topic?: string): string {
  const key = topic?.trim() || "overview";
  if (COMMANDS[key]) {
    const command = COMMANDS[key];
    return [`${key}`, "", command.summary, "", `Usage: ${command.usage}`, "", ...command.notes.map((note) => `- ${note}`), ""].join("\n");
  }
  const sections: Record<string, string> = {
    overview: overview(),
    commands: commands(),
    technologies: technologies(),
    hosts: hosts(),
    init: `${COMMANDS["init-aidlc"]?.summary}\n\n${COMMANDS["init-aidlc"]?.notes.join("\n")}`,
    lifecycle: lifecycle(),
    safety: safety(),
    troubleshooting: troubleshooting(),
  };
  return sections[key] ?? `Unknown topic ${key}.\n\n${commands()}`;
}

function overview(): string {
  return [
    "AIDLC is a local, IDE-agnostic development lifecycle.",
    "The CLI and the files under .aidlc/ are the shared core. Claude Code, Codex, Cursor, and the VS Code extension call that core.",
    "You can use the CLI without any of those hosts and without a paid model.",
    "",
    commands(),
    "",
    "Start with: aidlc init-aidlc --yes",
    'Then: aidlc plan-aidlc --title "My change" --type feature "Describe the behavior and the expected result"',
  ].join("\n");
}

function commands(): string {
  return ["Commands:", "", ...Object.entries(COMMANDS).map(([name, command]) => `- ${name}: ${command.summary}`), "", "Run aidlc help-aidlc <command> for examples."].join("\n");
}

function technologies(): string {
  return [
    "Supported detection:",
    "- React, Angular, Next.js",
    "- Node.js and Express",
    "- Java and Spring Boot",
    "- Python, FastAPI, Flask, and Django",
    "",
    "Detection uses manifests, build files, dependencies, and source structure. Each hit includes a confidence level.",
    "Ambiguous evidence is recorded as an assumption. Only skills for detected stacks are generated.",
    "A monorepo receives root guidance and a scoped AGENTS.md for each detected package.",
  ].join("\n");
}

function hosts(): string {
  return [
    "Hosts:",
    "- Claude Code plugin: install plugins/aidlc, then type /aidlc:init-aidlc, /aidlc:plan-aidlc, /aidlc:execute-aidlc, /aidlc:test-aidlc, /aidlc:commit-aidlc, /aidlc:push-aidlc, or /aidlc:help-aidlc. No Node.js or npm install is required.",
    "- Codex plugin: install the same plugins/aidlc directory. Invoke the init-aidlc skill from the plugin. No Node.js or npm install is required.",
    "- VS Code: install the AIDLC VSIX. The Command Palette commands run inside the editor. The person installing the VSIX does not install Node.js or npm.",
    "- Cursor: .cursor/skills/<name>/SKILL.md is available as /<name> after initialization.",
  ].join("\n");
}

function lifecycle(): string {
  return [
    "Lifecycle:",
    "Inception: init-aidlc, then plan-aidlc. Approve the plan before construction.",
    "Construction: execute-aidlc, test-aidlc, commit-aidlc.",
    "Operation: push-aidlc, archive-aidlc, audit-aidlc.",
    "help-aidlc is available in every phase.",
    "",
    "Plan statuses: draft, needs-clarification, awaiting-approval, approved, in-progress, blocked, completed, cancelled.",
    "Task statuses: pending, in-progress, blocked, completed, skipped.",
  ].join("\n");
}

function safety(): string {
  return [
    "Safety defaults:",
    "- Read the repository before writing application code.",
    "- Require an approved plan before execute-aidlc will advance work.",
    "- Prompt before file writes, shell commands, commits, network, and pull requests unless the config allows them or you pass --yes.",
    "- --yes approves prompts for that invocation. It does not allow force-push, hook bypass, automatic merge, or destructive migrations.",
    "- allowDestructive stays false. Those operations are not implemented.",
    "- Secrets are redacted in stored evidence and blocked from commits.",
    "- Quality gates are not downgraded silently. An exception must be an explicit flag plus a reason, and it is stored on the plan.",
  ].join("\n");
}

function troubleshooting(): string {
  return [
    "Troubleshooting:",
    "- needs-clarification: answer with --answer id=value or pass --accept-assumptions to record the gap.",
    "- active-plan-conflict: use --select, --revise, or --switch. The previous plan file is kept.",
    "- not-approved: run plan-aidlc --approve. execute-aidlc will not treat awaiting-approval as approved.",
    "- policy-denied: re-run with --yes or change .aidlc/config.yaml.",
    "- corrupt-state: run plan-aidlc --repair. Invalid files are quarantined only when you ask.",
    "- quality-gate-failed: the command output is the real result. A started process is not a pass.",
    "- host-unavailable: install and authenticate gh for GitHub pull requests. The prepared Markdown is still written.",
    "- Unsupported schemaVersion: upgrade AIDLC or restore a version-1 file. The file is not reset.",
  ].join("\n");
}

export function commandHelp(name: string): string {
  return formatHelp(name);
}
