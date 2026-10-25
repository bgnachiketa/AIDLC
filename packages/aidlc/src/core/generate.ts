import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DetectionReport, ProjectDetection, TechnologyDetection } from "./detect.js";
import { skillsFor } from "./detect.js";
import { AidlcError } from "./errors.js";
import { pathExists } from "./fsutil.js";
import type { AidlcConfig, CheckKind, CommandSpec, TechnologyId } from "./schema.js";

const ACTION_PINS = {
  checkout: { sha: "11d5960a326750d5838078e36cf38b85af677262", ref: "v4" },
  setupNode: { sha: "49933ea5288caeca8642d1e84afbd3f7d6820020", ref: "v4" },
  setupPython: { sha: "a26af69be951a213d495a4c3e4e4022e16d87065", ref: "v5" },
  setupJava: { sha: "cf277c60eb25467037889841efdb72551f06f6c3", ref: "v4" },
} as const;

const SKILL_FILES: Record<TechnologyId, string> = {
  react: "react.md",
  angular: "angular.md",
  nextjs: "nextjs.md",
  nodejs: "node.md",
  express: "express.md",
  java: "java.md",
  "spring-boot": "spring-boot.md",
  python: "python.md",
  fastapi: "fastapi.md",
  flask: "flask.md",
  django: "django.md",
};

const COMMANDS = [
  ["help-aidlc", "Explain AIDLC commands, safety rules, and host setup."],
  ["plan-aidlc", "Create or resume a schema-validated implementation plan before changing application code."],
  ["init-aidlc", "Detect the repository and generate host instructions without duplicating user-authored files."],
  ["execute-aidlc", "Validate the active plan and advance the next ready task. Record evidence; do not invent code or test results."],
  ["test-aidlc", "Run the repository's real validation commands and store pass, fail, or not-run evidence."],
  ["commit-aidlc", "Create a scoped commit that excludes secrets and unrelated files."],
  ["push-aidlc", "Push a feature branch and open or update a pull request targeting the base branch."],
  ["archive-aidlc", "Move a plan into .github/aidlc/archive without deleting its record."],
  ["audit-aidlc", "Write a brief plan audit to CHANGELOG.md at the repository root."],
] as const;

function moduleDirectory(): string | undefined {
  const metaUrl = import.meta.url;
  if (typeof metaUrl !== "string" || metaUrl.length === 0) {
    return undefined;
  }
  try {
    return path.dirname(fileURLToPath(metaUrl));
  } catch {
    return undefined;
  }
}

export function templateRoot(): string {
  const here = moduleDirectory();
  const candidates = [
    ...(process.env.AIDLC_TEMPLATES ? [process.env.AIDLC_TEMPLATES] : []),
    ...(here
      ? [
          path.resolve(here, "../../templates"),
          path.resolve(here, "../templates"),
          path.resolve(here, "templates"),
        ]
      : []),
  ];
  const found = candidates.find((candidate) => existsSync(path.join(candidate, "skills")));
  if (!found) {
    throw new AidlcError("AIDLC templates were not found.", {
      code: "templates-missing",
      recovery: "Reinstall the aidlc package or set AIDLC_TEMPLATES to the templates directory.",
      details: { candidates },
    });
  }
  return found;
}

export async function loadSkillTemplate(id: TechnologyId): Promise<string> {
  return readFile(path.join(templateRoot(), "skills", SKILL_FILES[id]), "utf8");
}

export async function loadGithubTemplate(relativePath: string): Promise<string> {
  return readFile(path.join(templateRoot(), "github", relativePath), "utf8");
}

export function commandSkill(name: string, description: string): string {
  return `---
name: ${name}
description: ${description} Invoke only when the user types /${name} in chat.
disable-model-invocation: true
---

# /${name}

The user invoked this command from an installed AIDLC plugin. Do the work in this session.

- Claude Code: \`/aidlc:${name}\`
- Codex: the \`${name}\` skill from the installed plugin
- VS Code: the matching AIDLC command from the installed VSIX

Do not run npm, npx, a package script, or an \`aidlc\` binary. Do not install Node.js. This command has no npm dependency and no Node.js dependency.

## Steps

- Read \`AGENTS.md\` and \`.aidlc/config.yaml\` when they exist.
${chatSteps(name)}
- Treat \`.aidlc/plans/<id>.json\` as the plan of record. The Markdown view is not task state.
- Do not report a command, test, commit, or pull request as successful unless you actually completed it and saw the result.
- Do not force-push, bypass hooks, merge automatically, or run a destructive migration.

## Command

\`/${name}\`
`;
}

