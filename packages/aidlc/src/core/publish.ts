import { loadConfig } from "./config.js";
import { assertInside, writeAtomic } from "./fsutil.js";
import { buildPushArgs, createGitClient, type GitClient } from "./git.js";
import { resolveRepository, sameRepository } from "./identity.js";
import { loadPlan, savePlan } from "./plan-store.js";
import { decidePolicy, defaultPolicy, type PolicyContext } from "./policy.js";
import { commandExists, defaultRunner, type ProcessRunner } from "./process.js";
import { redact } from "./redact.js";
import { failResult, okResult, type CommandResult } from "./result.js";
import type { Plan } from "./schema.js";
import { appendJournal, loadActivePointer } from "./state.js";

export interface PullRequestDraft {
  title: string;
  body: string;
  base: string;
  head: string;
  planId: string | null;
}

export interface GitHostAdapter {
  id: string;
  available(): Promise<{ ok: boolean; reason?: string }>;
  findPullRequest(input: { cwd: string; head: string; base: string }): Promise<{ url: string; number: number } | null>;
  upsertPullRequest(input: { cwd: string; head: string; base: string; title: string; body: string }): Promise<{ url: string; number: number | null; created: boolean }>;
}

export interface PublishRequest extends PolicyContext {
  cwd: string;
  planId?: string;
  base?: string;
  remote?: string;
  dryRun?: boolean;
  allowIncomplete?: boolean;
  acceptStale?: boolean;
  allowFailedGates?: boolean;
  exception?: string;
  allowMainAhead?: boolean;
  now?: Date;
  git?: GitClient;
  host?: GitHostAdapter;
  runner?: ProcessRunner;
}

export interface PublishData {
  plan: Plan | null;
  draft: PullRequestDraft | null;
  branch: string | null;
  url: string | null;
  created: boolean;
}

export function formatBranchName(pattern: string, plan: Plan): string {
  const slug = plan.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "change";
  const type = plan.changeType === "bugfix" || plan.changeType === "security" ? "fix" : plan.changeType === "feature" ? "feat" : plan.changeType;
  return pattern.replaceAll("{type}", type).replaceAll("{planId}", plan.id).replaceAll("{slug}", slug).replace(/[^A-Za-z0-9._/-]/g, "-");
}

export function buildPullRequest(plan: Plan | null, branch: string, base: string): PullRequestDraft {
  const title = plan ? plan.title.slice(0, 80) : `Update ${branch}`;
  const tests = plan && plan.validation.length > 0
    ? plan.validation.map((item) => `- ${item.status} ${item.command ?? item.source}: ${item.summary.split("\n")[0] ?? ""}`).join("\n")
    : "- No validation evidence was recorded.";
  const body = [
    "## Summary",
    "",
    plan?.requirements ?? "No AIDLC plan was linked.",
    "",
    "## Motivation",
    "",
    plan?.problemStatement ?? "Prepared by push-aidlc.",
    "",
    "## Implementation details",
    "",
    plan?.design ?? "See the commits on this branch.",
    "",
    "## Linked plan",
    "",
    plan ? plan.id : "None.",
    "",
    "## Acceptance criteria",
    "",
    plan && plan.acceptanceCriteria.length > 0 ? plan.acceptanceCriteria.map((item) => `- ${item}`).join("\n") : "- None recorded.",
    "",
    "## Tests",
    "",
    tests,
    "",
    "## Security considerations",
    "",
    plan && plan.security.length > 0 ? plan.security.map((item) => `- ${item}`).join("\n") : "- None recorded.",
    "",
    "## Migration or rollout",
    "",
    plan && plan.database.length > 0 ? plan.database.map((item) => `- ${item}`).join("\n") : "- None recorded.",
    "",
    "## Known limitations",
    "",
    plan && plan.risks.length > 0 ? plan.risks.map((item) => `- ${item}`).join("\n") : "- None recorded.",
    "",
    "## Rollback",
    "",
    plan && plan.rollback.length > 0 ? plan.rollback.map((item) => `- ${item}`).join("\n") : "- Revert the branch. Do not rewrite published history.",
    "",
  ].join("\n");
  return { title, body: redact(body), base, head: branch, planId: plan?.id ?? null };
}

