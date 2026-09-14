import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fail } from "./error.js";
import { type Diagnostic, ExitCode } from "./result.js";

export async function inspectPath(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    fail(
      "E_IO",
      `Cannot inspect ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { path, fix: "Check the path and its filesystem permissions, then retry." },
      ExitCode.FAILURE,
    );
  }
}

export async function requireDirectory(path: string, missing: Diagnostic["code"]): Promise<string> {
  const info = await inspectPath(path);
  if (!info) {
    fail(
      missing,
      `Required directory is missing: ${path}`,
      { path, fix: "Check the declared name and registry checkout." },
      ExitCode.REFUSED,
    );
  }
  if (!info.isDirectory()) {
    fail(
      "E_NONCANONICAL_REFERENCE",
      `Expected a real directory: ${path}`,
      { path, fix: "Run skillex migrate to restore canonical ownership before activation." },
      ExitCode.REFUSED,
    );
  }
  return realpath(path);
}

/** Inspect real composition content without following its canonical skill links. */
export async function assertReferenceOnly(root: string): Promise<void> {
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    if (!directory) break;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.name === "SKILL.md") {
        fail(
          "E_NONCANONICAL_REFERENCE",
          `Composition contains a skill definition: ${path}`,
          {
            path,
            fix: "Run skillex migrate to import embedded definitions into all-skills and replace them with references.",
          },
          ExitCode.REFUSED,
        );
      }
      if (entry.isDirectory() && entry.name !== ".git") pending.push(path);
    }
  }
}
