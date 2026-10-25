export class AidlcError extends Error {
  readonly code: string;
  readonly recovery: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    message: string,
    options: { code: string; recovery?: string; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "AidlcError";
    this.code = options.code;
    this.recovery = options.recovery;
    this.details = options.details;
  }
}

export function isAidlcError(error: unknown): error is AidlcError {
  return error instanceof AidlcError;
}