export function createGithubAdapter(runner: ProcessRunner = defaultRunner, lookup: (command: string) => Promise<boolean> = commandExists): GitHostAdapter {
  return {
    id: "github",
    async available() {
      const present = await lookup("gh");
      if (!present) {
        return { ok: false, reason: "GitHub CLI (gh) is not installed. The pull request body was prepared locally." };
      }
      const status = await runner.run("gh", ["auth", "status"], process.cwd(), { timeoutMs: 20_000 });
      if (status.code !== 0) {
        return { ok: false, reason: "GitHub CLI is installed but is not authenticated. Run `gh auth login` and retry." };
      }
      return { ok: true };
    },
    async findPullRequest(input) {
      const result = await runner.run("gh", ["pr", "list", "--head", input.head, "--base", input.base, "--json", "number,url", "--limit", "1"], input.cwd, { timeoutMs: 30_000 });
      if (result.code !== 0) return null;
      try {
        const parsed = JSON.parse(result.stdout) as Array<{ number?: number; url?: string }>;
        const first = parsed[0];
        if (!first?.url || !first.number) return null;
        return { url: first.url, number: first.number };
      } catch {
        return null;
      }
    },
    async upsertPullRequest(input) {
      const existing = await this.findPullRequest(input);
      if (existing) {
        const edited = await runner.run("gh", ["pr", "edit", String(existing.number), "--title", input.title, "--body", input.body], input.cwd, { timeoutMs: 30_000 });
        if (edited.code !== 0) {
          throw new Error(edited.stderr.trim() || "gh pr edit failed");
        }
        return { url: existing.url, number: existing.number, created: false };
      }
      const created = await runner.run("gh", ["pr", "create", "--base", input.base, "--head", input.head, "--title", input.title, "--body", input.body], input.cwd, { timeoutMs: 30_000 });
      if (created.code !== 0) {
        throw new Error(created.stderr.trim() || "gh pr create failed");
      }
      const url = created.stdout.trim().split(/\s+/).find((part) => part.startsWith("http")) ?? created.stdout.trim();
      return { url, number: null, created: true };
    },
  };
}

