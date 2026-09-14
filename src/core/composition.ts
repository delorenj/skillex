import { readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { rcompare, valid } from "semver";
import { parse as parseToml } from "smol-toml";
import { fail } from "./error.js";
import { assertReferenceOnly, inspectPath, requireDirectory } from "./filesystem.js";
import { isSkillName, isVersionComponent } from "./manifest.js";
import { ExitCode } from "./result.js";
import type { PackSelection, ResolvedPack } from "./selection.js";

export async function canonicalSkill(registry: string, name: string): Promise<string> {
  if (!isSkillName(name)) {
    fail("E_SKILL_NAME", `Invalid canonical skill name: ${name}`, {
      name,
      fix: "Use a lowercase single-component name from all-skills.",
    });
  }
  await requireDirectory(join(registry, "all-skills"), "E_NO_REGISTRY");
  const path = await requireDirectory(join(registry, "all-skills", name), "E_SKILL_MISSING");
  const definition = join(path, "SKILL.md");
  const info = await inspectPath(definition);
  if (!info) {
    fail(
      "E_SKILL_MISSING",
      `Canonical skill ${name} has no SKILL.md.`,
      { path: definition, name, fix: "Create or import the canonical skill before selecting it." },
      ExitCode.REFUSED,
    );
  }
  if (!info.isFile()) {
    fail(
      "E_NONCANONICAL_REFERENCE",
      `SKILL.md must be a real file: ${definition}`,
      { path: definition, name, fix: "Run skillex migrate to restore definition ownership." },
      ExitCode.REFUSED,
    );
  }
  return path;
}

export async function setMembers(
  registry: string,
  name: string,
): Promise<{ path: string; names: string[] }> {
  await requireDirectory(join(registry, "sets"), "E_SET_MISSING");
  const path = await requireDirectory(join(registry, "sets", name), "E_SET_MISSING");
  await assertReferenceOnly(path);
  const entries = await readdir(path, { withFileTypes: true });
  const names = entries
    .filter(
      (entry) =>
        entry.isSymbolicLink() && !entry.name.startsWith(".") && !entry.name.startsWith("_"),
    )
    .map((entry) => entry.name)
    .sort();
  return { path, names };
}

export async function setMemberTarget(
  registry: string,
  setPath: string,
  name: string,
): Promise<string> {
  const expected = await canonicalSkill(registry, name);
  const path = join(setPath, name);
  const info = await inspectPath(path);
  if (!info) {
    fail(
      "E_SET_MEMBER_MISSING",
      `Set has no member named ${name}.`,
      { path, name, fix: "Correct the set include list or add its canonical reference." },
      ExitCode.REFUSED,
    );
  }
  if (!info.isSymbolicLink()) {
    fail(
      "E_NONCANONICAL_REFERENCE",
      `Set member must be a canonical directory link: ${path}`,
      { path, name, fix: "Run skillex migrate to convert the set to canonical references." },
      ExitCode.REFUSED,
    );
  }
  let target: string;
  try {
    target = await realpath(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    fail(
      code === "ENOENT" ? "E_SET_MEMBER_MISSING" : "E_NONCANONICAL_REFERENCE",
      `Cannot resolve set member ${path}.`,
      {
        path,
        name,
        fix: "Repair the link to the matching all-skills directory, or exclude it from this set.",
      },
      ExitCode.REFUSED,
    );
  }
  if (target !== expected) {
    fail(
      "E_NONCANONICAL_REFERENCE",
      `Set member ${name} points outside its canonical definition.`,
      {
        path,
        name,
        detail: [`expected ${expected}`, `actual ${target}`],
        fix: "Run skillex migrate or replace the link with the matching all-skills reference.",
      },
      ExitCode.REFUSED,
    );
  }
  return expected;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface PackInventory extends ResolvedPack {
  readonly names: readonly string[];
}

/** pack.toml owns membership; its generated skills/ links are checked by verify. */
export async function packInventory(
  registry: string,
  selection: PackSelection,
): Promise<PackInventory> {
  await requireDirectory(join(registry, "packs"), "E_PACK_MISSING");
  const family = await requireDirectory(join(registry, "packs", selection.name), "E_PACK_MISSING");
  let path = family;
  let selectedVersion = selection.version;
  if (selectedVersion !== undefined) {
    path = await requireDirectory(join(family, selectedVersion), "E_PACK_MISSING");
  } else if (!(await inspectPath(join(family, "pack.toml")))) {
    const versions: string[] = [];
    for (const entry of await readdir(family, { withFileTypes: true })) {
      if (
        !entry.name.startsWith(".") &&
        isVersionComponent(entry.name) &&
        (entry.isDirectory() || entry.isSymbolicLink()) &&
        (await inspectPath(join(family, entry.name, "pack.toml")))
      ) {
        versions.push(entry.name);
      }
    }
    if (versions.length > 1 && versions.some((version) => !valid(version))) {
      fail(
        "E_PACK_VERSION_REQUIRED",
        `Pack ${selection.name} has versions that cannot be ordered as semantic versions.`,
        {
          path: family,
          name: selection.name,
          detail: versions.sort(),
          fix: "Select an explicit pack name@version.",
        },
      );
    }
    selectedVersion = versions.length === 1 ? versions[0] : versions.sort(rcompare)[0];
    if (selectedVersion)
      path = await requireDirectory(join(family, selectedVersion), "E_PACK_MISSING");
  }

  const manifestPath = join(path, "pack.toml");
  const info = await inspectPath(manifestPath);
  if (!info) {
    fail(
      "E_PACK_MANIFEST_MISSING",
      `Pack ${selection.name} needs a pack.toml membership manifest.`,
      {
        path: manifestPath,
        fix: "Run skillex migrate to convert the legacy pack and declare its canonical members.",
      },
      ExitCode.REFUSED,
    );
  }
  if (!info.isFile()) {
    fail(
      "E_NONCANONICAL_REFERENCE",
      `Pack manifest must be a real file: ${manifestPath}`,
      { path: manifestPath, fix: "Restore the pack's own manifest before activation." },
      ExitCode.REFUSED,
    );
  }
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(await readFile(manifestPath, "utf8"));
  } catch (error) {
    fail(
      "E_PACK_MANIFEST_INVALID",
      `Cannot parse ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      { path: manifestPath, fix: "Correct the TOML membership manifest." },
    );
  }
  for (const field of ["slots", "slot", "payload", "flatten", "sealed", "policy"]) {
    if (Object.hasOwn(raw, field)) {
      fail("E_LEGACY_FIELD", `Legacy pack field ${field} is unsupported.`, {
        path: manifestPath,
        fix: "Run skillex migrate to replace payload policies and slots with canonical skill references.",
      });
    }
  }
  for (const field of Object.keys(raw)) {
    if (!["pack", "freeform", "source"].includes(field)) {
      fail("E_PACK_MANIFEST_INVALID", `Unknown pack table or field: ${field}`, {
        path: manifestPath,
        fix: "Use [pack], [freeform].skills and optional [source] provenance metadata.",
      });
    }
  }
  const header = raw.pack;
  const membership = raw.freeform;
  if (
    !record(header) ||
    header.name !== selection.name ||
    !isVersionComponent(header.version) ||
    (selectedVersion !== undefined && header.version !== selectedVersion)
  ) {
    fail(
      "E_PACK_MANIFEST_INVALID",
      "Pack name/version must match the selected composition directory.",
      {
        path: manifestPath,
        name: selection.name,
        fix: "Correct [pack].name/version or select the matching composition version.",
      },
    );
  }
  if (
    !record(membership) ||
    Object.keys(membership).some((key) => key !== "skills") ||
    !Array.isArray(membership.skills) ||
    !membership.skills.every(isSkillName)
  ) {
    fail("E_PACK_MANIFEST_INVALID", "Pack [freeform].skills must be an array of canonical names.", {
      path: manifestPath,
      fix: "Run skillex migrate to declare canonical leaf names without filters or payload fields.",
    });
  }
  for (const field of Object.keys(header)) {
    if (!["name", "version", "description"].includes(field)) {
      fail("E_PACK_MANIFEST_INVALID", `Unknown pack metadata field: ${field}`, {
        path: manifestPath,
        fix: "Use name, version and description in [pack].",
      });
    }
  }
  await assertReferenceOnly(path);
  return {
    name: selection.name,
    version: header.version,
    path,
    skillsRoot: join(path, "skills"),
    names: membership.skills,
  };
}
