import { join, resolve, sep } from "node:path";
import type { ScopeName } from "./selection.js";

/** Scope aliases shared by reconciliation and diagnostics. */
export const GLOBAL_CLI_ALIASES = Object.freeze([
  ".claude/skills",
  ".codex/skills",
  ".gemini/skills",
  ".copilot/skills",
  ".kimi-code/skills",
  ".kimi/skills",
  ".openclaw/skills",
  ".config/opencode/skills",
] as const);

export const PROJECT_CLI_ALIASES = Object.freeze([
  ".claude/skills",
  ".codex/skills",
  ".gemini/skills",
  ".copilot/skills",
  ".opencode/skills",
  ".kimi-code/skills",
] as const);

/** These integrations retain their own installer or profile lifecycle. */
export const NEVER_TOUCH = Object.freeze([".hermes", ".augment", ".cursor", ".crush"] as const);

export function aliasPaths(base: string, scope: ScopeName): readonly string[] {
  const table = scope === "global" ? GLOBAL_CLI_ALIASES : PROJECT_CLI_ALIASES;
  return table
    .map((path) => join(base, path))
    .filter(
      (path) =>
        !resolve(path)
          .split(sep)
          .some((part) => NEVER_TOUCH.some((name) => name === part)),
    );
}
