import { stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { detectRepository } from "./detect.js";
import { assertInside } from "./fsutil.js";
import { createGitClient } from "./git.js";
import { resolveRepository, sameRepository } from "./identity.js";
import { loadPlan, savePlan } from "./plan-store.js";
import { decidePolicy, type PolicyContext } from "./policy.js";
import { commandExists, defaultRunner, tail, type ProcessRunner } from "./process.js";
import { randomId } from "./fsutil.js";
import { redact } from "./redact.js";
import { failResult, okResult, type CommandResult } from "./result.js";
import type { CheckKind, Evidence, Plan, ProjectCommands } from "./schema.js";
import { appendJournal, loadActivePointer } from "./state.js";
import { dependenciesSatisfied, rollupStatus } from "./tasks.js";

const ORDER: readonly CheckKind[] = ["format", "lint", "typecheck", "test", "integration", "e2e", "build", "security"];

export interface CheckRun {
  project: string;
  kind: CheckKind;
  status: Evidence["status"];
  command: string | null;
  summary: string;
  counts: Evidence["counts"];
  required: boolean;
}

export interface ValidationData {
  checks: CheckRun[];
  plan: Plan | null;
}

export interface ValidationRequest extends PolicyContext {
  cwd: string;
  planId?: string;
  project?: string;
  includeSecurity?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  runner?: ProcessRunner;
  now?: Date;
}

export function parseCounts(output: string): Evidence["counts"] {
  const maven = /Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+)(?:,\s*Skipped:\s*(\d+))?/i.exec(output);
  if (maven) {
    const total = Number(maven[1]);
    const failed = Number(maven[2]) + Number(maven[3]);
    const skipped = maven[4] ? Number(maven[4]) : 0;
    return { passed: Math.max(0, total - failed - skipped), failed, skipped };
  }
  const vitest = /Tests\s+(\d+)\s+failed(?:\s+\|\s+(\d+)\s+skipped)?\s+\|\s+(\d+)\s+passed/i.exec(output);
  if (vitest) {
    return { failed: Number(vitest[1]), skipped: Number(vitest[2] ?? 0), passed: Number(vitest[3]) };
  }
  const vitestPass = /Tests\s+(\d+)\s+passed/i.exec(output);
  if (vitestPass && !/failed/i.test(output.slice(Math.max(0, vitestPass.index - 40), vitestPass.index + 80))) {
    return { passed: Number(vitestPass[1]), failed: 0, skipped: null };
  }
  const pytest = /(\d+)\s+failed,\s+(\d+)\s+passed|(\d+)\s+passed(?:,\s+(\d+)\s+skipped)?(?:,\s+(\d+)\s+failed)?/i.exec(output);
  if (pytest) {
    if (pytest[1] && pytest[2]) {
      return { failed: Number(pytest[1]), passed: Number(pytest[2]), skipped: null };
    }
    return {
      passed: Number(pytest[3] ?? 0),
      skipped: pytest[4] ? Number(pytest[4]) : null,
      failed: pytest[5] ? Number(pytest[5]) : 0,
    };
  }
  return null;
}

