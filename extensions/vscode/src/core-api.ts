import {
  archivePlan,
  commitChanges,
  executePlan,
  formatHelp,
  initializeRepository,
  planChange,
  publishPlan,
  runValidation,
  writeAudit,
} from "aidlc";
import type { ActionResult, AidlcApi, AidlcSettings } from "./router.js";

export function createCoreApi(): AidlcApi {
  return {
    help(topic) {
      return formatHelp(topic);
    },
    async init(workspace, settings) {
      const result = await initializeRepository({ cwd: workspace, ...context(settings) });
      return { ok: result.ok, message: result.message };
    },
    async plan(workspace, requirement, settings) {
      const result = await planChange({ cwd: workspace, requirement, dryRun: settings.dryRun });
      return toPlanResult(result.ok, result.message, result.data.plan?.questions ?? []);
    },
    async answer(workspace, answers, settings) {
      const result = await planChange({ cwd: workspace, answers, dryRun: settings.dryRun });
      return toPlanResult(result.ok, result.message, result.data.plan?.questions ?? []);
    },
    async execute(workspace, settings, signal) {
      const result = await executePlan({ cwd: workspace, signal, ...context(settings) });
      return { ok: result.ok, message: result.message };
    },
    async test(workspace, settings, signal) {
      const result = await runValidation({ cwd: workspace, signal, ...context(settings) });
      return { ok: result.ok, message: result.message };
    },
    async commit(workspace, settings) {
      const result = await commitChanges({ cwd: workspace, ...context(settings) });
      return { ok: result.ok, message: result.message };
    },
    async publish(workspace, settings) {
      const result = await publishPlan({ cwd: workspace, ...context(settings) });
      return { ok: result.ok, message: result.message };
    },
    async archive(workspace, settings) {
      const result = await archivePlan({ cwd: workspace, ...context(settings) });
      return { ok: result.ok, message: result.message };
    },
    async audit(workspace, settings) {
      const result = await writeAudit({ cwd: workspace, ...context(settings) });
      return { ok: result.ok, message: result.message };
    },
  };
}

function context(settings: AidlcSettings) {
  return {
    yes: settings.yes,
    dryRun: settings.dryRun,
    nonInteractive: true,
    tty: false,
  };
}

function toPlanResult(ok: boolean, message: string, questions: Array<{ id: string; prompt: string; answer: string | null; blocking: boolean }>): ActionResult {
  return {
    ok,
    message,
    questions: questions.filter((question) => question.blocking && !question.answer).map((question) => ({ id: question.id, prompt: question.prompt })),
  };
}
