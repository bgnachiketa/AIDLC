import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function fixturePath(name: string): string {
  return path.join(here, "fixtures", name);
}

export async function tempDir(): Promise<string> {
  const root = path.join(here, "..", ".tmp");
  await mkdir(root, { recursive: true });
  return mkdtemp(path.join(root, "case-"));
}

export async function copyFixture(name: string): Promise<string> {
  const destination = await tempDir();
  await cp(fixturePath(name), destination, { recursive: true });
  return destination;
}

export async function gitRepo(): Promise<string> {
  const directory = await tempDir();
  await gitAddIdentity(directory);
  await writeFile(path.join(directory, "README.md"), "# fixture\n");
  const { runProcess } = await import("../src/core/process.js");
  await runProcess("git", ["add", "--", "README.md"], directory, { timeoutMs: 20_000 });
  await runProcess("git", ["commit", "-m", "init"], directory, { timeoutMs: 20_000 });
  return directory;
}

async function gitAddIdentity(directory: string): Promise<void> {
  const { runProcess } = await import("../src/core/process.js");
  const init = await runProcess("git", ["init", "-b", "main"], directory, { timeoutMs: 20_000 });
  if (init.code !== 0) {
    throw new Error(init.stderr || "git init failed");
  }
  await runProcess("git", ["config", "user.email", "aidlc-test@example.com"], directory, { timeoutMs: 20_000 });
  await runProcess("git", ["config", "user.name", "AIDLC Test"], directory, { timeoutMs: 20_000 });
}

export async function removeTemp(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

export async function captureOutput(run: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await run();
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}