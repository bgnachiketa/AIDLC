import { stringify } from "yaml";
import { AidlcError } from "./errors.js";
import { assertInside, readText, writeAtomic } from "./fsutil.js";
import { AIDLC_PATHS } from "./paths.js";
import { defaultPolicy } from "./policy.js";
import {
  ConfigSchema,
  SCHEMA_VERSION,
  emptyCommands,
  formatZodError,
  type AidlcConfig,
  type ProjectCommands,
} from "./schema.js";
import { parse } from "yaml";

export function createDefaultConfig(input: {
  repositoryId: string;
  repositoryPathId: string;
  technologies: AidlcConfig["technologies"];
  directories: string[];
  commands: Record<string, ProjectCommands>;
}): AidlcConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
    repositoryId: input.repositoryId,
    repositoryPathId: input.repositoryPathId,
    technologies: input.technologies,
    directories: input.directories,
    commands: Object.keys(input.commands).length > 0 ? input.commands : { ".": emptyCommands() },
    conventions: {
      baseBranch: "main",
      branchPattern: "{type}/{planId}-{slug}",
      commitStyle: "conventional",
    },
    qualityGates: {
      required: ["test"],
      optional: ["lint", "typecheck", "build"],
    },
    integrations: {
      claude: true,
      codex: true,
      cursor: true,
      vscode: true,
      gitHost: "github",
    },
    plans: {
      directory: AIDLC_PATHS.plansDir,
      activePointer: AIDLC_PATHS.activePlan,
    },
    policy: defaultPolicy(),
    ignore: [],
  };
}

export function renderConfig(config: AidlcConfig): string {
  const body = stringify(config, { lineWidth: 100 });
  return [
    "# AIDLC repository configuration.",
    "# Edit values in place. Re-running init preserves existing keys.",
    "# schemaVersion 1",
    body.endsWith("\n") ? body : `${body}\n`,
  ].join("\n");
}

const REQUIRED_KEYS = [
  "schemaVersion",
  "repositoryId",
  "repositoryPathId",
  "technologies",
  "directories",
  "commands",
  "conventions",
  "qualityGates",
  "integrations",
  "plans",
  "policy",
  "ignore",
] as const;

export async function loadConfig(root: string): Promise<AidlcConfig | null> {
  const absolute = assertInside(root, AIDLC_PATHS.config);
  const text = await readText(absolute);
  if (text === null) {
    return null;
  }
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    throw new AidlcError(`Could not parse ${AIDLC_PATHS.config}`, {
      code: "corrupt-state",
      recovery: "Fix the YAML or move the file aside. Init will not overwrite it.",
      details: { cause: error instanceof Error ? error.message : "unknown" },
    });
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AidlcError(`Invalid AIDLC config: ${formatZodError(parsed.error)}`, {
      code: "corrupt-state",
      recovery: "Fix .aidlc/config.yaml. AIDLC will not replace user-authored configuration.",
    });
  }
  return parsed.data;
}

export async function writeNewConfig(root: string, config: AidlcConfig): Promise<void> {
  await writeAtomic(assertInside(root, AIDLC_PATHS.config), renderConfig(config));
}

export async function appendMissingConfigKeys(root: string, defaults: AidlcConfig): Promise<string[]> {
  const absolute = assertInside(root, AIDLC_PATHS.config);
  const text = await readText(absolute);
  if (text === null) {
    await writeNewConfig(root, defaults);
    return ["created"];
  }
  const raw = parse(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AidlcError("AIDLC config must be a YAML mapping", {
      code: "corrupt-state",
      recovery: "Replace the file with a mapping or move it aside before re-running init.",
    });
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== undefined && record.schemaVersion !== SCHEMA_VERSION) {
    throw new AidlcError(`Unsupported config schemaVersion ${String(record.schemaVersion)}`, {
      code: "unsupported-schema",
      recovery: "This AIDLC build reads schemaVersion 1 and will not rewrite an unsupported config.",
    });
  }
  const missing = REQUIRED_KEYS.filter((key) => !(key in record));
  if (missing.length === 0) {
    ConfigSchema.parse(raw);
    return [];
  }
  const addition: Record<string, unknown> = {};
  for (const key of missing) {
    addition[key] = defaults[key];
  }
  const snippet = stringify(addition, { lineWidth: 100 });
  const prefix = text.endsWith("\n") ? text : `${text}\n`;
  await writeAtomic(absolute, `${prefix}# Keys added by init-aidlc. Existing values were preserved.\n${snippet}`);
  const reread = parse(await readText(absolute).then((value) => value ?? ""));
  const checked = ConfigSchema.safeParse(reread);
  if (!checked.success) {
    throw new AidlcError(`Config is still invalid after adding keys: ${formatZodError(checked.error)}`, {
      code: "corrupt-state",
      recovery: "Review .aidlc/config.yaml. The original keys were retained and missing defaults were appended.",
    });
  }
  return missing;
}