function chatSteps(name: string): string {
  const steps: Record<string, string> = {
    "help-aidlc": `- Answer in chat with the lifecycle commands, how to invoke each as \`/<command>\`, supported stacks, safety rules, and troubleshooting.
- Do not tell the user to install a package or run a terminal command for help.`,
    "plan-aidlc": `- Inspect the relevant code, tests, and existing \`.aidlc/plans/*.json\` files.
- Write a schema-valid plan under \`.aidlc/plans/\` and point \`.aidlc/state/active-plan.json\` at it. Do not edit application source.
- Ask only when a missing fact changes scope, behavior, data safety, security, or acceptance criteria.
- Leave the plan in \`needs-clarification\` or \`awaiting-approval\`. Do not mark it approved unless the user approves it in chat.
- If an equivalent plan already exists, resume it. Do not replace an unrelated active plan.`,
    "init-aidlc": `- Detect the git root, branch, languages, frameworks, workspaces, manifests, scripts, CI, tests, and security controls from files already in the repository.
- Create or update only AIDLC-owned files: \`AGENTS.md\` (propose it under \`.aidlc/proposed/\` when the user already owns that file), \`CLAUDE.md\`, \`.agents/skills/\`, \`.claude/skills/\`, \`.cursor/skills/\`, \`.cursor/rules/\`, \`.aidlc/config.yaml\`, \`.aidlc/plans/\`, \`.aidlc/state/\`, and the GitHub templates.
- Generate technology skills only for stacks you actually detected. A repeat run must not duplicate content or overwrite user-authored files.
- Leave CI as a proposal under \`.aidlc/proposed/\` unless the user asked to install the workflow.
- Reply with the files created, updated, proposed, and skipped.`,
    "execute-aidlc": `- Load the active plan JSON. Stop when it is missing, cancelled, waiting for clarification, or not approved.
- Advance the next ready task in this session. Inspect the code, make the smallest change that task allows, and record evidence on the plan.
- Do not invent test results. A verify step is complete only after the project's existing command exits successfully.
- Resume by stable task id. Do not repeat a completed task.
- Stop and report the blocker when a required check fails outside the approved scope.`,
    "test-aidlc": `- Run the validation commands already recorded in \`.aidlc/config.yaml\`, or the scripts already present in the repository. Do not install AIDLC and do not add a test runner.
- Record pass, fail, or not-run on the active plan, including a short failure summary.
- A command that did not run is not a pass. Keep a failed or skipped required check visible.
- Do not replace the repository's test framework.
- Redact secrets before writing evidence.`,
    "commit-aidlc": `- Inspect the branch, staged files, unstaged files, and untracked files.
- Stage only files that belong to the approved plan. Leave secrets, environment files, and unrelated user edits unstaged.
- Create a normal commit with a Conventional Commit subject. Do not amend, force-push, or skip hooks.
- Refuse the commit when a required quality gate failed, unless the user explicitly authorizes an exception and you record that exception on the plan.
- Store the commit hash on the plan after the commit succeeds.`,
    "archive-aidlc": `- Move the selected plan JSON and Markdown from \`.aidlc/plans/\` to \`.github/aidlc/archive/\`.
- Clear the active-plan pointer when that plan was active.
- Do not delete the plan. Leave the archived JSON in place.
- Report the source path and the archive path.`,
    "audit-aidlc": `- Write or update \`CHANGELOG.md\` at the repository root.
- Include each active and archived plan with its id, title, status, and a short requirement.
- Replace only the managed audit section. Keep any other changelog text.
- Do not invent plans that are not on disk.`,
    "push-aidlc": `- Check the current branch, remote, and unfinished plan tasks before publishing.
- Create a short-lived branch when the work is still on the base branch. Do not include unrelated changes.
- Push with a normal upstream push. Never force-push.
- Open or update a pull request into the base branch when the host's Git client is available. If it is not, write the pull request text under \`.aidlc/proposed/pull-request.md\` and say that no pull request was created.
- Do not merge the pull request.`,
  };
  return steps[name] ?? "2. Perform the requested lifecycle action in this chat session.";
}

