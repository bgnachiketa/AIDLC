import { evidenceIsStale } from "./checks.js";
import { loadConfig } from "./config.js";
import { AidlcError } from "./errors.js";
import { createGitClient, type GitClient, type GitFileChange } from "./git.js";
import { resolveRepository, sameRepository } from "./identity.js";
import { loadPlan, savePlan } from "./plan-store.js";
import { decidePolicy, defaultPolicy, type PolicyContext } from "./policy.js";
import { failResult, okResult, type CommandResult } from "./result.js";
import { hasHighConfidenceSecret, isGeneratedArtifact, isSensitivePath } from "./redact.js";
import type { ChangeType, Plan } from "./schema.js";
import { appendJournal, loadActivePointer } from "./state.js";

export interface CommitRequest extends PolicyContext {
  cwd: string;
  planId?: string;
  message?: string;
  paths?: string[];
  include?: string[];
  split?: boolean;
  dryRun?: boolean;
  allowFailedGates?: boolean;
  exception?: string;
  amend?: boolean;
  acceptStale?: boolean;
  now?: Date;
  git?: GitClient;
}

export interface CommitGroup {
  files: string[];
  subject: string;
  body: string;
}

export interface CommitData {
  plan: Plan | null;
  groups: CommitGroup[];
  excludedSecrets: string[];
  excludedGenerated: string[];
  excludedUnrelated: string[];
  commits: Array<{ hash: string; subject: string }>;
}

export function conventionalSubject(changeType: ChangeType, scope: string | null, summary: string): string {
  const type = changeType === "bugfix" || changeType === "security" ? "fix" : changeType === "feature" ? "feat" : changeType === "performance" ? "perf" : changeType === "documentation" ? "docs" : changeType === "infrastructure" ? "ci" : changeType === "refactor" ? "refactor" : "chore";
  const prefix = scope ? `${type}(${sanitizeScope(scope)}): ` : `${type}: `;
  const text = summary.replace(/\s+/g, " ").trim();
  const room = Math.max(8, 72 - prefix.length);
  const clipped = text.length <= room ? text : `${text.slice(0, room - 3).trimEnd()}...`;
  return `${prefix}${clipped}`;
}

export function partitionChangeSet(files: string[], scopePaths: string[], baselineDirty: string[], include: string[]): {
  related: string[];
  unrelated: string[];
  secrets: string[];
  generated: string[];
} {
  const related: string[] = [];
  const unrelated: string[] = [];
  const secrets: string[] = [];
  const generated: string[] = [];
  for (const file of files) {
    if (isSensitivePath(file) || file.split("/").some((segment) => isSensitivePath(segment))) {
      secrets.push(file);
      continue;
    }
    if (isGeneratedArtifact(file)) {
      generated.push(file);
      continue;
    }
    const forced = include.includes(file);
    if (!forced && baselineDirty.includes(file)) {
      unrelated.push(file);
      continue;
    }
    if (!forced && !inScope(file, scopePaths)) {
      unrelated.push(file);
      continue;
    }
    related.push(file);
  }
  return { related, unrelated, secrets, generated };
}

export function inScope(file: string, scopePaths: string[]): boolean {
  if (scopePaths.length === 0) return false;
  return scopePaths.some((scope) => scope === "." || file === scope || file.startsWith(`${scope.replace(/\/$/, "")}/`));
}

