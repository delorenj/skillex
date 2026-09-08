/** Process exits shared by the CLI and importing consumers. */
export const ExitCode = {
  SUCCESS: 0,
  FAILURE: 1,
  CONFIG: 2,
  REFUSED: 3,
  PARTIAL: 4,
  LOCK_BUSY: 5,
  DRIFT: 6,
  INTERRUPTED: 130,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export const JSON_SCHEMA_VERSION = 2 as const;

export interface Diagnostic {
  readonly code: `E_${string}` | `W_${string}` | `I_${string}`;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly path?: string;
  readonly fix?: string;
  readonly scope?: string;
  readonly name?: string;
  readonly detail?: readonly string[];
}

export interface ResultEnvelope<T> {
  readonly schema: typeof JSON_SCHEMA_VERSION;
  readonly command: string;
  readonly ok: boolean;
  readonly exit: ExitCode;
  readonly data: T;
  readonly findings: readonly Diagnostic[];
}

export interface ResultOptions {
  readonly exit?: ExitCode;
  readonly findings?: readonly Diagnostic[];
}

/** Construct the wire result without formatting output or exiting the process. */
export function makeResult<T>(
  command: string,
  data: T,
  { exit = ExitCode.SUCCESS, findings = [] }: ResultOptions = {},
): ResultEnvelope<T> {
  if (!command.trim() || !Object.values(ExitCode).includes(exit)) {
    throw new TypeError("A result requires a command and a documented exit code.");
  }
  if (exit === ExitCode.SUCCESS && findings.some((finding) => finding.severity === "error")) {
    throw new TypeError("Error findings cannot accompany a successful exit.");
  }
  return {
    schema: JSON_SCHEMA_VERSION,
    command,
    ok: exit === ExitCode.SUCCESS,
    exit,
    data,
    findings: [...findings],
  };
}