export function lifecycleSkill(): string {
  return `---
name: aidlc
description: Index of AIDLC lifecycle skills. Use before non-trivial repository changes.
---

# AIDLC

Shared lifecycle state lives in \`.aidlc/\` and is safe to use from Claude Code, Codex, Cursor, VS Code, or a plain terminal.

| Action | Chat command |
| --- | --- |
${COMMANDS.map(([name, description]) => `| ${description} | \`/${name}\` |`).join("\n")}

These are chat slash commands. They do not require npm or an \`aidlc\` package.

Technology skills are added only for stacks detected in this repository.
`;
}

export function renderAgents(report: DetectionReport, config: AidlcConfig): string {
  const skills = skillsFor(report.technologies);
  const lines = [
    "<!-- aidlc:managed agents -->",
    "# Agent instructions",
    "",
    "This repository uses AIDLC. The same plan, standards, and quality gates apply in Claude Code, Codex, Cursor, VS Code, and the terminal.",
    "`.aidlc/plans/*.json` is the plan of record. Do not treat a Markdown checkbox as task state.",
    "Host files such as `CLAUDE.md`, `.cursor/rules`, and `.agents/skills` point here. If they disagree, this file wins for shared policy and the host skill wins only for how to invoke a command.",
    "",
    "## Lifecycle",
    "",
    "Inception: `/init-aidlc`, then `/plan-aidlc`. Wait for approval before construction.",
    "Construction: `/execute-aidlc`, `/test-aidlc`, `/commit-aidlc`.",
    "Operation: `/push-aidlc`, `/archive-aidlc`, `/audit-aidlc`.",
    "",
    "Invoke these from the chat window. They are not npm scripts and they do not add a package dependency.",
    "A coding agent may edit application code while executing an approved task. Do not invent that edit or a passing test.",
    "",
    "## Safety",
    "",
    "- Preserve unrelated user changes and pre-existing dirty files.",
    "- Do not stage secrets, credentials, or environment files.",
    "- Do not force-push, skip hooks, bypass branch protection, or merge a pull request.",
    "- Do not run a destructive database operation unless the plan and the user explicitly allow it.",
    "- Do not claim a command succeeded when it was not run or it failed.",
    "- Do not weaken a security control to make a check pass.",
    "",
    "## Repository",
    "",
    report.technologies.length === 0
      ? "No supported application stack was detected."
      : report.technologies.map((technology) => `- ${technology.name} (${technology.confidence}, ${technology.role}) in ${technology.roots.join(", ")}`).join("\n"),
    "",
    config.directories.length > 0 ? `Project directories: ${config.directories.join(", ")}` : "Project directory: repository root.",
    "",
    "## Commands",
    "",
    renderCommandLines(config),
    "",
    "## Skills",
    "",
    skills.length === 0
      ? "No framework skill was generated."
      : skills.map((skill) => `- \`${skill}\` in \`.agents/skills/aidlc-${skill}/SKILL.md\` and \`.claude/skills/aidlc-${skill}/SKILL.md\``).join("\n"),
    "",
    "## Quality gates",
    "",
    `Required: ${config.qualityGates.required.join(", ") || "none"}.`,
    `Optional: ${config.qualityGates.optional.join(", ") || "none"}.`,
    "",
    "## Trunk-based development",
    "",
    `- Integrate through \`${config.conventions.baseBranch}\`.`,
    "- Use a short-lived branch and a pull request.",
    "- Keep commits reviewable. Do not accumulate a long-lived development branch.",
    "",
    "## Assumptions",
    "",
    report.assumptions.length === 0 ? "None recorded." : report.assumptions.map((item) => `- ${item}`).join("\n"),
    "",
    "<!-- aidlc:end agents -->",
    "",
  ];
  return lines.join("\n");
}