export async function runValidation(input: ValidationRequest): Promise<CommandResult<ValidationData>> {
  const now = input.now ?? new Date();
  const identity = await resolveRepository(input.cwd);
  const config = await loadConfig(identity.root);
  const detected = config ? null : await detectRepository(identity.root);
  const projects = new Map<string, ProjectCommands>();
  if (config) {
    for (const [directory, commands] of Object.entries(config.commands)) {
      projects.set(directory, commands);
    }
  } else if (detected) {
    for (const project of detected.projects) {
      projects.set(project.root, project.commands);
    }
  }
  const required = new Set(config?.qualityGates.required ?? ["test"]);
  const plan = await loadOptionalPlan(identity, input.planId);
  const runner = input.runner ?? defaultRunner;
  const decision = await decidePolicy(config?.policy ?? {
    fileChanges: "prompt",
    shell: "prompt",
    commit: "prompt",
    network: "prompt",
    pullRequest: "prompt",
    allowDestructive: false,
    allowFailedGateCommit: false,
  }, "shell", input, "Run the repository's validation commands?");
  const checks: CheckRun[] = [];
  const head = (await createGitClient(runner).head(identity.root).catch(() => null)) ?? null;
  for (const [directory, commands] of projects) {
    if (input.project && directory !== input.project) continue;
    for (const kind of ORDER) {
      if (kind === "security" && !input.includeSecurity) continue;
      const spec = commands[kind];
      if (!spec) {
        if (required.has(kind)) {
          checks.push({ project: directory, kind, status: "not-run", command: null, summary: `No ${kind} command was discovered.`, counts: null, required: true });
        }
        continue;
      }
      const display = `${spec.command} ${spec.args.join(" ")}`.trim();
      if (!decision.allowed) {
        checks.push({ project: directory, kind, status: "not-run", command: display, summary: decision.reason, counts: null, required: required.has(kind) });
        continue;
      }
      if (kind === "security") {
        const network = await decidePolicy(config?.policy ?? decisionFallback(), "network", input, "Run the network security check?");
        if (!network.allowed) {
          checks.push({ project: directory, kind, status: "not-run", command: display, summary: network.reason, counts: null, required: required.has(kind) });
          continue;
        }
      }
      const exists = await binaryAvailable(identity.root, spec.command, spec.cwd);
      if (!exists) {
        checks.push({
          project: directory,
          kind,
          status: "not-run",
          command: display,
          summary: `${spec.command} is not available on PATH, so the check was not run.`,
          counts: null,
          required: required.has(kind),
        });
        continue;
      }
      if (input.signal?.aborted) {
        checks.push({ project: directory, kind, status: "not-run", command: display, summary: "Cancelled before the command started.", counts: null, required: required.has(kind) });
        continue;
      }
      const cwd = path.resolve(identity.root, spec.cwd === "." ? "" : spec.cwd);
      let result;
      try {
        result = await runner.run(spec.command, spec.args, cwd, { timeoutMs: input.timeoutMs ?? 300_000, signal: input.signal });
      } catch (error) {
        checks.push({
          project: directory,
          kind,
          status: "fail",
          command: display,
          summary: redact(error instanceof Error ? error.message : "The command could not be started."),
          counts: null,
          required: required.has(kind),
        });
        continue;
      }
      const raw = `${result.stdout}\n${result.stderr}`;
      const counts = parseCounts(raw);
      const summary = redact(tail(raw, 30) || (result.timedOut ? "The command timed out." : "The command produced no output."));
      const status = result.cancelled ? "not-run" : result.timedOut || result.code !== 0 ? "fail" : "pass";
      checks.push({
        project: directory,
        kind,
        status,
        command: display,
        summary: result.cancelled ? "Cancelled." : summary,
        counts,
        required: required.has(kind),
      });
    }
  }
  if (plan) {
    attachEvidence(plan, checks, head, now);
    plan.updatedAt = now.toISOString();
    await savePlan(identity.root, plan);
    await appendJournal(identity.root, {
      at: now.toISOString(),
      type: "validation",
      message: checks.map((check) => `${check.project} ${check.kind}: ${check.status}`).join("; ") || "No checks discovered.",
      planId: plan.id,
      taskId: null,
    });
  }
  const failed = checks.some((check) => check.required && check.status !== "pass");
  const message = checks.length === 0
    ? "No validation commands were discovered."
    : checks.map((check) => `${check.status.toUpperCase()} ${check.project} ${check.kind}${check.command ? ` (${check.command})` : ""}: ${check.summary.split("\n")[0] ?? ""}`).join("\n");
  if (!decision.allowed) {
    return failResult(2, "policy-denied", message, { checks, plan }, "Re-run with --yes to allow the configured shell policy.");
  }
  if (failed) {
    return failResult(3, "quality-gate-failed", message, { checks, plan }, "Fix the failing or missing required check. AIDLC did not mark unverified work complete.");
  }
  return okResult("validated", message, { checks, plan });
}

function attachEvidence(plan: Plan, checks: CheckRun[], head: string | null, now: Date): void {
  for (const check of checks) {
    const evidence: Evidence = {
      id: randomId("ev"),
      at: now.toISOString(),
      source: `${check.kind}:${check.project}`,
      status: check.status,
      summary: check.summary,
      command: check.command,
      head,
      counts: check.counts,
    };
    plan.validation.push(evidence);
    const task = plan.tasks.find((candidate) => candidate.kind === "verify" && candidate.verify && sameCommand(candidate.verify, check));
    if (!task) continue;
    task.evidence.push(evidence);
    if (check.status === "pass" && dependenciesSatisfied(task, plan.tasks)) {
      task.status = "completed";
      task.blockers = [];
    } else if (check.status === "fail") {
      task.status = "blocked";
      task.blockers.push(check.summary.split("\n")[0] ?? "Validation failed.");
    } else {
      task.blockers.push(check.summary.split("\n")[0] ?? "Validation was not run.");
    }
  }
  plan.status = rollupStatus(plan.tasks, plan.status);
}

function sameCommand(verify: { command: string; args: string[]; cwd: string }, check: CheckRun): boolean {
  if (!check.command) return false;
  const display = `${verify.command} ${verify.args.join(" ")}`.trim();
  return check.command === display && (check.project === verify.cwd || (check.project === "." && verify.cwd === "."));
}

async function binaryAvailable(root: string, command: string, cwd: string): Promise<boolean> {
  if (command.includes("/") || command.startsWith(".")) {
    try {
      await stat(path.resolve(root, cwd === "." ? "" : cwd, command));
      return true;
    } catch {
      return commandExists(command);
    }
  }
  return commandExists(command);
}

async function loadOptionalPlan(identity: Awaited<ReturnType<typeof resolveRepository>>, planId?: string): Promise<Plan | null> {
  if (planId) {
    const plan = await loadPlan(identity.root, planId);
    if (!sameRepository(plan, identity)) return null;
    return plan;
  }
  const pointer = await loadActivePointer(identity.root).catch(() => null);
  if (!pointer) return null;
  return loadPlan(identity.root, pointer.planId).catch(() => null);
}

function decisionFallback() {
  return {
    fileChanges: "prompt" as const,
    shell: "prompt" as const,
    commit: "prompt" as const,
    network: "prompt" as const,
    pullRequest: "prompt" as const,
    allowDestructive: false,
    allowFailedGateCommit: false,
  };
}

export async function evidenceIsStale(root: string, plan: Plan, files: string[]): Promise<boolean> {
  const relevant = plan.validation.filter((item) => item.status === "pass");
  if (relevant.length === 0) return true;
  const newest = relevant.reduce((latest, item) => (item.at > latest ? item.at : latest), relevant[0]?.at ?? "");
  const latestMs = Date.parse(newest);
  for (const file of files) {
    try {
      const info = await stat(assertInside(root, file));
      if (info.mtimeMs > latestMs + 1000) return true;
    } catch {
      return true;
    }
  }
  return false;
}
