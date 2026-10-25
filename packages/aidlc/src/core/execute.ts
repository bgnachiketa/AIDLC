import { loadConfig } from "./config.js";
import { randomId } from "./fsutil.js";
import { createGitClient, type GitClient } from "./git.js";
import { resolveRepository, sameRepository } from "./identity.js";
import { loadPlan, savePlan } from "./plan-store.js";
import { decidePolicy, type PolicyContext } from "./policy.js";
import { defaultRunner, tail, type ProcessRunner } from "./process.js";
import { redact } from "./redact.js";
import { failResult, okResult, type CommandResult } from "./result.js";
import type { Evidence, Plan, Task } from "./schema.js";
import { appendJournal, loadActivePointer } from "./state.js";
import { dependenciesSatisfied, orderTasks, rollupStatus } from "./tasks.js";
import path from "node:path";

export interface ExecuteRequest extends PolicyContext {
  cwd: string;
  planId?: string;
  dryRun?: boolean;
  approve?: boolean;
  acceptAssumptions?: boolean;
  taskId?: string;
  action?: "run" | "status" | "start" | "complete" | "block" | "skip" | "verify";
  evidence?: string;
  reason?: string;
  now?: Date;
  runner?: ProcessRunner;
  signal?: AbortSignal;
  git?: GitClient;
}

export interface ExecuteData {
  plan: Plan | null;
  packet: WorkPacket | null;
  warnings: string[];
}

export interface WorkPacket {
  planId: string;
  taskId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  paths: string[];
  instructions: string;
}