export function renderScopedAgents(project: ProjectDetection): string {
  const skills = skillsFor(project.technologies);
  return [
    "<!-- aidlc:managed scoped-agents -->",
    `# ${project.name}`,
    "",
    `Scoped AIDLC guidance for \`${project.root}\`. Root \`AGENTS.md\` still applies.`,
    "",
    project.technologies.map((technology) => `- ${technology.name} (${technology.confidence})`).join("\n") || "- No supported stack detected in this package.",
    "",
    "## Skills",
    "",
    skills.map((skill) => `- ${skill}`).join("\n") || "- Shared lifecycle only.",
    "",
    "## Commands",
    "",
    renderProjectCommands(project),
    "",
    "<!-- aidlc:end scoped-agents -->",
    "",
  ].join("\n");
}

export function renderClaudePointer(): string {
  return [
    "<!-- aidlc:managed claude -->",
    "# Claude Code",
    "",
    "Canonical instructions are in [AGENTS.md](./AGENTS.md).",
    "Install the AIDLC plugin and invoke `/aidlc:init-aidlc` in chat. The plugin does not require Node.js or npm.",
    "<!-- aidlc:end claude -->",
    "",
  ].join("\n");
}

export function renderCursorRule(body: string, description: string, globs: string | null, alwaysApply: boolean): string {
  const front = ["---", `description: ${description}`, alwaysApply ? "alwaysApply: true" : "alwaysApply: false"];
  if (globs) {
    front.push(`globs: ${globs}`);
  }
  front.push("---", "");
  return `${front.join("\n")}${body.trim()}\n`;
}

export function cursorGlob(id: TechnologyId): string | null {
  const globs: Partial<Record<TechnologyId, string>> = {
    react: "**/*.{jsx,tsx}",
    angular: "**/*.{component,service,pipe,directive,guard}.ts",
    nextjs: "**/{app,pages,next.config}/**",
    nodejs: "**/*.{js,mjs,cjs,ts}",
    express: "**/*.{js,mjs,cjs,ts}",
    java: "**/*.java",
    "spring-boot": "**/*.java",
    python: "**/*.py",
    fastapi: "**/*.py",
    flask: "**/*.py",
    django: "**/*.py",
  };
  return globs[id] ?? null;
}

export function renderVscodeNotes(): string {
  return [
    "# VS Code",
    "",
    "Install the AIDLC extension from this toolkit's `extensions/vscode` package, or use the CLI. The extension calls the same core as the CLI.",
    "",
    "Command Palette:",
    "",
    "- AIDLC: Help",
    "- AIDLC: Initialize Repository",
    "- AIDLC: Plan Change",
    "- AIDLC: Execute Plan",
    "- AIDLC: Run Validation",
    "- AIDLC: Commit Planned Changes",
    "- AIDLC: Push and Open Pull Request",
    "",
    "The extension does not require GitHub Copilot or another model extension. It will not invent test results.",
    "Settings live under `aidlc.*`. Leave auto-approval off unless you intend to skip prompts.",
    "",
  ].join("\n");
}

export function renderReadmeGuide(report: DetectionReport): string {
  const names = report.technologies.map((technology) => technology.name).join(", ") || "the detected toolchain";
  return [
    `# Development`,
    "",
    `This repository was initialized with AIDLC. Detected stack: ${names}.`,
    "",
    "Use `aidlc help-aidlc` for the lifecycle. Plans are stored in `.aidlc/plans`.",
    "Run `aidlc test-aidlc --yes` before committing when a test command exists.",
    "",
  ].join("\n");
}

