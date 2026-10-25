import { parseDocument } from "yaml";
import { appendMissingConfigKeys, createDefaultConfig, loadConfig, writeNewConfig } from "./config.js";
import { detectRepository, skillsFor, type DetectionReport } from "./detect.js";
import { assertInside, readText, sha256, writeAtomic } from "./fsutil.js";
import {
  commandSkill,
  cursorGlob,
  lifecycleSkill,
  loadGithubTemplate,
  loadSkillTemplate,
  renderAgents,
  renderClaudePointer,
  renderCursorRule,
  renderReadmeGuide,
  renderScopedAgents,
  renderVscodeNotes,
  renderWorkflow,
  technologyConfig,
  workflowExplainer,
} from "./generate.js";
import { resolveRepository } from "./identity.js";
import { decidePolicy, type PolicyContext } from "./policy.js";
import { failResult, okResult, type CommandResult } from "./result.js";
import { GeneratedManifestSchema, SCHEMA_VERSION, type AidlcConfig, type GeneratedManifest } from "./schema.js";
import { loadManifest, saveManifest } from "./state.js";

export interface InitRequest extends PolicyContext {
  cwd: string;
  dryRun?: boolean;
  withCi?: boolean;
  refreshCommands?: boolean;
}

export interface FileChange {
  path: string;
  action: "create" | "update" | "skip" | "propose";
  reason: string;
  proposedPath: string | null;
}

export interface InitData {
  changes: FileChange[];
  warnings: string[];
  technologies: string[];
  monorepo: boolean;
  root: string;
}

export async function initializeRepository(input: InitRequest): Promise<CommandResult<InitData>> {
  const identity = await resolveRepository(input.cwd);
  const existing = await loadConfig(identity.root);
  const report = await detectRepository(identity.root);
  const warnings = [...report.warnings, ...report.assumptions];
  if (!identity.gitRoot) {
    warnings.push("This directory is not a Git repository. Commit and push commands will fail until it is initialized.");
  }
  const detected = createDefaultConfig({
    repositoryId: identity.primary,
    repositoryPathId: identity.pathId,
    technologies: technologyConfig(report.technologies),
    directories: report.projects.map((project) => project.root),
    commands: Object.fromEntries(report.projects.map((project) => [project.root, project.commands])),
  });
  const config = existing ?? detected;
  const manifest = await loadManifest(identity.root);
  const files = await collectFiles(identity.root, report, config, Boolean(input.withCi), manifest);
  const preview: FileChange[] = [];
  for (const file of files) {
    preview.push(await applyManaged(identity.root, file.path, file.content, manifest, true));
  }
  const data = (changes: FileChange[]): InitData => ({
    changes,
    warnings,
    technologies: report.technologies.map((item) => item.name),
    monorepo: report.monorepo,
    root: identity.root,
  });
  if (input.dryRun) {
    preview.push(configPreview(Boolean(existing)));
    return okResult("dry-run", summarize(identity.root, report, preview, warnings), data(preview));
  }
  const needsWrite = preview.some((change) => change.action === "create" || change.action === "update" || change.action === "propose") || !existing || Boolean(input.refreshCommands);
  if (needsWrite) {
    const decision = await decidePolicy(config.policy, "fileChanges", input, "Write AIDLC planning files and generated instructions?");
    if (!decision.allowed) {
      return failResult(2, "policy-denied", `${decision.reason} No files were written.`, data(preview), "Re-run with --yes, or set policy.fileChanges to allow.");
    }
  }
  const written: FileChange[] = [];
  for (const file of files) {
    written.push(await applyManaged(identity.root, file.path, file.content, manifest, false));
  }
  if (existing) {
    const added = await appendMissingConfigKeys(identity.root, detected);
    if (input.refreshCommands) {
      await refreshCommands(identity.root, detected);
      written.push({ path: ".aidlc/config.yaml", action: "update", reason: "Refreshed detected commands.", proposedPath: null });
    } else if (added.length > 0) {
      written.push({ path: ".aidlc/config.yaml", action: "update", reason: `Added missing keys: ${added.join(", ")}`, proposedPath: null });
    } else {
      written.push({ path: ".aidlc/config.yaml", action: "skip", reason: "Configuration preserved.", proposedPath: null });
    }
  } else {
    await writeNewConfig(identity.root, detected);
    written.push({ path: ".aidlc/config.yaml", action: "create", reason: "Created configuration.", proposedPath: null });
  }
  written.push(await applyManaged(identity.root, ".aidlc/state/detection.json", renderDetection(report), manifest, false));
  await saveManifest(identity.root, GeneratedManifestSchema.parse(manifest));
  return okResult("initialized", summarize(identity.root, report, written, warnings), data(written));
}

