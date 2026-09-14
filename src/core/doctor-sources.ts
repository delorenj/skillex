import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { canonicalSkill, packInventory, setMembers, setMemberTarget } from "./composition.js";
import { isWithin } from "./content.js";
import type { DoctorSourceInspection } from "./doctor-types.js";
import { fail, SkillexError } from "./error.js";
import { inspectPath, requireDirectory } from "./filesystem.js";
import { isSkillName, isVersionComponent } from "./manifest.js";
import { readSkillMetadata } from "./metadata.js";
import { verifyPack } from "./packs.js";
import { type Diagnostic, ExitCode } from "./result.js";
import type { RegistrySelection } from "./selection.js";
import { digestRecordedSkill } from "./vendor-provenance.js";

export interface SourceAudit {
  readonly data: DoctorSourceInspection;
  readonly findings: readonly Diagnostic[];
  readonly exits: readonly ExitCode[];
}

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A source audit accumulates independent failures instead of hiding later violations. */
export async function inspectDoctorSources(registry: RegistrySelection): Promise<SourceAudit> {
  const findings: Diagnostic[] = [];
  const exits: ExitCode[] = [];
  const data = {
    registry,
    canonicalSkills: 0,
    sets: 0,
    packs: 0,
    provenance: 0,
    digestsChecked: 0,
  };
  const report = (finding: Diagnostic, exit: ExitCode) => {
    findings.push(finding);
    exits.push(exit);
  };
  const attempt = async <T>(path: string, action: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await action();
    } catch (error) {
      if (error instanceof SkillexError) {
        findings.push(...error.findings);
        exits.push(error.exit);
      } else {
        report(
          {
            code: "E_IO",
            severity: "error",
            message: "Cannot inspect source content.",
            path,
            detail: [error instanceof Error ? error.message : String(error)],
            fix: "Check source permissions and retry after other source writers have finished.",
          },
          ExitCode.FAILURE,
        );
      }
      return undefined;
    }
  };
  const invariant = (
    path: string,
    message: string,
    code: Diagnostic["code"] = "E_NONCANONICAL_REFERENCE",
  ) =>
    report(
      {
        code,
        severity: "error",
        message,
        path,
        fix: "Run skillex migrate to restore real definitions in all-skills and reference-only compositions.",
      },
      ExitCode.REFUSED,
    );
  const catalog = join(registry.root, "all-skills");
  const sourcesPath = join(catalog, "sources.toml");
  let declarations: Map<string, string> | undefined;
  let sourcesPresent = false;
  await attempt(sourcesPath, async () => {
    const info = await inspectPath(sourcesPath);
    if (!info) return;
    sourcesPresent = true;
    if (!info.isFile()) {
      invariant(sourcesPath, "Source declarations must be a real TOML file.");
      return;
    }
    const raw = await toml(sourcesPath, "E_SOURCES_MANIFEST_INVALID");
    if (
      (raw.version !== undefined && raw.version !== 1) ||
      (raw.source !== undefined && !Array.isArray(raw.source))
    ) {
      fail("E_SOURCES_MANIFEST_INVALID", "Use sources manifest version 1 and [[source]] tables.", {
        path: sourcesPath,
        fix: "Correct all-skills/sources.toml before inspecting upstream provenance.",
      });
    }
    const parsed = new Map<string, string>();
    for (const value of (raw.source ?? []) as unknown[]) {
      if (
        !mapping(value) ||
        !isSkillName(value.name) ||
        typeof value.repo !== "string" ||
        !value.repo.trim() ||
        typeof value.version !== "string" ||
        !value.version.trim() ||
        parsed.has(value.name)
      ) {
        fail(
          "E_SOURCES_MANIFEST_INVALID",
          "Each source needs a unique name, repository, and version.",
          {
            path: sourcesPath,
            fix: "Correct the named [[source]] declaration; local checkout paths belong in sources.local.toml.",
          },
        );
      }
      for (const field of ["clone", "fetch", "auto_fetch", "url", "ref", "path"]) {
        if (Object.hasOwn(value, field))
          fail("E_LEGACY_FIELD", `Unsupported source field: ${field}`, {
            path: sourcesPath,
            fix: "Use repo/version/subdir and a logical checkout id; source inspection never clones or fetches.",
          });
      }
      parsed.set(value.name, value.repo);
    }
    declarations = parsed;
  });

  const inspectProvenance = async (path: string, provenance: Readonly<Record<string, unknown>>) => {
    data.provenance++;
    const receipt = join(path, ".source.yaml");
    const origin = mapping(provenance.origin) ? provenance.origin : {};
    for (const field of [
      "type",
      "source",
      "upstream",
      "upstream_version",
      "upstream_commit",
      "upstream_tree",
      "upstream_path",
      "extracted_at",
      "digest",
      "digest_format",
    ]) {
      if (origin[field] !== undefined && typeof origin[field] !== "string") {
        report(
          {
            code: "E_SKILL_PROVENANCE_INVALID",
            severity: "error",
            path: receipt,
            message: `Provenance origin.${field} must be text when supplied.`,
            fix: "Correct the known provenance field without replacing its recorded evidence.",
          },
          ExitCode.CONFIG,
        );
        return;
      }
    }
    const upstream =
      origin.type === "vendored" || Boolean(origin.source) || Boolean(origin.upstream);
    if (upstream) {
      if (!sourcesPresent) {
        report(
          {
            code: "E_SOURCES_MANIFEST_MISSING",
            severity: "error",
            message: "Upstream provenance requires all-skills/sources.toml.",
            path: sourcesPath,
            name: basename(path),
            detail: [receipt],
            fix: "Restore the committed source declarations; do not infer or fetch an upstream checkout.",
          },
          ExitCode.REFUSED,
        );
      } else if (
        declarations &&
        (typeof origin.source !== "string" || !declarations.has(origin.source))
      ) {
        report(
          {
            code: "E_SOURCE_DECLARATION_MISSING",
            severity: "error",
            message: "The skill's upstream source has no matching declaration.",
            path: receipt,
            name: basename(path),
            fix: "Declare origin.source in all-skills/sources.toml or correct the recorded provenance.",
          },
          ExitCode.REFUSED,
        );
      } else if (
        declarations &&
        typeof origin.source === "string" &&
        typeof origin.upstream === "string" &&
        declarations.get(origin.source) !== origin.upstream
      ) {
        invariant(
          receipt,
          "Recorded upstream identity differs from its source declaration.",
          "E_SOURCE_IDENTITY_MISMATCH",
        );
      }
    }
    if (origin.digest === undefined) return;
    if (typeof origin.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(origin.digest)) {
      report(
        {
          code: "E_SKILL_PROVENANCE_INVALID",
          severity: "error",
          path: receipt,
          message: "Recorded digest must be sha256 followed by 64 lowercase hexadecimal digits.",
          fix: "Correct the digest syntax while preserving the original provenance evidence.",
        },
        ExitCode.CONFIG,
      );
      return;
    }
    if (
      origin.digest_format !== undefined &&
      !["skillex-tree-v1", "skillex-tree-v1+symlinks"].includes(String(origin.digest_format))
    ) {
      report(
        {
          code: "W_SKILL_DIGEST_UNSUPPORTED",
          severity: "warning",
          path: receipt,
          message: "The recorded digest format cannot be verified by this CLI.",
          fix: "Inspect the provenance with its producing tool before changing the recorded digest.",
        },
        ExitCode.PARTIAL,
      );
      return;
    }
    let actual: string;
    try {
      actual = await digestRecordedSkill(path, {
        type: typeof origin.type === "string" ? origin.type : "local",
        digestFormat: typeof origin.digest_format === "string" ? origin.digest_format : null,
      });
    } catch (error) {
      if (error instanceof SkillexError && error.exit === ExitCode.REFUSED) {
        for (const finding of error.findings)
          report(
            {
              ...finding,
              code: "E_PROVENANCE_CONTENT_UNSAFE",
              message: "Cannot verify provenance for unsafe or changing skill content.",
              fix: "Restore stable regular content and supported internal links before verifying provenance.",
            },
            ExitCode.REFUSED,
          );
        return;
      }
      throw error;
    }
    data.digestsChecked++;
    if (actual !== origin.digest)
      report(
        {
          code: "W_SKILL_DIGEST_DRIFT",
          severity: "warning",
          path: receipt,
          name: basename(path),
          message: "Current skill bytes or executable modes differ from the recorded digest.",
          detail: [`recorded ${origin.digest}`, `actual ${actual}`],
          fix: "Review local edits before an explicit vendor sync or provenance update; doctor never replaces them.",
        },
        ExitCode.DRIFT,
      );
  };

  await attempt(catalog, async () => {
    await requireDirectory(catalog, "E_NO_REGISTRY");
    for (const name of (await readdir(catalog)).sort()) {
      if (name === ".git") continue;
      const path = join(catalog, name);
      await attempt(path, async () => {
        const info = await inspectPath(path);
        if (!info) return;
        if (info.isSymbolicLink()) {
          let target: string;
          try {
            target = await realpath(path);
          } catch (error) {
            if (
              !["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")
            )
              throw error;
            invariant(path, "Catalog contains a dangling or cyclic link.");
            return;
          }
          if (
            (await inspectPath(target))?.isDirectory() &&
            (await inspectPath(join(target, "SKILL.md")))
          ) {
            invariant(path, "Canonical skill definitions must be real catalog directories.");
          }
          return;
        }
        if (!info.isDirectory() || !(await inspectPath(join(path, "SKILL.md")))) return;
        data.canonicalSkills++;
        const canonical = await canonicalSkill(registry.root, name);
        const metadata = await readSkillMetadata(canonical);
        if (metadata.provenance) await inspectProvenance(canonical, metadata.provenance);
      });
    }
  });

  const packManifests: string[] = [];
  const walk = async (directory: string) => {
    const names = await attempt(directory, () => readdir(directory));
    for (const name of (names ?? []).sort()) {
      if (name === ".git") continue;
      const path = join(directory, name);
      await attempt(path, async () => {
        const info = await inspectPath(path);
        if (!info) return;
        if (name === "pack.toml") packManifests.push(path);
        if (info.isSymbolicLink()) {
          let target: string;
          try {
            target = await realpath(path);
          } catch (error) {
            if (
              !["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")
            )
              throw error;
            invariant(path, "Composition contains a dangling or cyclic reference.");
            return;
          }
          if (
            (await inspectPath(target))?.isDirectory() &&
            (await inspectPath(join(target, "SKILL.md")))
          ) {
            if (dirname(target) !== catalog)
              invariant(path, "Composition skill reference points outside the canonical catalog.");
            else await canonicalSkill(registry.root, basename(target));
          }
        } else if (name === "SKILL.md") {
          invariant(path, "Composition contains a real skill definition.");
        } else if (info.isDirectory()) await walk(path);
      });
    }
  };
  for (const kind of ["sets", "packs"] as const) {
    const root = join(registry.root, kind);
    await attempt(root, async () => {
      if (!(await inspectPath(root))) return;
      await requireDirectory(root, "E_COMPOSITION_ROOT");
      await walk(root);
      for (const name of (await readdir(root)).sort()) {
        if (!isSkillName(name)) continue;
        const path = join(root, name);
        const info = await inspectPath(path);
        if (!info?.isDirectory() && !info?.isSymbolicLink()) continue;
        if (info.isSymbolicLink()) invariant(path, "Composition roots must be real directories.");
        if (
          kind === "packs" &&
          info.isDirectory() &&
          !packManifests.some((manifest) => isWithin(path, manifest))
        ) {
          await attempt(path, () => packInventory(registry.root, { name, optional: false }));
        }
        if (kind !== "sets" || !info.isDirectory()) continue;
        data.sets++;
        const members = await attempt(path, () => setMembers(registry.root, name));
        const names =
          members?.names ??
          (await readdir(path, { withFileTypes: true }))
            .filter((item) => item.isSymbolicLink() && isSkillName(item.name))
            .map((item) => item.name);
        for (const member of names)
          await attempt(join(path, member), () => setMemberTarget(registry.root, path, member));
      }
    });
  }
  for (const path of packManifests.sort()) {
    data.packs++;
    await attempt(path, async () => {
      const info = await inspectPath(path);
      if (!info?.isFile()) {
        invariant(path, "Pack manifests must be real files.");
        return;
      }
      const parts = relative(join(registry.root, "packs"), dirname(path)).split(sep);
      const name = parts[0];
      const version = parts[1];
      if (
        !isWithin(join(registry.root, "packs"), path) ||
        !isSkillName(name) ||
        parts.length > 2 ||
        (version !== undefined && !isVersionComponent(version))
      ) {
        await toml(path, "E_PACK_MANIFEST_INVALID");
        invariant(
          path,
          "Pack manifest is outside the supported packs/name[/version] layout.",
          "E_PACK_LAYOUT",
        );
        return;
      }
      const selection = { name, optional: false, ...(version !== undefined ? { version } : {}) };
      await packInventory(registry.root, selection);
      const verified = await verifyPack(version === undefined ? name : `${name}@${version}`, {
        registryRoot: registry.root,
      });
      findings.push(...verified.findings);
      exits.push(verified.exit);
    });
  }
  return { data, findings, exits };
}

async function toml(path: string, code: Diagnostic["code"]): Promise<Record<string, unknown>> {
  const bytes = await readFile(path);
  try {
    return parseToml(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail(code, "Manifest must contain valid UTF-8 TOML.", {
      path,
      fix: "Correct the TOML source manifest and retry.",
    });
  }
}