export async function renderWorkflow(root: string, report: DetectionReport): Promise<string | null> {
  const steps: string[] = [];
  const needsNode = report.projects.some((project) => project.technologies.some((technology) => technology.id === "nodejs" || technology.id === "react" || technology.id === "angular" || technology.id === "nextjs" || technology.id === "express"));
  const needsPython = report.projects.some((project) => project.technologies.some((technology) => technology.id === "python" || technology.id === "fastapi" || technology.id === "flask" || technology.id === "django"));
  const needsJava = report.projects.some((project) => project.technologies.some((technology) => technology.id === "java" || technology.id === "spring-boot"));
  if (!needsNode && !needsPython && !needsJava) {
    return null;
  }
  steps.push(`      - uses: actions/checkout@${ACTION_PINS.checkout.sha} # ${ACTION_PINS.checkout.ref}`);
  if (needsNode) {
    const manager = await nodePackageManager(root);
    steps.push(`      - uses: actions/setup-node@${ACTION_PINS.setupNode.sha} # ${ACTION_PINS.setupNode.ref}`);
    steps.push("        with:");
    steps.push('          node-version: "22"');
    steps.push(`          cache: ${manager.cache}`);
    steps.push(`      - name: Install Node dependencies`);
    steps.push(`        run: ${manager.install}`);
  }
  if (needsPython) {
    steps.push(`      - uses: actions/setup-python@${ACTION_PINS.setupPython.sha} # ${ACTION_PINS.setupPython.ref}`);
    steps.push("        with:");
    steps.push('          python-version: "3.12"');
    if (await pathExists(path.join(root, "requirements.txt"))) {
      steps.push("      - name: Install Python dependencies");
      steps.push("        run: python -m pip install -r requirements.txt");
    }
  }
  if (needsJava) {
    steps.push(`      - uses: actions/setup-java@${ACTION_PINS.setupJava.sha} # ${ACTION_PINS.setupJava.ref}`);
    steps.push("        with:");
    steps.push("          distribution: temurin");
    steps.push('          java-version: "17"');
  }
  const runSteps = workflowCommands(report);
  if (runSteps.length === 0) {
    return null;
  }
  steps.push(...runSteps);
  return [
    "name: aidlc-ci",
    "on:",
    "  pull_request:",
    "  push:",
    "    branches: [main]",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  validate:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    ...steps,
    "",
  ].join("\n");
}

export function workflowExplainer(): string {
  return [
    "# CI was not generated",
    "",
    "AIDLC did not find a build or test command it could place in a workflow without guessing.",
    "Add a real test command to the project, then rerun `init-aidlc --with-ci`.",
    "",
  ].join("\n");
}

function workflowCommands(report: DetectionReport): string[] {
  const lines: string[] = [];
  for (const project of report.projects) {
    for (const kind of ["lint", "typecheck", "test", "build"] as const) {
      const command = project.commands[kind];
      if (!command) continue;
      lines.push(`      - name: ${project.root} ${kind}`);
      if (command.cwd !== ".") {
        lines.push(`        working-directory: ${command.cwd}`);
      }
      lines.push(`        run: ${bashCommand(command)}`);
    }
  }
  return lines;
}

function bashCommand(command: CommandSpec): string {
  return [command.command, ...command.args].map(bashQuote).join(" ");
}

function bashQuote(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function nodePackageManager(root: string): Promise<{ cache: string; install: string }> {
  if (await pathExists(path.join(root, "pnpm-lock.yaml"))) {
    return { cache: "pnpm", install: "corepack enable && pnpm install --frozen-lockfile" };
  }
  if (await pathExists(path.join(root, "yarn.lock"))) {
    return { cache: "yarn", install: "corepack enable && yarn install --frozen-lockfile" };
  }
  if (await pathExists(path.join(root, "package-lock.json"))) {
    return { cache: "npm", install: "npm ci" };
  }
  return { cache: "npm", install: "npm install" };
}

function renderCommandLines(config: AidlcConfig): string {
  const lines: string[] = [];
  for (const [directory, commands] of Object.entries(config.commands)) {
    for (const kind of Object.keys(commands) as CheckKind[]) {
      const command = commands[kind];
      if (!command) continue;
      lines.push(`- \`${directory}\` ${kind}: \`${command.command} ${command.args.join(" ")}\` (${command.source})`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "No build or test command was detected.";
}

function renderProjectCommands(project: ProjectDetection): string {
  const lines: string[] = [];
  for (const [kind, command] of Object.entries(project.commands)) {
    if (!command) continue;
    lines.push(`- ${kind}: \`${command.command} ${command.args.join(" ")}\``);
  }
  return lines.length > 0 ? lines.join("\n") : "No command was detected for this package.";
}

export function technologyConfig(technologies: TechnologyDetection[]): AidlcConfig["technologies"] {
  return technologies.map((technology) => ({
    id: technology.id,
    name: technology.name,
    confidence: technology.confidence,
    roots: technology.roots,
  }));
}
