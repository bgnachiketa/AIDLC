import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi, type Mock } from "vitest";
import { dispatchCommand, vscodeCommands, type ActionResult, type AidlcApi, type AidlcUi } from "./router.js";

describe("VS Code command registration", () => {
  it("registers the lifecycle commands in package.json", () => {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      contributes: { commands: Array<{ command: string; title: string }> };
    };
    expect(pkg.contributes.commands.map((command) => command.command)).toEqual(vscodeCommands.map((command) => command.id));
    expect(pkg.contributes.commands.map((command) => command.title)).toEqual(vscodeCommands.map((command) => command.title));
    expect(vscodeCommands.map((command) => command.canonical)).toEqual([
      "help-aidlc",
      "plan-aidlc",
      "init-aidlc",
      "execute-aidlc",
      "test-aidlc",
      "commit-aidlc",
      "push-aidlc",
      "archive-aidlc",
      "audit-aidlc",
    ]);
  });

  it("writes help without requiring a workspace", async () => {
    const api = fakeApi();
    const ui = fakeUi();
    await dispatchCommand("aidlc.help", api, ui, undefined, { yes: false, dryRun: false });
    expect(api.help).toHaveBeenCalled();
    expect(ui.output).toHaveBeenCalledWith("help text");
    expect(ui.error).not.toHaveBeenCalled();
  });

  it("asks for a requirement and records answers", async () => {
    const api = fakeApi();
    api.plan.mockResolvedValueOnce({ ok: false, message: "need detail", questions: [{ id: "q-behavior", prompt: "What changes?" }] });
    api.answer.mockResolvedValueOnce({ ok: true, message: "plan-1 awaiting-approval", questions: [] });
    const ui = fakeUi();
    ui.input.mockResolvedValueOnce("Add export").mockResolvedValueOnce("Download paid invoices as CSV");
    await dispatchCommand("aidlc.plan", api, ui, "/repo", { yes: false, dryRun: false });
    expect(api.plan).toHaveBeenCalledWith("/repo", "Add export", { yes: false, dryRun: false });
    expect(api.answer).toHaveBeenCalledWith("/repo", { "q-behavior": "Download paid invoices as CSV" }, { yes: false, dryRun: false });
    expect(ui.info).toHaveBeenCalled();
  });

  it("does not initialize when confirmation is declined", async () => {
    const api = fakeApi();
    const ui = fakeUi();
    ui.confirm.mockResolvedValue(false);
    await dispatchCommand("aidlc.init", api, ui, "/repo", { yes: false, dryRun: false });
    expect(api.init).not.toHaveBeenCalled();
  });

  it("reports cancellation instead of success", async () => {
    const api = fakeApi();
    const ui = fakeUi();
    ui.confirm.mockResolvedValue(true);
    ui.progress.mockImplementation(async (_title, work) => {
      const controller = new AbortController();
      controller.abort();
      return work(() => undefined, controller.signal);
    });
    await dispatchCommand("aidlc.test", api, ui, "/repo", { yes: false, dryRun: false });
    expect(ui.error).toHaveBeenCalledWith("AIDLC command cancelled.");
    expect(ui.info).not.toHaveBeenCalled();
  });

  it("surfaces a failed validation without marking it successful", async () => {
    const api = fakeApi();
    const ui = fakeUi();
    ui.confirm.mockResolvedValue(true);
    api.test.mockImplementation(async (_workspace, _settings, signal) => {
      expect(signal.aborted).toBe(false);
      return { ok: false, message: "FAIL test: 1 failed" };
    });
    await dispatchCommand("aidlc.test", api, ui, "/repo", { yes: true, dryRun: false });
    expect(ui.error).toHaveBeenCalledWith("FAIL test: 1 failed");
    expect(ui.info).not.toHaveBeenCalled();
  });
});

function fakeApi(): AidlcApi & {
  help: ReturnType<typeof vi.fn>;
  init: ReturnType<typeof vi.fn>;
  plan: ReturnType<typeof vi.fn>;
  answer: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  test: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  archive: ReturnType<typeof vi.fn>;
  audit: ReturnType<typeof vi.fn>;
} {
  return {
    help: vi.fn(() => "help text"),
    init: vi.fn(async () => ({ ok: true, message: "initialized" })),
    plan: vi.fn(async () => ({ ok: true, message: "planned" })),
    answer: vi.fn(async () => ({ ok: true, message: "answered" })),
    execute: vi.fn(async () => ({ ok: true, message: "executed" })),
    test: vi.fn(async () => ({ ok: true, message: "validated" }) satisfies ActionResult),
    commit: vi.fn(async () => ({ ok: true, message: "committed" })),
    publish: vi.fn(async () => ({ ok: true, message: "published" })),
    archive: vi.fn(async () => ({ ok: true, message: "archived" })),
    audit: vi.fn(async () => ({ ok: true, message: "audited" })),
  };
}

function fakeUi(): AidlcUi & {
  output: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  input: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  progress: AidlcUi["progress"] & Mock;
} {
  return {
    output: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    input: vi.fn(async () => undefined),
    confirm: vi.fn(async () => true),
    progress: vi.fn(async (_title: string, work: (report: (message: string) => void, signal: AbortSignal) => Promise<unknown>) => {
      const controller = new AbortController();
      return work(() => undefined, controller.signal);
    }) as unknown as AidlcUi["progress"] & Mock,
  };
}