export async function publishPlan(input: PublishRequest): Promise<CommandResult<PublishData>> {
  const now = input.now ?? new Date();
  const identity = await resolveRepository(input.cwd, input.runner);
  const git = input.git ?? createGitClient(input.runner);
  const empty: PublishData = { plan: null, draft: null, branch: null, url: null, created: false };
  if (!identity.gitRoot) {
    return failResult(1, "not-a-repository", "This directory is not a Git repository.", empty);
  }
  const pointer = input.planId ? null : await loadActivePointer(identity.root).catch((error) => { throw error; });
  const plan = input.planId || pointer ? await loadPlan(identity.root, input.planId ?? pointer?.planId ?? "") : null;
  if (plan && !sameRepository(plan, identity)) {
    return failResult(2, "repository-mismatch", `Plan ${plan.id} belongs to another repository.`, { ...empty, plan });
  }
  const config = await loadConfig(identity.root);
  const base = input.base ?? config?.conventions.baseBranch ?? "main";
  const remote = input.remote ?? "origin";
  const snapshot = await git.snapshot(identity.root);
  if (snapshot.files.length > 0) {
    return failResult(2, "dirty-worktree", "Uncommitted changes are present. Refusing to publish them implicitly.", { ...empty, plan }, "Run commit-aidlc for the planned files first.");
  }
  if (snapshot.detached || !snapshot.branch) {
    return failResult(2, "detached", "HEAD is detached. Check out a branch before publishing.", { ...empty, plan });
  }
  let branch = snapshot.branch;
  if (branch === base) {
    if (!plan) {
      return failResult(2, "not-found", `Refusing to publish from ${base} without a plan.`, empty, "Create a plan so the feature branch has a reviewable name.");
    }
    const divergence = await git.divergence(identity.root, `${remote}/${base}`, "HEAD");
    if (divergence && divergence.ahead > 0 && !input.allowMainAhead) {
      return failResult(2, "main-ahead", `${base} is ${divergence.ahead} commit(s) ahead of ${remote}/${base}.`, { ...empty, plan }, "Move those commits onto a feature branch yourself, or pass --allow-main-ahead.");
    }
    branch = formatBranchName(config?.conventions.branchPattern ?? "{type}/{planId}-{slug}", plan);
  }
  const unfinished = plan?.tasks.filter((task) => task.status !== "completed" && task.status !== "skipped") ?? [];
  if (unfinished.length > 0 && !input.allowIncomplete) {
    return failResult(2, "incomplete-plan", `Unfinished tasks: ${unfinished.map((task) => task.id).join(", ")}.`, { ...empty, plan, branch }, "Finish them or pass --allow-incomplete to document the gap in the pull request.");
  }
  if (plan) {
    const required = config?.qualityGates.required ?? ["test"];
    for (const kind of required) {
      const latest = plan.validation.filter((item) => item.source.startsWith(`${kind}:`)).at(-1);
      if ((!latest || latest.status !== "pass") && !(input.allowFailedGates && input.exception)) {
        return failResult(3, "quality-gate-failed", `Required gate ${kind} has no current passing evidence.`, { ...empty, plan, branch }, "Run test-aidlc or pass --allow-failed-gates with --exception.");
      }
    }
    if (!input.acceptStale) {
      const newest = plan.validation.filter((item) => item.status === "pass").at(-1);
      if (newest?.head && snapshot.head && newest.head !== snapshot.head) {
        return failResult(3, "stale-validation", "Validation evidence was recorded on a different commit.", { ...empty, plan, branch }, "Run test-aidlc again or pass --accept-stale.");
      }
    }
    if (input.allowFailedGates && input.exception) {
      plan.exceptions.push({ at: now.toISOString(), action: "push", reason: input.exception, gate: "explicit exception" });
    }
    if (input.allowIncomplete) {
      plan.risks.push(`Published with unfinished tasks: ${unfinished.map((task) => task.id).join(", ") || "none"}.`);
    }
  }
  const draft = buildPullRequest(plan, branch, base);
  if (input.dryRun) {
    return okResult("dry-run", `Would publish ${branch} to ${remote} and open a pull request against ${base}.\n\n${draft.title}\n\n${draft.body}`, { ...empty, plan, draft, branch });
  }
  const policy = config?.policy ?? defaultPolicy();
  const network = await decidePolicy(policy, "network", input, "Push the feature branch and contact the Git host?");
  const review = await decidePolicy(policy, "pullRequest", input, "Create or update the pull request?");
  if (!network.allowed || !review.allowed) {
    return failResult(2, "policy-denied", network.allowed ? review.reason : network.reason, { ...empty, plan, draft, branch }, "Re-run with --yes if the policy is prompt.");
  }
  const remoteUrl = await git.remoteUrl(identity.root, remote);
  if (!remoteUrl) {
    return failResult(2, "no-remote", `Git remote ${remote} is not configured.`, { ...empty, plan, draft, branch }, "Add the remote, then retry. The pull request body is included above in JSON mode.");
  }
  if (snapshot.branch !== branch) {
    await git.checkoutNewBranch(identity.root, branch);
  }
  const pushed = await git.push(identity.root, remote, branch);
  if (pushed.code !== 0) {
    return failResult(1, "git-failed", redact(pushed.stderr || pushed.stdout || "git push failed"), { ...empty, plan, draft, branch }, "AIDLC did not force-push. Fix authentication or divergence and retry.");
  }
  const host = input.host ?? (config?.integrations.gitHost === "none" ? null : createGithubAdapter(input.runner ?? defaultRunner));
  if (!host) {
    await writeDraft(identity.root, draft);
    return failResult(2, "host-unavailable", "No Git host adapter is enabled. The branch was pushed and the pull request text was saved locally.", { ...empty, plan, draft, branch });
  }
  const available = await host.available();
  if (!available.ok) {
    await writeDraft(identity.root, draft);
    return failResult(2, "host-unavailable", available.reason ?? "The Git host adapter is unavailable.", { ...empty, plan, draft, branch }, "Install and authenticate the host CLI, then retry. No pull request was created.");
  }
  try {
    const result = await host.upsertPullRequest({ cwd: identity.root, head: branch, base, title: draft.title, body: draft.body });
    if (plan) {
      plan.updatedAt = now.toISOString();
      plan.revisions.push({ at: plan.updatedAt, summary: `Pull request ${result.url}` });
      await savePlan(identity.root, plan);
      await appendJournal(identity.root, { at: plan.updatedAt, type: "pull-request", message: result.url, planId: plan.id, taskId: null });
    }
    return okResult(result.created ? "pull-request-created" : "pull-request-updated", result.url, { plan, draft, branch, url: result.url, created: result.created });
  } catch (error) {
    await writeDraft(identity.root, draft);
    return failResult(1, "host-failed", redact(error instanceof Error ? error.message : "Pull request creation failed."), { ...empty, plan, draft, branch }, "The branch was pushed. Review .aidlc/proposed/pull-request.md and create the pull request manually. AIDLC did not claim it exists.");
  }
}

async function writeDraft(root: string, draft: PullRequestDraft): Promise<void> {
  const target = assertInside(root, ".aidlc/proposed/pull-request.md");
  await writeAtomic(target, `# ${draft.title}\n\nBase: ${draft.base}\nHead: ${draft.head}\n\n${draft.body}`);
}

export function safePushArgs(remote: string, branch: string): string[] {
  return buildPushArgs(remote, branch);
}
