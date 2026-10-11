import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fail } from "./error.js";
import { inspectPath } from "./filesystem.js";
import { ExitCode } from "./result.js";
import type { ScopeName } from "./selection.js";

/** Sidecar kept inside a set directory; dot-prefixed so membership scans ignore it. */
export const SET_ORIGIN_FILE = ".skillex-set.json";

export interface DerivedSetDeclaration {
  readonly owner: { readonly scope: ScopeName; readonly root: string };
  readonly base: string | null;
  readonly packs: readonly string[];
  readonly skills: readonly string[];
  readonly removed: readonly string[];
}

export interface SetOrigin {
  readonly schema: 1;
  readonly derived?: DerivedSetDeclaration;
  readonly provenance?: Readonly<Record<string, unknown>>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, path: string, field: string): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    fail(
      "E_SET_ORIGIN_INVALID",
      `Set origin field ${field} must be an array of names.`,
      { path, fix: "Re-run the deriving skillex command to rewrite this origin metadata." },
      ExitCode.REFUSED,
    );
  }
  return value;
}

/**
 * Read derivation/provenance metadata from a set directory. Absence is normal
 * (a plain shared set); malformed metadata is a named refusal, never a guess.
 */
export async function readSetOrigin(setPath: string): Promise<SetOrigin | undefined> {
  const path = join(setPath, SET_ORIGIN_FILE);
  const info = await inspectPath(path);
  if (!info) return undefined;
  if (!info.isFile()) {
    fail(
      "E_SET_ORIGIN_INVALID",
      `Set origin metadata must be a real file: ${path}`,
      { path, fix: "Re-run the deriving skillex command to rewrite this origin metadata." },
      ExitCode.REFUSED,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail(
      "E_SET_ORIGIN_INVALID",
      `Set origin metadata is not valid JSON: ${path}`,
      { path, fix: "Re-run the deriving skillex command to rewrite this origin metadata." },
      ExitCode.REFUSED,
    );
  }
  if (!record(raw) || raw.schema !== 1) {
    fail(
      "E_SET_ORIGIN_INVALID",
      `Set origin metadata must declare schema 1: ${path}`,
      { path, fix: "Re-run the deriving skillex command to rewrite this origin metadata." },
      ExitCode.REFUSED,
    );
  }
  let derived: DerivedSetDeclaration | undefined;
  if (raw.derived !== undefined) {
    const source = raw.derived;
    if (
      !record(source) ||
      !record(source.owner) ||
      !["global", "project"].includes(String(source.owner.scope)) ||
      typeof source.owner.root !== "string" ||
      (source.base !== undefined && source.base !== null && typeof source.base !== "string")
    ) {
      fail(
        "E_SET_ORIGIN_INVALID",
        `Set derivation metadata is malformed: ${path}`,
        {
          path,
          fix: "Re-run the deriving skillex command to rewrite this origin metadata.",
        },
        ExitCode.REFUSED,
      );
    }
    derived = {
      owner: { scope: source.owner.scope as ScopeName, root: source.owner.root },
      base: source.base ?? null,
      packs: stringList(source.packs, path, "derived.packs"),
      skills: stringList(source.skills, path, "derived.skills"),
      removed: stringList(source.removed, path, "derived.removed"),
    };
  }
  let provenance: Readonly<Record<string, unknown>> | undefined;
  if (raw.provenance !== undefined) {
    if (!record(raw.provenance)) {
      fail(
        "E_SET_ORIGIN_INVALID",
        `Set provenance metadata must be an object: ${path}`,
        { path, fix: "Re-run the creating skillex command to rewrite this origin metadata." },
        ExitCode.REFUSED,
      );
    }
    provenance = raw.provenance;
  }
  return {
    schema: 1,
    ...(derived === undefined ? {} : { derived }),
    ...(provenance === undefined ? {} : { provenance }),
  };
}

export function setOriginDocument(origin: SetOrigin): string {
  const value: Record<string, unknown> = { schema: 1 };
  if (origin.derived !== undefined) value.derived = origin.derived;
  if (origin.provenance !== undefined) value.provenance = origin.provenance;
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Deterministic scope-owned name for a derived set: stable per (base, owner). */
export function derivedSetName(base: string | null, ownerRoot: string): string {
  const digest = createHash("sha256").update(ownerRoot).digest("hex").slice(0, 6);
  return `${base ?? "skills"}-${digest}`;
}

/** The suffix every derived set name for this owner root carries. */
export function derivedNameSuffix(ownerRoot: string): string {
  return `-${createHash("sha256").update(ownerRoot).digest("hex").slice(0, 6)}`;
}

/**
 * Invert a derived set name for this owner root: the base set name, or
 * undefined when the name is not shaped like this owner's derived set. The
 * bare form (`skills-<digest>`) inverts to the literal base name "skills";
 * null-base derivations are never produced by the selection commands, and an
 * existing derived set always reads its authoritative base from the sidecar.
 */
export function parseDerivedName(name: string, ownerRoot: string): string | undefined {
  const suffix = derivedNameSuffix(ownerRoot);
  if (!name.endsWith(suffix)) return undefined;
  return name.slice(0, -suffix.length);
}
