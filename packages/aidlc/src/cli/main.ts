import { Command, CommanderError } from "commander";
import { archivePlan } from "../core/archive.js";
import { writeAudit } from "../core/audit.js";
import { commitChanges } from "../core/commit.js";
import { AidlcError } from "../core/errors.js";
import { executePlan } from "../core/execute.js";
import { commandHelp, formatHelp } from "../core/help.js";
import { initializeRepository } from "../core/initialize.js";
import { planChange } from "../core/planner.js";
import { publishPlan } from "../core/publish.js";
import type { CommandResult } from "../core/result.js";
import type { ChangeType } from "../core/schema.js";
import { runValidation } from "../core/checks.js";

interface Globals {
  cwd: string;
  json?: boolean;
  yes?: boolean;
  nonInteractive?: boolean;
  dryRun?: boolean;
}

export async function main(argv: string[], invokedAs?: string): Promise<number> {
  const holderReset = (holder.code = 0);
  void holderReset;
  const program = new Command();
  program
    .name(invokedAs && invokedAs !== "aidlc" ? invokedAs : "aidlc")
    .description("AIDLC local development lifecycle")
    .option("--cwd <path>", "Repository root, or any directory inside it", process.cwd())
    .option("--json", "Print a JSON envelope")
    .option("-y, --yes", "Approve policy prompts for this invocation")
    .option("--non-interactive", "Do not prompt")
    .option("--dry-run", "Report actions without writing");
  program.exitOverride();
  program.showHelpAfterError();

  program.command("help-aidlc").argument("[topic]", "Help topic or command name").description("Show AIDLC help").action(async function (this: Command, topic?: string) {
    const text = formatHelp(topic);
    await emit(this, { ok: true, exitCode: 0, code: "help", message: text, data: { topic: topic ?? "overview" } });
  });
  program.command("plan-aidlc")
    .description("Create or manage an implementation plan")
    .argument("[requirement...]", "What should change")
    .option("--title <title>", "Plan title")
    .option("--type <type>", "feature, bugfix, refactor, performance, security, documentation, infrastructure, or other")
    .option("--plan <id>", "Plan id")
    .option("--answer <pair...>", "Answer a blocking question as id=value")
    .option("--approve", "Approve the plan")
    .option("--switch", "Keep the current plan and start a new active plan")
    .option("--revise", "Revise the selected plan")
    .option("--list", "List plans")
    .option("--show", "Show the selected plan")
    .option("--select <id>", "Select the active plan")
    .option("--cancel", "Cancel the selected plan")
    .option("--repair", "Quarantine corrupt state files")
    .option("--accept-assumptions", "Record unanswered blockers as explicit assumptions")
    .addHelpText("after", `\n${commandHelp("plan-aidlc")}`)
    .action(async function (this: Command, requirement: string[], options: Record<string, unknown>) {
      const globals = this.optsWithGlobals() as Globals;
      const result = await planChange({
        cwd: globals.cwd,
        requirement: requirement.join(" "),
        title: stringOption(options.title),
        changeType: parseChangeType(stringOption(options.type)),
        answers: parseAnswers(options.answer),
        approve: Boolean(options.approve),
        acceptAssumptions: Boolean(options.acceptAssumptions),
        switchPlan: Boolean(options.switch),
        revise: Boolean(options.revise),
        planId: stringOption(options.plan),
        list: Boolean(options.list),
        show: Boolean(options.show),
        select: stringOption(options.select),
        cancel: Boolean(options.cancel),
        repair: Boolean(options.repair),
        dryRun: Boolean(globals.dryRun),
      });
      await emit(this, result);
    });
  program.command("init-aidlc")
    .description("Initialize the repository for AIDLC")
    .option("--with-ci", "Also install a reviewable workflow when no aidlc-ci.yml exists")
    .option("--refresh-commands", "Replace detected commands in the config")
    .addHelpText("after", `\n${commandHelp("init-aidlc")}`)
    .action(async function (this: Command, options: { withCi?: boolean; refreshCommands?: boolean }) {
      const globals = this.optsWithGlobals() as Globals;
      const result = await initializeRepository({
        cwd: globals.cwd,
        dryRun: Boolean(globals.dryRun),
        withCi: Boolean(options.withCi),
        refreshCommands: Boolean(options.refreshCommands),
        yes: Boolean(globals.yes),
        nonInteractive: Boolean(globals.nonInteractive) || !process.stdout.isTTY,
        tty: process.stdout.isTTY,
      });
      await emit(this, result);
    });
  program.command("execute-aidlc")
    .description("Advance the active plan")
    .option("--plan <id>", "Plan id")
    .option("--approve", "Approve the plan before executing")
    .option("--accept-assumptions", "Accept unresolved blocking questions")
    .option("--task <id>", "Task id")
    .option("--start", "Mark the task in progress")
    .option("--complete", "Complete the task")
    .option("--block", "Block the task")
    .option("--skip", "Skip the task")
    .option("--verify", "Run the task verification command")
    .option("--status", "Print status without writing")
    .option("--evidence <text>", "Evidence for completion")
    .option("--reason <text>", "Reason for block or skip")
    .addHelpText("after", `\n${commandHelp("execute-aidlc")}`)
    .action(async function (this: Command, options: Record<string, unknown>) {
      const globals = this.optsWithGlobals() as Globals;
      const flags = ["start", "complete", "block", "skip", "verify", "status"].filter((name) => options[name]);
      if (flags.length > 1) {
        await emit(this, { ok: false, exitCode: 2, code: "invalid-arguments", message: "Pass only one of --start, --complete, --block, --skip, --verify, or --status.", data: null });
        return;
      }
      const action = flags[0] === "status" ? "status" : flags[0] === "start" ? "start" : flags[0] === "complete" ? "complete" : flags[0] === "block" ? "block" : flags[0] === "skip" ? "skip" : flags[0] === "verify" ? "verify" : "run";
      const result = await executePlan({
        cwd: globals.cwd,
        planId: stringOption(options.plan),
        dryRun: Boolean(globals.dryRun),
        approve: Boolean(options.approve),
        acceptAssumptions: Boolean(options.acceptAssumptions),
        taskId: stringOption(options.task),
        action,
        evidence: stringOption(options.evidence),
        reason: stringOption(options.reason),
        yes: Boolean(globals.yes),
        nonInteractive: Boolean(globals.nonInteractive) || !process.stdout.isTTY,
        tty: process.stdout.isTTY,
      });
      await emit(this, result);
    });
  program.command("test-aidlc")
    .description("Run discovered validation commands")
    .option("--plan <id>", "Plan id")
    .option("--project <path>", "Limit checks to one project directory")
    .option("--include-security", "Run discovered security checks when network policy allows")
    .option("--timeout <ms>", "Per-command timeout in milliseconds")
    .addHelpText("after", `\n${commandHelp("test-aidlc")}`)
    .action(async function (this: Command, options: Record<string, unknown>) {
      const globals = this.optsWithGlobals() as Globals;
      const timeout = stringOption(options.timeout);
      const result = await runValidation({
        cwd: globals.cwd,
        planId: stringOption(options.plan),
        project: stringOption(options.project),
        includeSecurity: Boolean(options.includeSecurity),
        timeoutMs: timeout ? Number(timeout) : undefined,
        yes: Boolean(globals.yes),
        nonInteractive: Boolean(globals.nonInteractive) || !process.stdout.isTTY,
        tty: process.stdout.isTTY,
      });
      await emit(this, result);
    });
  program.command("commit-aidlc")
    .description("Commit planned changes safely")
    .option("--plan <id>", "Plan id")
    .option("--message <text>", "Commit subject")
    .option("--paths <path...>", "Explicit files to consider")
    .option("--include <path...>", "Include a file that was dirty before planning")
    .option("--split", "Split docs, tests, CI, and source into separate commits")
    .option("--allow-failed-gates", "Permit a commit when a required gate is not passing")
    .option("--exception <reason>", "Required reason when allowing a failed gate")
    .option("--accept-stale", "Permit a commit when evidence is older than the files")
    .option("--amend", "Amend the previous commit. This is never the default.")
    .addHelpText("after", `\n${commandHelp("commit-aidlc")}`)
    .action(async function (this: Command, options: Record<string, unknown>) {
      const globals = this.optsWithGlobals() as Globals;
      const result = await commitChanges({
        cwd: globals.cwd,
        planId: stringOption(options.plan),
        message: stringOption(options.message),
        paths: stringList(options.paths),
        include: stringList(options.include),
        split: Boolean(options.split),
        dryRun: Boolean(globals.dryRun),
        allowFailedGates: Boolean(options.allowFailedGates),
        exception: stringOption(options.exception),
        amend: Boolean(options.amend),
        acceptStale: Boolean(options.acceptStale),
        yes: Boolean(globals.yes),
        nonInteractive: Boolean(globals.nonInteractive) || !process.stdout.isTTY,
        tty: process.stdout.isTTY,
      });
      await emit(this, result);
    });
  program.command("push-aidlc")
    .description("Push a feature branch and prepare a pull request")
    .option("--plan <id>", "Plan id")
    .option("--base <branch>", "Base branch", undefined)
    .option("--remote <name>", "Git remote", "origin")
    .option("--allow-incomplete", "Publish even when planned tasks remain")
    .option("--accept-stale", "Publish even when validation is attached to another commit")
    .option("--allow-failed-gates", "Publish even when a required gate is not passing")
    .option("--exception <reason>", "Required reason when allowing a failed gate")
    .option("--allow-main-ahead", "Allow creating a branch when the base branch has local commits")
    .addHelpText("after", `\n${commandHelp("push-aidlc")}`)
    .action(async function (this: Command, options: Record<string, unknown>) {
      const globals = this.optsWithGlobals() as Globals;
      const result = await publishPlan({
        cwd: globals.cwd,
        planId: stringOption(options.plan),
        base: stringOption(options.base),
        remote: stringOption(options.remote),
        dryRun: Boolean(globals.dryRun),
        allowIncomplete: Boolean(options.allowIncomplete),
        acceptStale: Boolean(options.acceptStale),
        allowFailedGates: Boolean(options.allowFailedGates),
        exception: stringOption(options.exception),
        allowMainAhead: Boolean(options.allowMainAhead),
        yes: Boolean(globals.yes),
        nonInteractive: Boolean(globals.nonInteractive) || !process.stdout.isTTY,
        tty: process.stdout.isTTY,
      });
      await emit(this, result);
    });
  program.command("archive-aidlc")
    .description("Move a plan into .github/aidlc/archive")
    .option("--plan <id>", "Plan id. Defaults to the active plan.")
    .addHelpText("after", `\n${commandHelp("archive-aidlc")}`)
    .action(async function (this: Command, options: Record<string, unknown>) {
      const globals = this.optsWithGlobals() as Globals;
      const result = await archivePlan({
        cwd: globals.cwd,
        planId: stringOption(options.plan),
        dryRun: Boolean(globals.dryRun),
        yes: Boolean(globals.yes),
        nonInteractive: Boolean(globals.nonInteractive) || !process.stdout.isTTY,
        tty: process.stdout.isTTY,
      });
      await emit(this, result);
    });
  program.command("audit-aidlc")
    .description("Write a brief plan audit to CHANGELOG.md")
    .addHelpText("after", `\n${commandHelp("audit-aidlc")}`)
    .action(async function (this: Command) {
      const globals = this.optsWithGlobals() as Globals;
      const result = await writeAudit({
        cwd: globals.cwd,
        dryRun: Boolean(globals.dryRun),
        yes: Boolean(globals.yes),
        nonInteractive: Boolean(globals.nonInteractive) || !process.stdout.isTTY,
        tty: process.stdout.isTTY,
      });
      await emit(this, result);
    });

  program.action(async function (this: Command) {
    await emit(this, { ok: true, exitCode: 0, code: "help", message: formatHelp(), data: null });
  });

  const normalized = normalizeArgv(argv, invokedAs);
  try {
    await program.parseAsync(normalized);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.help") {
        return 0;
      }
      process.stderr.write(`${error.message}\n`);
      return error.exitCode || 1;
    }
    if (error instanceof AidlcError) {
      const globals = program.opts<Globals>();
      writeError(Boolean(globals.json), error);
      return error.code === "quality-gate-failed" ? 3 : 1;
    }
    process.stderr.write(`${error instanceof Error ? error.message : "Unexpected failure"}\n`);
    return 1;
  }
  return holder.code;
}

