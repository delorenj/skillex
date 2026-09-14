import { type Diagnostic, ExitCode } from "./result.js";

/** Expected configuration and invariant failures, shared by all core consumers. */
export class SkillexError extends Error {
  constructor(
    readonly exit: ExitCode,
    readonly findings: readonly Diagnostic[],
  ) {
    super(findings.map((finding) => finding.message).join("\n"));
    this.name = "SkillexError";
  }
}

export function fail(
  code: Diagnostic["code"],
  message: string,
  details: Omit<Diagnostic, "code" | "severity" | "message"> = {},
  exit: ExitCode = ExitCode.CONFIG,
): never {
  throw new SkillexError(exit, [{ code, severity: "error", message, ...details }]);
}