export async function executePlan(input: ExecuteRequest): Promise<CommandResult<ExecuteData>> {
  const now = input.now ?? new Date();
  const identity = await resolveRepository(input.cwd, input.runner);
  const pointer = input.planId ? null : await loadActivePointer(identity.root).catch((error) => {
    throw error;
  });
  if (!input.planId && !pointer) {
    return failResult(2, "not-found", "No active plan is selected.", { plan: null, packet: null, warnings: [] }, "Create one with plan-aidlc.");
  }
  const plan = await loadPlan(identity.root, input.planId ?? pointer?.planId ?? "");
  if (!sameRepository(plan, identity)) {
    return failResult(2, "repository-mismatch", `Plan ${plan.id} belongs to another repository.`, { plan, packet: null, warnings: [] }, "Run from the repository that created the plan.");
  }
  const action = input.action ?? "run";
  if (action === "status" || input.dryRun) {
    const next = nextActionable(plan);
    return okResult("status", `${describe(plan)}\n${next ? packetText(packetFor(plan, next)) : "No actionable task."}`, {
      plan,
      packet: next ? packetFor(plan, next) : null,
      warnings: [],
    });
  }
  if (plan.status === "cancelled") {
    return failResult(2, "cancelled", `Plan ${plan.id} is cancelled.`, { plan, packet: null, warnings: [] }, "Create a new plan.");
  }
  if (input.acceptAssumptions) acceptBlockingQuestions(plan);
  if (plan.questions.some((question) => question.blocking && !question.answer)) {
    return failResult(2, "needs-clarification", `Plan ${plan.id} is waiting for clarification.`, { plan, packet: null, warnings: [] }, "Answer the blocking questions or pass --accept-assumptions.");
  }
  if (plan.approval.status !== "approved") {
    if (!input.approve) {
      return failResult(2, "not-approved", `Plan ${plan.id} is ${plan.status} and is not approved.`, { plan, packet: null, warnings: [] }, "Approve it with plan-aidlc --approve or execute-aidlc --approve.");
    }
    plan.approval = { status: "approved", at: now.toISOString(), note: "Approved with execute-aidlc --approve." };
    if (plan.status === "awaiting-approval" || plan.status === "needs-clarification" || plan.status === "draft") {
      plan.status = "approved";
    }
  }
  const config = await loadConfig(identity.root);
  const decision = await decidePolicy(config?.policy ?? {
    fileChanges: "prompt", shell: "prompt", commit: "prompt", network: "prompt", pullRequest: "prompt", allowDestructive: false, allowFailedGateCommit: false,
  }, "fileChanges", input, "Update AIDLC plan state for this execution?");
  if (!decision.allowed) {
    return failResult(2, "policy-denied", decision.reason, { plan, packet: null, warnings: [] }, "Re-run with --yes to allow plan updates.");
  }
  const git = input.git ?? createGitClient(input.runner ?? defaultRunner);
  const snapshot = await git.snapshot(identity.root);
  const warnings = snapshot.files
    .filter((file) => plan.baseline.dirty.includes(file.path))
    .map((file) => `Pre-existing modification left untouched: ${file.path}`);
  if (action === "start" || action === "complete" || action === "block" || action === "skip" || action === "verify") {
    const result = await applyTaskAction(plan, action, input, now, identity.root, git);
    plan.updatedAt = now.toISOString();
    plan.status = rollupStatus(plan.tasks, plan.status);
    await savePlan(identity.root, plan);
    await appendJournal(identity.root, { at: plan.updatedAt, type: `task-${action}`, message: result.message, planId: plan.id, taskId: input.taskId ?? null });
    return result.ok
      ? okResult(result.code, `${result.message}\n${warnings.join("\n")}`.trim(), { plan, packet: result.packet, warnings })
      : failResult(result.exitCode, result.code, result.message, { plan, packet: result.packet, warnings }, result.recovery);
  }
  orderTasks(plan.tasks);
  for (const task of plan.tasks) {
    if (task.kind === "inspect" && task.status === "pending" && dependenciesSatisfied(task, plan.tasks)) {
      task.status = "completed";
      task.evidence.push(evidence(now, "planner-inspection", "pass", `Affected components: ${plan.architecture.affectedComponents.join(", ") || "none recorded."}`, null, snapshot.head));
    }
  }
  const verifyTask = plan.tasks.find((task) => task.kind === "verify" && task.status !== "completed" && task.status !== "skipped" && dependenciesSatisfied(task, plan.tasks) && task.verify);
  if (verifyTask?.verify) {
    const shell = await decidePolicy(config?.policy ?? {
      fileChanges: "allow", shell: "prompt", commit: "prompt", network: "prompt", pullRequest: "prompt", allowDestructive: false, allowFailedGateCommit: false,
    }, "shell", input, `Run verification for ${verifyTask.id}?`);
    if (!shell.allowed) {
      verifyTask.status = "blocked";
      verifyTask.blockers.push(shell.reason);
    } else {
      const cwd = path.resolve(identity.root, verifyTask.verify.cwd);
      const result = await (input.runner ?? defaultRunner).run(verifyTask.verify.command, verifyTask.verify.args, cwd, { timeoutMs: 300_000, signal: input.signal });
      const summary = redact(tail(`${result.stdout}\n${result.stderr}`, 20));
      const status = result.cancelled ? "not-run" : result.code === 0 && !result.timedOut ? "pass" : "fail";
      const item = evidence(now, `verify:${verifyTask.id}`, status, summary || "Verification finished without output.", `${verifyTask.verify.command} ${verifyTask.verify.args.join(" ")}`, snapshot.head);
      verifyTask.evidence.push(item);
      plan.validation.push(item);
      verifyTask.status = status === "pass" ? "completed" : "blocked";
      if (status !== "pass") verifyTask.blockers.push(summary.split("\n")[0] || "Verification failed.");
    }
  }
  const next = plan.tasks.find((task) => (task.kind === "implement" || task.kind === "review") && task.status !== "completed" && task.status !== "skipped" && dependenciesSatisfied(task, plan.tasks));
  let packet: WorkPacket | null = null;
  if (next && next.status === "pending") {
    next.status = "in-progress";
  }
  if (next) packet = packetFor(plan, next);
  plan.updatedAt = now.toISOString();
  plan.status = rollupStatus(plan.tasks, plan.status === "approved" ? "in-progress" : plan.status);
  if (plan.tasks.some((task) => task.status === "in-progress" || task.status === "completed") && plan.status === "approved") {
    plan.status = "in-progress";
  }
  plan.status = rollupStatus(plan.tasks, plan.status);
  await savePlan(identity.root, plan);
  await appendJournal(identity.root, { at: plan.updatedAt, type: "execute", message: packet ? `Stopped at ${packet.taskId}` : "No remaining manual task.", planId: plan.id, taskId: packet?.taskId ?? null });
  const message = [describe(plan), ...warnings, packet ? packetText(packet) : "No manual task is ready."].filter(Boolean).join("\n");
  if (verifyTask && verifyTask.status === "blocked") {
    return failResult(3, "quality-gate-failed", message, { plan, packet, warnings }, "Fix the verification failure and rerun execute-aidlc or test-aidlc.");
  }
  return okResult("executed", message, { plan, packet, warnings });
}