const holder = { code: 0 };

async function emit(command: Command, result: CommandResult<unknown>): Promise<void> {
  holder.code = result.exitCode;
  const globals = command.optsWithGlobals() as Globals;
  if (globals.json) {
    process.stdout.write(`${JSON.stringify({ ok: result.ok, code: result.code, message: result.message, recovery: result.recovery ?? null, data: result.data })}\n`);
    return;
  }
  process.stdout.write(`${result.message}\n`);
  if (result.recovery) {
    process.stderr.write(`${result.recovery}\n`);
  }
}

function writeError(json: boolean, error: AidlcError): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: error.code, message: error.message, recovery: error.recovery ?? null, data: null })}\n`);
    return;
  }
  process.stderr.write(`${error.message}\n`);
  if (error.recovery) process.stderr.write(`${error.recovery}\n`);
}

export function normalizeArgv(argv: string[], invokedAs?: string): string[] {
  const node = argv[0] ?? "node";
  const script = argv[1] ?? "aidlc";
  const rest = argv.slice(2);
  if (invokedAs && invokedAs !== "aidlc") {
    return [node, script, invokedAs, ...rest];
  }
  return argv;
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function parseAnswers(value: unknown): Record<string, string> {
  const answers: Record<string, string> = {};
  const pairs = Array.isArray(value) ? value : [];
  for (const pair of pairs) {
    if (typeof pair !== "string") continue;
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    answers[pair.slice(0, index)] = pair.slice(index + 1);
  }
  return answers;
}

function parseChangeType(value: string | undefined): ChangeType | undefined {
  const allowed: ChangeType[] = ["feature", "bugfix", "refactor", "performance", "security", "documentation", "infrastructure", "other"];
  if (!value) return undefined;
  if (!allowed.includes(value as ChangeType)) {
    throw new AidlcError(`Unknown change type ${value}`, {
      code: "invalid-arguments",
      recovery: `Use one of: ${allowed.join(", ")}.`,
    });
  }
  return value as ChangeType;
}