export function groupCommitFiles(files: string[], changeType: ChangeType, title: string, planId: string, split: boolean, explicitMessage?: string): CommitGroup[] {
  const buckets = new Map<string, string[]>();
  for (const file of files) {
    const key = split ? bucketFor(file, changeType) : "all";
    const list = buckets.get(key) ?? [];
    list.push(file);
    buckets.set(key, list);
  }
  const order = split ? ["source", "test", "ci", "docs"] : ["all"];
  const groups: CommitGroup[] = [];
  for (const key of order) {
    const grouped = buckets.get(key);
    if (!grouped || grouped.length === 0) continue;
    const type = key === "test" ? "bugfix" : key === "docs" ? "documentation" : key === "ci" ? "infrastructure" : changeType;
    const summary = key === "test" ? `cover ${title}` : key === "docs" ? `document ${title}` : key === "ci" ? `update checks for ${title}` : title;
    const subject = explicitMessage && !split ? explicitMessage : conventionalSubject(type === "bugfix" && key === "test" ? "bugfix" : type, scopeFrom(grouped), key === "test" ? `cover ${title}` : summary);
    const testSubject = key === "test" ? conventionalSubject("bugfix", scopeFrom(grouped), `cover ${title}`).replace(/^fix/, "test") : subject;
    groups.push({
      files: grouped,
      subject: key === "test" ? testSubject : subject,
      body: `Plan: ${planId}`,
    });
  }
  return groups;
}

export async function commitChanges(input: CommitRequest): Promise<CommandResult<CommitData>> {
  const now = input.now ?? new Date();
  const identity = await resolveRepository(input.cwd);
  const git = input.git ?? createGitClient();
  const snapshot = await git.snapshot(identity.root);
  const empty: CommitData = { plan: null, groups: [], excludedSecrets: [], excludedGenerated: [], excludedUnrelated: [], commits: [] };
  if (!snapshot.isRepo) {
    return failResult(1, "not-a-repository", "This directory is not a Git repository.", empty, "Initialize Git before committing.");
  }
  const plan = await loadCommitPlan(identity.root, input.planId);
  if (plan && !sameRepository(plan, identity)) {
    return failResult(2, "repository-mismatch", `Plan ${plan.id} belongs to another repository.`, { ...empty, plan });
  }
  const files = (input.paths && input.paths.length > 0 ? input.paths : snapshot.files.map((file) => file.path)).map((file) => file.replace(/\\/g, "/"));
  for (const file of input.include ?? []) {
    if (isSensitivePath(file)) {
      return failResult(2, "secret-detected", `Refusing to include sensitive path ${file}.`, empty, "Remove the secret from the request.");
    }
  }
  const partitioned = partitionChangeSet(files, plan?.scopePaths ?? ["."], plan?.baseline.dirty ?? [], input.include ?? []);
  const data: CommitData = {
    plan,
    groups: [],
    excludedSecrets: partitioned.secrets,
    excludedGenerated: partitioned.generated,
    excludedUnrelated: partitioned.unrelated,
    commits: [],
  };
  const contentSecrets: string[] = [];
  for (const file of partitioned.related) {
    const text = await git.readFile(identity.root, file);
    if (text && hasHighConfidenceSecret(text)) contentSecrets.push(file);
  }
  data.excludedSecrets.push(...contentSecrets);
  const safeFiles = partitioned.related.filter((file) => !contentSecrets.includes(file));
  if (safeFiles.length === 0) {
    return failResult(2, "nothing-to-commit", renderCommitPreview(data, []), { ...data, groups: [] }, "There is no in-scope, non-secret change to commit.");
  }
  const groups = groupCommitFiles(safeFiles, plan?.changeType ?? "other", plan?.title ?? "update repository", plan?.id ?? "unplanned", Boolean(input.split), input.message);
  data.groups = groups;
  if (plan) {
    const gate = await gateFailure(identity.root, plan, safeFiles, Boolean(input.acceptStale));
    if (gate && !(input.allowFailedGates && input.exception)) {
      return failResult(3, "quality-gate-failed", `${gate}\n${renderCommitPreview(data, groups)}`, data, "Run test-aidlc, or pass --allow-failed-gates with --exception and a reason.");
    }
    if (gate && input.allowFailedGates && input.exception) {
      plan.exceptions.push({ at: now.toISOString(), action: "commit", reason: input.exception, gate });
    }
  }
  if (input.dryRun) {
    return okResult("dry-run", renderCommitPreview(data, groups), data);
  }
  const config = await loadConfig(identity.root);
  const decision = await decidePolicy(config?.policy ?? defaultPolicy(), "commit", input, "Create the planned commit?");
  if (!decision.allowed) {
    return failResult(2, "policy-denied", decision.reason, data, "Re-run with --yes to allow the commit policy.");
  }
  if (input.amend) {
    // Explicit authorization only. Hooks still run because --no-verify is never added.
  }
  for (const group of groups) {
    await git.stage(identity.root, group.files);
    const result = await git.commit(identity.root, group.subject, group.body, Boolean(input.amend));
    if (result.code !== 0) {
      return failResult(1, "git-failed", result.stderr.trim() || result.stdout.trim() || "git commit failed", data, "The hook or Git rejected the commit. AIDLC did not amend or skip hooks.");
    }
    const hash = await git.head(identity.root);
    if (!hash) {
      return failResult(1, "git-failed", "Commit finished without a HEAD.", data);
    }
    data.commits.push({ hash, subject: group.subject });
    if (plan) {
      plan.commits.push({ hash, subject: group.subject, at: now.toISOString() });
    }
  }
  if (plan) {
    plan.updatedAt = now.toISOString();
    await savePlan(identity.root, plan);
    await appendJournal(identity.root, { at: plan.updatedAt, type: "commit", message: data.commits.map((commit) => commit.hash).join(","), planId: plan.id, taskId: null });
  }
  return okResult("committed", data.commits.map((commit) => `${commit.hash.slice(0, 12)} ${commit.subject}`).join("\n"), data);
}

