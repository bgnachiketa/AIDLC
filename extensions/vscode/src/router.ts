export interface AidlcSettings {
  yes: boolean;
  dryRun: boolean;
}

export interface Question {
  id: string;
  prompt: string;
}

export interface ActionResult {
  ok: boolean;
  message: string;
  questions?: Question[];
}

export interface AidlcApi {
  help(topic?: string): string;
  init(workspace: string, settings: AidlcSettings): Promise<ActionResult>;
  plan(workspace: string, requirement: string, settings: AidlcSettings): Promise<ActionResult>;
  answer(workspace: string, answers: Record<string, string>, settings: AidlcSettings): Promise<ActionResult>;
  execute(workspace: string, settings: AidlcSettings, signal: AbortSignal): Promise<ActionResult>;
  test(workspace: string, settings: AidlcSettings, signal: AbortSignal): Promise<ActionResult>;
  commit(workspace: string, settings: AidlcSettings): Promise<ActionResult>;
  publish(workspace: string, settings: AidlcSettings): Promise<ActionResult>;
  archive(workspace: string, settings: AidlcSettings): Promise<ActionResult>;
  audit(workspace: string, settings: AidlcSettings): Promise<ActionResult>;
}

export interface AidlcUi {
  output(line: string): void;
  info(message: string): void;
  error(message: string): void;
  input(prompt: string): Promise<string | undefined>;
  confirm(prompt: string): Promise<boolean>;
  progress<T>(title: string, work: (report: (message: string) => void, signal: AbortSignal) => Promise<T>): Promise<T>;
}

export const vscodeCommands = [
  { id: "aidlc.help", canonical: "help-aidlc", title: "AIDLC: Help" },
  { id: "aidlc.plan", canonical: "plan-aidlc", title: "AIDLC: Plan Change" },
  { id: "aidlc.init", canonical: "init-aidlc", title: "AIDLC: Initialize Repository" },
  { id: "aidlc.execute", canonical: "execute-aidlc", title: "AIDLC: Execute Plan" },
  { id: "aidlc.test", canonical: "test-aidlc", title: "AIDLC: Run Validation" },
  { id: "aidlc.commit", canonical: "commit-aidlc", title: "AIDLC: Commit Planned Changes" },
  { id: "aidlc.push", canonical: "push-aidlc", title: "AIDLC: Push and Open Pull Request" },
  { id: "aidlc.archive", canonical: "archive-aidlc", title: "AIDLC: Archive Plan" },
  { id: "aidlc.audit", canonical: "audit-aidlc", title: "AIDLC: Write Changelog Audit" },
] as const;

const PROMPTS: Record<string, string> = {
  "aidlc.init": "Initialize this repository with AIDLC?",
  "aidlc.execute": "Advance the active AIDLC plan?",
  "aidlc.test": "Run the repository validation commands?",
  "aidlc.commit": "Create the planned commit?",
  "aidlc.push": "Push the feature branch and prepare a pull request?",
  "aidlc.archive": "Move the active plan to .github/aidlc/archive?",
  "aidlc.audit": "Write a brief audit to CHANGELOG.md?",
};

export async function dispatchCommand(
  id: string,
  api: AidlcApi,
  ui: AidlcUi,
  workspace: string | undefined,
  settings: AidlcSettings,
): Promise<void> {
  const command = vscodeCommands.find((item) => item.id === id);
  if (!command) {
    ui.error(`Unknown AIDLC command ${id}.`);
    return;
  }
  if (id === "aidlc.help") {
    ui.output(api.help());
    ui.info("AIDLC help was written to the output channel.");
    return;
  }
  if (!workspace) {
    ui.error("Open a workspace folder before running AIDLC.");
    return;
  }
  try {
    if (id === "aidlc.plan") {
      await plan(api, ui, workspace, settings);
      return;
    }
    const prompt = PROMPTS[id];
    const approved = settings.yes || !prompt || (await ui.confirm(prompt));
    if (!approved) {
      ui.info("AIDLC did not run.");
      return;
    }
    const effective = { ...settings, yes: true };
    await ui.progress(command.title, async (report, signal) => {
      if (signal.aborted) {
        throw new Error("Cancelled");
      }
      report(command.canonical);
      const result = await run(id, api, workspace, effective, signal);
      if (signal.aborted) {
        throw new Error("Cancelled");
      }
      ui.output(result.message);
      if (!result.ok) {
        throw new Error(result.message);
      }
      ui.info(firstLine(result.message));
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "AIDLC command failed";
    ui.error(message.includes("Cancelled") ? "AIDLC command cancelled." : message);
  }
}

async function plan(api: AidlcApi, ui: AidlcUi, workspace: string, settings: AidlcSettings): Promise<void> {
  const requirement = await ui.input("What should change? Include the expected behavior.");
  if (!requirement?.trim()) {
    ui.error("A requirement is required before planning.");
    return;
  }
  let result = await api.plan(workspace, requirement.trim(), settings);
  const answers: Record<string, string> = {};
  for (const question of result.questions ?? []) {
    const answer = await ui.input(question.prompt);
    if (answer?.trim()) {
      answers[question.id] = answer.trim();
    }
  }
  if (Object.keys(answers).length > 0) {
    result = await api.answer(workspace, answers, settings);
  }
  ui.output(result.message);
  if (result.ok) {
    ui.info(firstLine(result.message));
  } else {
    ui.error(firstLine(result.message));
  }
}

async function run(id: string, api: AidlcApi, workspace: string, settings: AidlcSettings, signal: AbortSignal): Promise<ActionResult> {
  if (id === "aidlc.init") return api.init(workspace, settings);
  if (id === "aidlc.execute") return api.execute(workspace, settings, signal);
  if (id === "aidlc.test") return api.test(workspace, settings, signal);
  if (id === "aidlc.commit") return api.commit(workspace, settings);
  if (id === "aidlc.push") return api.publish(workspace, settings);
  if (id === "aidlc.archive") return api.archive(workspace, settings);
  if (id === "aidlc.audit") return api.audit(workspace, settings);
  throw new Error(`Unknown AIDLC command ${id}.`);
}

function firstLine(message: string): string {
  return message.split("\n").find((line) => line.trim().length > 0) ?? "AIDLC finished";
}