async function collectFiles(
  root: string,
  report: DetectionReport,
  config: AidlcConfig,
  withCi: boolean,
  manifest: GeneratedManifest,
): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];
  const skills = skillsFor(report.technologies);
  files.push({ path: "AGENTS.md", content: renderAgents(report, config) });
  files.push({ path: ".aidlc/plans/README.md", content: plansReadme() });
  if (config.integrations.vscode) {
    files.push({ path: ".aidlc/editors/vscode.md", content: renderVscodeNotes() });
  }
  if (config.integrations.claude) {
    files.push({ path: "CLAUDE.md", content: renderClaudePointer() });
    files.push({ path: ".claude/skills/aidlc/SKILL.md", content: lifecycleSkill() });
    for (const [name, description] of commandDescriptions()) {
      files.push({ path: `.claude/skills/${name}/SKILL.md`, content: commandSkill(name, description) });
    }
    for (const skill of skills) {
      files.push({ path: `.claude/skills/aidlc-${skill}/SKILL.md`, content: await loadSkillTemplate(skill) });
    }
  }
  if (config.integrations.codex) {
    files.push({ path: ".agents/skills/aidlc/SKILL.md", content: lifecycleSkill() });
    for (const [name, description] of commandDescriptions()) {
      files.push({ path: `.agents/skills/${name}/SKILL.md`, content: commandSkill(name, description) });
    }
    for (const skill of skills) {
      files.push({ path: `.agents/skills/aidlc-${skill}/SKILL.md`, content: await loadSkillTemplate(skill) });
    }
  }
  if (config.integrations.cursor) {
    files.push({
      path: ".cursor/rules/aidlc-lifecycle.mdc",
      content: renderCursorRule(
        "Follow AGENTS.md. Invoke /init-aidlc, /plan-aidlc, /execute-aidlc, /test-aidlc, /commit-aidlc, and /push-aidlc from chat. They do not use npm. Do not invent test results, force-push, or merge automatically. JSON plan files are authoritative.",
        "AIDLC lifecycle and safety rules",
        null,
        true,
      ),
    });
    for (const skill of skills) {
      files.push({
        path: `.cursor/rules/aidlc-${skill}.mdc`,
        content: renderCursorRule(stripFrontmatter(await loadSkillTemplate(skill)), `AIDLC ${skill} standards`, cursorGlob(skill), false),
      });
    }
    for (const [name, description] of commandDescriptions()) {
      files.push({ path: `.cursor/skills/${name}/SKILL.md`, content: commandSkill(name, description) });
    }
  }
  for (const project of report.projects) {
    if (project.root === ".") continue;
    files.push({ path: `${project.root}/AGENTS.md`, content: renderScopedAgents(project) });
  }
  const readmePath = assertInside(root, "README.md");
  const readme = await readText(readmePath);
  if (readme === null || manifest.files["README.md"]) {
    files.push({ path: "README.md", content: renderReadmeGuide(report) });
  }
  files.push({ path: ".github/pull_request_template.md", content: await loadGithubTemplate("pull_request_template.md") });
  files.push({ path: ".github/ISSUE_TEMPLATE/bug_report.yml", content: await loadGithubTemplate("ISSUE_TEMPLATE/bug_report.yml") });
  files.push({ path: ".github/ISSUE_TEMPLATE/feature_request.yml", content: await loadGithubTemplate("ISSUE_TEMPLATE/feature_request.yml") });
  files.push({ path: ".github/ISSUE_TEMPLATE/config.yml", content: await loadGithubTemplate("ISSUE_TEMPLATE/config.yml") });
  const workflow = await renderWorkflow(root, report);
  if (workflow) {
    files.push({ path: ".aidlc/proposed/github/workflows/aidlc-ci.yml", content: workflow });
    if (withCi) {
      files.push({ path: ".github/workflows/aidlc-ci.yml", content: workflow });
    }
  } else {
    files.push({ path: ".aidlc/proposed/github/workflows/README.md", content: workflowExplainer() });
  }
  return files;
}