async function gateFailure(root: string, plan: Plan, files: string[], acceptStale: boolean): Promise<string | null> {
  const config = await loadConfig(root);
  const required = config?.qualityGates.required ?? ["test"];
  for (const kind of required) {
    const relevant = plan.validation.filter((item) => item.source.startsWith(`${kind}:`));
    const latest = relevant.at(-1);
    if (!latest || latest.status !== "pass") {
      return `Required gate ${kind} does not have a passing result.`;
    }
  }
  if (!acceptStale && files.length > 0 && (await evidenceIsStale(root, plan, files))) {
    return "Validation evidence is older than the files to be committed.";
  }
  return null;
}

async function loadCommitPlan(root: string, planId?: string): Promise<Plan | null> {
  if (planId) return loadPlan(root, planId);
  const pointer = await loadActivePointer(root).catch((error) => {
    if (error instanceof AidlcError) throw error;
    return null;
  });
  if (!pointer) return null;
  return loadPlan(root, pointer.planId);
}

function renderCommitPreview(data: CommitData, groups: CommitGroup[]): string {
  const lines = ["Commit preview:"];
  if (groups.length === 0) lines.push("No files selected.");
  for (const group of groups) {
    lines.push(group.subject);
    lines.push(group.body);
    for (const file of group.files) lines.push(`  ${file}`);
  }
  if (data.excludedSecrets.length > 0) lines.push(`Excluded secrets: ${data.excludedSecrets.join(", ")}`);
  if (data.excludedUnrelated.length > 0) lines.push(`Left unstaged: ${data.excludedUnrelated.join(", ")}`);
  if (data.excludedGenerated.length > 0) lines.push(`Excluded generated files: ${data.excludedGenerated.join(", ")}`);
  return lines.join("\n");
}

function bucketFor(file: string, _changeType: ChangeType): string {
  if (/\.(test|spec)\.[jt]sx?$/.test(file) || file.includes("/tests/") || file.startsWith("tests/") || file.includes("__tests__")) return "test";
  if (file.startsWith(".github/") || file.endsWith(".yml") || file.endsWith(".yaml")) return "ci";
  if (file.endsWith(".md")) return "docs";
  return "source";
}

function scopeFrom(files: string[]): string | null {
  const tops = new Set(files.map((file) => file.split("/")[0] ?? ""));
  if (tops.size !== 1) return null;
  const [top] = [...tops];
  if (!top || top.includes(".")) return null;
  return top;
}

function sanitizeScope(scope: string): string {
  return scope.replace(/[^A-Za-z0-9-]/g, "").slice(0, 20) || "app";
}

export function changedPaths(files: GitFileChange[]): string[] {
  return files.map((file) => file.path);
}
