import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { AidlcError } from "./errors.js";
import { redact } from "./redact.js";

export interface CommandResult {
  command: string;
  args: string[];
  cwd: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  cancelled: boolean;
}

export interface ProcessRunner {
  run(
    command: string,
    args: string[],
    cwd: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<CommandResult>;
}

const MAX_OUTPUT = 2_000_000;

export function resolveExecutable(command: string): string {
  if (process.platform === "win32" && !path.extname(command) && (command === "npm" || command === "npx")) {
    return `${command}.cmd`;
  }
  return command;
}

export async function commandExists(command: string): Promise<boolean> {
  if (command.includes("/") || command.includes("\\") || command.startsWith(".")) {
    try {
      await access(command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const directories = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      try {
        await access(path.join(directory, command + extension), constants.X_OK);
        return true;
      } catch {
        // keep searching
      }
    }
  }
  return false;
}

export async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<CommandResult> {
  const started = Date.now();
  const timeoutMs = options?.timeoutMs ?? 30_000;
  if (options?.signal?.aborted) {
    throw new AidlcError("Command cancelled before it started", {
      code: "cancelled",
      recovery: "Re-run the command when you are ready.",
    });
  }
  const executable = resolveExecutable(command);
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        command,
        args,
        cwd,
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
        cancelled,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    const onAbort = () => {
      cancelled = true;
      child.kill("SIGTERM");
    };
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) {
        stdout += chunk.toString("utf8");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) {
        stderr += chunk.toString("utf8");
      }
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onAbort);
      reject(
        new AidlcError(redact(error.message), {
          code: "command-failed",
          recovery: `Check that ${command} is installed and available on PATH.`,
        }),
      );
    });
    child.on("close", (code, signal) => {
      options?.signal?.removeEventListener("abort", onAbort);
      finish(code, signal);
    });
  });
}

export const defaultRunner: ProcessRunner = {
  run: runProcess,
};

export function tail(text: string, lines: number): string {
  const parts = text.trim().split(/\r?\n/);
  return parts.slice(-lines).join("\n");
}
