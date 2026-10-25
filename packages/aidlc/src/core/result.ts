export interface CommandResult<T> {
  ok: boolean;
  exitCode: number;
  code: string;
  message: string;
  recovery?: string;
  data: T;
}

export function okResult<T>(code: string, message: string, data: T): CommandResult<T> {
  return { ok: true, exitCode: 0, code, message, data };
}

export function failResult<T>(
  exitCode: number,
  code: string,
  message: string,
  data: T,
  recovery?: string,
): CommandResult<T> {
  const result: CommandResult<T> = { ok: false, exitCode, code, message, data };
  if (recovery !== undefined) {
    result.recovery = recovery;
  }
  return result;
}
