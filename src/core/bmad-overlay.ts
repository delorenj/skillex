import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { captureContent, digestContent } from "./content.js";
import { fail } from "./error.js";
import { ExitCode } from "./result.js";

const git = promisify(execFile);
const sha256 = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** A local overlay is tied to an immutable freeze commit, its exact patch, and its effective tree. */
export async function verifiedBmadDigest(root: string, catalog: string): Promise<string> {
  const content = await captureContent(root);
  const actual = digestContent(content.entries);
  const receipt = parseYaml(await readFile(join(root, ".source.yaml"), "utf8"));
  const origin = receipt?.origin;
  const overlay = origin?.local_overlay;
  if (!overlay) {
    if (origin?.digest !== actual)
      refuse(root, "Frozen canonical member differs from its recorded baseline.");
    return actual;
  }
  if (
    origin?.type !== "bmad-freeze" ||
    typeof origin.digest !== "string" ||
    typeof overlay.base_commit !== "string" ||
    !/^[a-f0-9]{40}$/.test(overlay.base_commit) ||
    overlay.base_digest !== origin.digest ||
    typeof overlay.patch_digest !== "string" ||
    overlay.effective_digest !== actual ||
    receipt.modified_locally !== true
  )
    refuse(root, "BMAD local overlay provenance is invalid or its effective bytes changed.");
  try {
    const name = root.slice(catalog.length + 1);
    if (!/^all-skills\/[a-z][a-z0-9-]*$/.test(name)) throw new Error("Not a canonical member");
    const cwd = join(catalog, "all-skills");
    const skill = name.slice("all-skills/".length);
    const baseReceipt = (
      await git("git", ["show", `${overlay.base_commit}:${skill}/.source.yaml`], {
        cwd,
        encoding: "buffer",
      })
    ).stdout;
    const base = parseYaml(baseReceipt.toString("utf8"));
    if (
      base?.origin?.digest !== origin.digest ||
      base?.origin?.type !== "bmad-freeze" ||
      base?.origin?.bmad_version !== origin.bmad_version
    )
      throw new Error("Original freeze identity does not match");
    const patch = (
      await git(
        "git",
        [
          "diff",
          "--binary",
          overlay.base_commit,
          "HEAD",
          "--",
          skill,
          `:(exclude)${skill}/.source.yaml`,
        ],
        { cwd, encoding: "buffer" },
      )
    ).stdout;
    const status = (await git("git", ["status", "--porcelain", "--", skill], { cwd })).stdout;
    if (status.trim() || overlay.patch_digest !== sha256(patch))
      throw new Error("Patch changed or uncommitted content exists");
    return actual;
  } catch {
    refuse(root, "BMAD overlay patch or original freeze identity cannot be verified.");
  }
}

function refuse(path: string, message: string): never {
  fail(
    "E_BMAD_SPEC_RUNTIME_REFUSE",
    message,
    {
      path,
      fix: "Commit an intentional overlay with its original freeze and patch provenance; restore unexplained mutations.",
    },
    ExitCode.REFUSED,
  );
}