async function applyTaskAction(
  plan: Plan,
  action: "start" | "complete" | "block" | "skip" | "verify",
  input: ExecuteRequest,
  now: Date,
  root: string,
  git: GitClient,
): Promise<{ ok: boolean; exitCode: number; code: string; message: string; recovery?: string; packet: WorkPacket | null }> {
  const task = plan.tasks.find((candidate) => candidate.id === input.taskId);
  if (!task) {
    return { ok: false, exitCode: 2, code: "not-found", message: "Pass --task with a task id such as T2.", packet: null };
  }
  if (!dependenciesSatisfied(task, plan.tasks) && task.status !== "completed") {
    return { ok: false, exitCode: 2, code: "blocked", message: `${task.id} is waiting on ${task.dependsOn.join(", ")}.`, packet: packetFor(plan, task) };
  }
  if (action === "start") {
    if (task.status === "completed") return { ok: true, exitCode: 0, code: "unchanged", message: `${task.id} is already completed.`, packet: null };
    task.status = "in-progress";
    return { ok: true, exitCode: 0, code: "started", message: `${task.id} is in progress.`, packet: packetFor(plan, task) };
  }
  if (action === "block") {
    if (!input.reason) return { ok: false, exitCode: 2, code: "needs-clarification", message: "Pass --reason when blocking a task.", packet: null };
    task.status = "blocked";
    task.blockers.push(input.reason);
    return { ok: true, exitCode: 0, code: "blocked", message: `${task.id} is blocked: ${input.reason}`, packet: packetFor(plan, task) };
  }
  if (action === "skip") {
    if (!input.reason) return { ok: false, exitCode: 2, code: "needs-clarification", message: "Pass --reason when skipping a task.", packet: null };
    task.status = "skipped";
    task.blockers.push(`Skipped: ${input.reason}`);
    return { ok: true, exitCode: 0, code: "skipped", message: `${task.id} was skipped: ${input.reason}`, packet: null };
  }
  if (action === "verify" || (action === "complete" && task.kind === "verify")) {
    if (!task.verify) return { ok: false, exitCode: 2, code: "not-run", message: `${task.id} has no verification command.`, packet: packetFor(plan, task) };
    const cwd = path.resolve(root, task.verify.cwd);
    const result = await (input.runner ?? defaultRunner).run(task.verify.command, task.verify.args, cwd, { signal: input.signal, timeoutMs: 300_000 });
    const summary = redact(tail(`${result.stdout}\n${result.stderr}`, 20));
    const status = result.code === 0 && !result.timedOut && !result.cancelled ? "pass" : "fail";
    const head = await git.head(root);
    const item = evidence(now, `verify:${task.id}`, status, summary || "No output.", `${task.verify.command} ${task.verify.args.join(" ")}`, head);
    task.evidence.push(item);
    plan.validation.push(item);
    if (status !== "pass") {
      task.status = "blocked";
      task.blockers.push(summary.split("\n")[0] || "Verification failed.");
      return { ok: false, exitCode: 3, code: "quality-gate-failed", message: `${task.id} verification failed.\n${summary}`, packet: packetFor(plan, task) };
    }
    task.status = "completed";
    task.blockers = [];
    return { ok: true, exitCode: 0, code: "completed", message: `${task.id} verification passed.`, packet: null };
  }
  if (task.status === "completed") {
    return { ok: true, exitCode: 0, code: "unchanged", message: `${task.id} is already completed. It was not repeated.`, packet: null };
  }
  const note = input.evidence?.trim() ?? "";
  if (note.length < 10) {
    return { ok: false, exitCode: 2, code: "needs-evidence", message: `Refusing to complete ${task.id} without evidence.`, recovery: "Pass --evidence with what changed and which checks you ran.", packet: packetFor(plan, task) };
  }
  task.evidence.push(evidence(now, "attestation", "pass", note, null, await git.head(root)));
  task.status = "completed";
  task.blockers = [];
  return { ok: true, exitCode: 0, code: "completed", message: `${task.id} completed with recorded evidence.`, packet: null };
}

function acceptBlockingQuestions(plan: Plan): void {
  for (const question of plan.questions) {
    if (question.blocking && !question.answer) {
      question.answer = "[accepted assumption]";
      plan.assumptions.push({ id: `a-${question.id}`, text: `Proceeding without an answer: ${question.prompt}`, blocking: false, resolved: false });
    }
  }
}

function nextActionable(plan: Plan): Task | null {
  try {
    orderTasks(plan.tasks);
  } catch {
    return null;
  }
  return plan.tasks.find((task) => task.status !== "completed" && task.status !== "skipped" && dependenciesSatisfied(task, plan.tasks)) ?? null;
}

function packetFor(plan: Plan, task: Task): WorkPacket {
  return {
    planId: plan.id,
    taskId: task.id,
    title: task.title,
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    paths: task.paths,
    instructions: [
      `Implement only ${task.id}.`,
      "Inspect the current code before editing. Keep the change small.",
      "Add or update tests for the behavior, then run test-aidlc.",
      `Record completion with: aidlc execute-aidlc --task ${task.id} --complete --evidence "<what changed and which checks passed>"`,
      "Do not mark the task complete from a Markdown checkbox.",
    ].join(" "),
  };
}

function packetText(packet: WorkPacket): string {
  return [`Next task ${packet.taskId}: ${packet.title}`, packet.description, `Acceptance: ${packet.acceptanceCriteria.join("; ")}`, packet.instructions].join("\n");
}

function describe(plan: Plan): string {
  return `${plan.id} [${plan.status}] ${plan.tasks.map((task) => `${task.id}:${task.status}`).join(", ")}`;
}

function evidence(now: Date, source: string, status: Evidence["status"], summary: string, command: string | null, head: string | null): Evidence {
  return { id: randomId("ev"), at: now.toISOString(), source, status, summary, command, head, counts: null };
}
