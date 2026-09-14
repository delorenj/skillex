import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Ajv, type ErrorObject, type SchemaObject } from "ajv";
import { fail, SkillexError } from "./error.js";
import { type Diagnostic, ExitCode } from "./result.js";
import type { SkillsManifest } from "./selection.js";

interface ManifestInput {
  readonly scope?: "global" | "project";
  readonly inherit_global?: boolean;
  readonly registry?: string;
  readonly skills?: readonly (string | { readonly name: string })[];
  readonly sets?: readonly (
    | string
    | {
        readonly name: string;
        readonly include?: readonly string[];
        readonly exclude?: readonly string[];
        readonly optional?: boolean;
      }
  )[];
  readonly packs?: readonly (
    | string
    | { readonly name: string; readonly version?: string; readonly optional?: boolean }
  )[];
  readonly exclude?: readonly string[];
}

// Package self-resolution works both from src/ and bundled dist/ entrypoints.
// The editor-facing schema is the runtime authority; no network schema is loaded.
const schema = JSON.parse(
  readFileSync(
    new URL(import.meta.resolve("@delorenj/skillex/schemas/skills.schema.json")),
    "utf8",
  ),
) as SchemaObject & {
  definitions: Record<"skillName" | "versionComponent", { pattern: string }>;
};
const validateManifest = new Ajv({
  allErrors: true,
  strict: true,
  ownProperties: true,
}).compile<ManifestInput>(schema);
const skillPattern = new RegExp(schema.definitions.skillName.pattern);
const versionPattern = new RegExp(schema.definitions.versionComponent.pattern);

export function isSkillName(value: unknown): value is string {
  return typeof value === "string" && skillPattern.test(value);
}

export function isVersionComponent(value: unknown): value is string {
  return typeof value === "string" && versionPattern.test(value);
}

const retiredFields = new Set([
  "source",
  "registry_path",
  "flatten",
  "sealed",
  "slot",
  "slots",
  "payload",
  "policy",
  "activators",
  "adapters",
  "cli_adapters",
]);

function fieldPointer(error: ErrorObject): string {
  const field =
    error.keyword === "additionalProperties"
      ? String(error.params.additionalProperty)
      : error.keyword === "required"
        ? String(error.params.missingProperty)
        : undefined;
  return field === undefined
    ? error.instancePath || "/"
    : `${error.instancePath}/${field.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function manifestFinding(error: ErrorObject, path: string): Diagnostic {
  const pointer = fieldPointer(error);
  if (error.keyword === "additionalProperties") {
    const field = String(error.params.additionalProperty);
    const packFilter =
      (field === "include" || field === "exclude") && /^\/packs\//.test(error.instancePath);
    const legacy =
      retiredFields.has(field) ||
      packFilter ||
      (field === "registry" && /^\/(skills|sets|packs)\//.test(error.instancePath)) ||
      (field === "version" && /^\/(skills|sets)\//.test(error.instancePath));
    return {
      code: legacy ? "E_LEGACY_FIELD" : "E_MANIFEST_INVALID",
      severity: "error",
      message: packFilter
        ? `Pack filter ${pointer} is unsupported: a pack is an exclusive complete loadout.`
        : legacy
          ? `Legacy field ${pointer} is unsupported by canonical manifest resolution.`
          : `Unknown manifest field ${pointer}.`,
      path,
      fix: packFilter
        ? "Remove the pack filter. Use a set for filtered composition, or disable the pack to resume ordinary selections."
        : legacy
          ? "Run skillex migrate to convert this manifest to canonical all-skills/ names and reference-only sets or packs, then remove the legacy field."
          : "Remove or correct the field using skills.schema.json. For legacy configuration, run skillex migrate first.",
    };
  }
  if (error.keyword === "maxItems" && error.instancePath === "/packs") {
    return {
      code: "E_MANIFEST_INVALID",
      severity: "error",
      message: "The /packs selection permits at most one exclusive pack.",
      path,
      fix: "Keep one pack, or use sets to compose multiple selections.",
    };
  }
  return {
    code: "E_MANIFEST_INVALID",
    severity: "error",
    message: `Invalid manifest field ${pointer}: ${error.message ?? error.keyword}.`,
    path,
    fix: "Correct this field using skills.schema.json. Skill names must be canonical lowercase names; set, pack, and version names must be safe single path components.",
  };
}

/** Validate without coercion, input mutation, or discarding dormant selections. */
export function parseManifest(raw: unknown, path: string): SkillsManifest {
  if (!validateManifest(raw)) {
    const errors = validateManifest.errors ?? [];
    // Alternative string/object branches can repeat type errors. Report concrete
    // unsupported fields first so migration instructions do not get buried.
    const unsupported = errors.filter((error) => error.keyword === "additionalProperties");
    const relevant = unsupported.length
      ? unsupported
      : errors.filter((error) => error.keyword !== "anyOf");
    const findings = relevant.map((error) => manifestFinding(error, path));
    throw new SkillexError(
      ExitCode.CONFIG,
      findings.filter(
        (finding, index) =>
          findings.findIndex((other) => other.message === finding.message) === index,
      ),
    );
  }

  return {
    path,
    ...(raw.scope === undefined ? {} : { scope: raw.scope }),
    inheritGlobal: raw.inherit_global ?? true,
    ...(raw.registry === undefined ? {} : { registry: raw.registry }),
    skills: (raw.skills ?? []).map((entry) => ({
      name: typeof entry === "string" ? entry : entry.name,
    })),
    sets: (raw.sets ?? []).map((entry) =>
      typeof entry === "string"
        ? { name: entry, exclude: [], optional: false }
        : {
            name: entry.name,
            ...(entry.include === undefined ? {} : { include: [...entry.include] }),
            exclude: [...(entry.exclude ?? [])],
            optional: entry.optional ?? false,
          },
    ),
    packs: (raw.packs ?? []).map((entry) => {
      if (typeof entry !== "string") {
        return {
          name: entry.name,
          ...(entry.version === undefined ? {} : { version: entry.version }),
          optional: entry.optional ?? false,
        };
      }
      const separator = entry.indexOf("@");
      return {
        name: separator === -1 ? entry : entry.slice(0, separator),
        ...(separator === -1 ? {} : { version: entry.slice(separator + 1) }),
        optional: false,
      };
    }),
    exclude: [...(raw.exclude ?? [])],
  };
}

/** Read one required declaration. Callers must explicitly handle optional scope absence. */
export async function readManifest(path: string): Promise<SkillsManifest> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    fail(
      missing ? "E_MANIFEST_MISSING" : "E_MANIFEST_INVALID",
      missing ? "The required skills manifest is missing." : "The skills manifest cannot be read.",
      {
        path,
        fix: missing
          ? "Run skillex init for this scope, or select a project with an existing .agents/skills.json."
          : "Ensure this path is a readable skills.json file.",
      },
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    fail("E_MANIFEST_PARSE", "The skills manifest is not valid JSON.", {
      path,
      fix: "Correct the JSON syntax in this file; comments and trailing commas are not supported.",
    });
  }
  return parseManifest(raw, path);
}
