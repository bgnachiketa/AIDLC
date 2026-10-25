const HIGH_CONFIDENCE: readonly RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /ASIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /Bearer\s+[A-Za-z0-9\-._~+/]{12,}=*/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
];

const REDACTION_RULES: readonly { pattern: RegExp; replacement: string }[] = [
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: "[REDACTED]" },
  { pattern: /ASIA[0-9A-Z]{16}/g, replacement: "[REDACTED]" },
  { pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g, replacement: "[REDACTED]" },
  { pattern: /github_pat_[A-Za-z0-9_]{20,}/g, replacement: "[REDACTED]" },
  { pattern: /sk-[A-Za-z0-9]{20,}/g, replacement: "[REDACTED]" },
  { pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: "[REDACTED]" },
  {
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  { pattern: /Bearer\s+[A-Za-z0-9\-._~+/]{12,}=*/g, replacement: "Bearer [REDACTED]" },
  { pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replacement: "[REDACTED_JWT]" },
  {
    pattern: /(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['"]?[^\s'"]{6,200}/gi,
    replacement: "$1=[REDACTED]",
  },
];

const SECRET_ENV = /^(?:export\s+)?(AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|DATABASE_URL|SECRET_KEY)\s*=\s*['"]?([^\s'"]+)/gim;

const PLACEHOLDER = /(example|placeholder|changeme|your[-_]|<[^>]+>|\$\{|xxxx+|todo)/i;

export function redact(text: string): string {
  let output = text;
  for (const rule of REDACTION_RULES) {
    output = output.replace(rule.pattern, rule.replacement);
  }
  return output;
}

export function hasHighConfidenceSecret(text: string): boolean {
  for (const pattern of HIGH_CONFIDENCE) {
    if (new RegExp(pattern.source, pattern.flags).test(text)) {
      return true;
    }
  }
  const env = new RegExp(SECRET_ENV.source, SECRET_ENV.flags);
  let match = env.exec(text);
  while (match) {
    const value = match[2] ?? "";
    if (value.length >= 8 && !PLACEHOLDER.test(value) && !value.includes("localhost")) {
      return true;
    }
    match = env.exec(text);
  }
  return false;
}

export function isSensitivePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? normalized;
  if (/^id_(rsa|dsa|ed25519|ecdsa)$/i.test(base)) {
    return true;
  }
  if (/\.(pem|p12|pfx|key|keystore)$/i.test(base)) {
    return true;
  }
  if (/(^|\/)\.env$/i.test(normalized) || (/(^|\/)\.env\./i.test(normalized) && !/\.env\.(example|sample|template)$/i.test(normalized))) {
    return true;
  }
  if (/(^|\/)credentials(\.[a-z0-9]+)?$/i.test(normalized)) {
    return true;
  }
  if (/(^|\/)secrets?\.(json|ya?ml|xml|txt)$/i.test(normalized)) {
    return true;
  }
  return false;
}

export function isGeneratedArtifact(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const blocked = new Set([
    "node_modules",
    "dist",
    "coverage",
    ".next",
    "__pycache__",
    ".venv",
    "venv",
    "target",
    ".gradle",
  ]);
  if (segments.some((segment) => blocked.has(segment))) {
    return true;
  }
  return (
    normalized.endsWith(".pyc") ||
    normalized.endsWith(".log") ||
    normalized.endsWith(".tsbuildinfo") ||
    baseName(normalized) === ".DS_Store"
  );
}

function baseName(value: string): string {
  return value.split("/").pop() ?? value;
}