async function applyManaged(
  root: string,
  relativePath: string,
  content: string,
  manifest: GeneratedManifest,
  dryRun: boolean,
): Promise<FileChange> {
  const current = await readText(assertInside(root, relativePath));
  const digest = sha256(content);
  if (current === null) {
    if (!dryRun) {
      await writeAtomic(assertInside(root, relativePath), content);
      manifest.files[relativePath] = { sha256: digest };
    }
    return { path: relativePath, action: "create", reason: "Created an AIDLC file.", proposedPath: null };
  }
  if (current === content) {
    if (!dryRun) {
      manifest.files[relativePath] = { sha256: digest };
    }
    return { path: relativePath, action: "skip", reason: "Unchanged.", proposedPath: null };
  }
  const recorded = manifest.files[relativePath]?.sha256;
  if (recorded && recorded === sha256(current)) {
    if (!dryRun) {
      await writeAtomic(assertInside(root, relativePath), content);
      manifest.files[relativePath] = { sha256: digest };
    }
    return { path: relativePath, action: "update", reason: "Updated an AIDLC-managed file.", proposedPath: null };
  }
  const proposed = `.aidlc/proposed/${relativePath}`;
  const proposedCurrent = await readText(assertInside(root, proposed));
  if (proposedCurrent === content) {
    return { path: relativePath, action: "skip", reason: "Existing file preserved. Proposal unchanged.", proposedPath: proposed };
  }
  if (!dryRun) {
    await writeAtomic(assertInside(root, proposed), content);
  }
  return {
    path: relativePath,
    action: "propose",
    reason: "Left an existing or locally edited file unchanged.",
    proposedPath: proposed,
  };
}

async function refreshCommands(root: string, config: AidlcConfig): Promise<void> {
  const absolute = assertInside(root, ".aidlc/config.yaml");
  const text = await readText(absolute);
  if (text === null) {
    return;
  }
  const document = parseDocument(text);
  document.set("commands", config.commands);
  await writeAtomic(absolute, document.toString());
}

function renderDetection(report: DetectionReport): string {
  return `${JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      monorepo: report.monorepo,
      technologies: technologyConfig(report.technologies),
      warnings: report.warnings,
      assumptions: report.assumptions,
      projects: report.projects.map((project) => ({
        root: project.root,
        name: project.name,
        technologies: project.technologies.map((technology) => technology.id),
        databases: project.databases,
        patterns: project.patterns,
        commands: project.commands,
      })),
    },
    null,
    2,
  )}\n`;
}

function plansReadme(): string {
  return ["# AIDLC plans", "", "Each plan has a JSON file and a Markdown view. The JSON file is authoritative.", "Do not mark work complete by editing the Markdown table.", ""].join("\n");
}

function commandDescriptions(): Array<[string, string]> {
  return [
    ["help-aidlc", "Show AIDLC commands, hosts, safety rules, and troubleshooting."],
    ["plan-aidlc", "Create or resume an implementation plan before changing application code."],
    ["init-aidlc", "Detect the stack and generate host instructions idempotently."],
    ["execute-aidlc", "Advance the approved plan and record real task evidence."],
    ["test-aidlc", "Run discovered validation commands and store their results."],
    ["commit-aidlc", "Commit scoped changes with secret and unrelated-file checks."],
    ["push-aidlc", "Publish a feature branch and prepare a pull request to the base branch."],
    ["archive-aidlc", "Move a plan into .github/aidlc/archive without deleting its record."],
    ["audit-aidlc", "Write a brief plan audit to CHANGELOG.md at the repository root."],
  ];
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n/, "");
}

function configPreview(exists: boolean): FileChange {
  return {
    path: ".aidlc/config.yaml",
    action: exists ? "skip" : "create",
    reason: exists ? "Dry run: existing configuration is preserved." : "Dry run: configuration would be created.",
    proposedPath: null,
  };
}

function summarize(root: string, report: DetectionReport, changes: FileChange[], warnings: string[]): string {
  const tally = { create: 0, update: 0, skip: 0, propose: 0 };
  for (const change of changes) tally[change.action] += 1;
  return [
    `Repository: ${root}`,
    `Technologies: ${report.technologies.map((item) => `${item.name} (${item.confidence})`).join(", ") || "none"}`,
    `Files: ${tally.create} created, ${tally.update} updated, ${tally.propose} proposed, ${tally.skip} unchanged`,
    ...warnings.map((warning) => `Warning: ${warning}`),
    ...changes
      .filter((change) => change.action !== "skip")
      .map((change) => `${change.action} ${change.path}${change.proposedPath ? ` -> ${change.proposedPath}` : ""}`),
  ].join("\n");
}
