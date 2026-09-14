import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import type { SkillMetadata } from "./catalog-types.js";
import { fail } from "./error.js";
import { inspectPath, requireDirectory } from "./filesystem.js";
import { type Diagnostic, ExitCode } from "./result.js";

function mapping(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function assertJsonValue(
  value: unknown,
  path: string,
  code: Diagnostic["code"],
  ancestors = new Set<object>(),
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || (!Array.isArray(value) && !mapping(value))) {
    fail(code, "Metadata contains a value that cannot be represented in JSON.", {
      path,
      fix: "Use strings, finite numbers, booleans, null, arrays, and string-keyed mappings.",
    });
  }
  if (ancestors.has(value)) {
    fail(code, "Metadata contains a recursive YAML alias.", {
      path,
      fix: "Replace the recursive alias with finite metadata values.",
    });
  }
  ancestors.add(value);
  for (const child of Object.values(value)) assertJsonValue(child, path, code, ancestors);
  ancestors.delete(value);
}

async function textFile(path: string, missing: Diagnostic["code"]): Promise<string> {
  const info = await inspectPath(path);
  if (!info) {
    fail(missing, "The required metadata file is missing.", {
      path,
      fix: "Restore the skill's real SKILL.md before inspecting or importing it.",
    });
  }
  if (!info.isFile()) {
    fail(
      "E_NONCANONICAL_REFERENCE",
      "Skill metadata must be stored in a real file.",
      { path, fix: "Replace the linked or non-file metadata with skill-owned content." },
      ExitCode.REFUSED,
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    fail(
      "E_IO",
      "Cannot read the skill metadata file.",
      { path, fix: "Check that the file exists and is readable, then retry." },
      ExitCode.FAILURE,
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("E_INVALID_UTF8", "Skill metadata must be valid UTF-8 text.", {
      path,
      fix: "Save this file as UTF-8 before inspecting or importing the skill.",
    });
  }
}

function yamlMapping(
  source: string,
  path: string,
  code: Diagnostic["code"],
): Record<string, unknown> {
  const document = parseDocument(source, {
    strict: true,
    uniqueKeys: true,
    stringKeys: true,
    prettyErrors: false,
    logLevel: "silent",
  });
  const problems = [...document.errors, ...document.warnings];
  if (problems.length) {
    fail(code, "Skill metadata contains invalid or unsupported YAML.", {
      path,
      detail: problems.map((problem) => `${problem.code}: ${problem.message}`),
      fix: "Correct the YAML syntax, duplicate keys, or unsupported tags in this file.",
    });
  }
  let value: unknown;
  try {
    value = document.contents === null ? {} : document.toJS({ maxAliasCount: 100 });
  } catch {
    fail(code, "Skill metadata contains an unresolved or excessive YAML alias.", {
      path,
      fix: "Replace unresolved or excessive aliases with explicit metadata values.",
    });
  }
  if (!mapping(value)) {
    fail(code, "Skill metadata must be a YAML mapping.", {
      path,
      fix: "Use named fields such as name: and description:, rather than a scalar or sequence.",
    });
  }
  assertJsonValue(value, path, code);
  return value;
}

function frontmatter(content: string, path: string): Record<string, unknown> {
  const lines = content.split(/\r?\n/);
  if (!/^---[\t ]*$/.test(lines[0] ?? "")) return {};
  const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)[\t ]*$/.test(line));
  if (end === -1) {
    fail("E_SKILL_METADATA_INVALID", "The YAML frontmatter has no closing delimiter.", {
      path,
      fix: "Close the frontmatter with a line containing --- before the Markdown body.",
    });
  }
  const metadata = yamlMapping(lines.slice(1, end).join("\n"), path, "E_SKILL_METADATA_INVALID");
  if (metadata.name !== undefined && typeof metadata.name !== "string") {
    fail("E_SKILL_METADATA_INVALID", "Frontmatter name must be a string when supplied.", {
      path,
      fix: "Use a text name or omit it. The catalog directory supplies the canonical identity.",
    });
  }
  if (
    metadata.description !== undefined &&
    metadata.description !== null &&
    typeof metadata.description !== "string"
  ) {
    fail("E_SKILL_METADATA_INVALID", "Frontmatter description must be a string or null.", {
      path,
      fix: "Use a text description, a YAML block string, or omit the field.",
    });
  }
  return metadata;
}

/** Read skill-owned metadata without changing names, provenance fields, or source bytes. */
export async function readSkillMetadata(skillPath: string): Promise<SkillMetadata> {
  const path = await requireDirectory(skillPath, "E_SKILL_MISSING");
  const skillFile = join(path, "SKILL.md");
  const metadata = frontmatter(await textFile(skillFile, "E_SKILL_MISSING"), skillFile);
  const provenancePath = join(path, ".source.yaml");
  let provenance: Record<string, unknown> | null = null;
  if (await inspectPath(provenancePath)) {
    provenance = yamlMapping(
      await textFile(provenancePath, "E_SKILL_PROVENANCE_INVALID"),
      provenancePath,
      "E_SKILL_PROVENANCE_INVALID",
    );
    if (
      (provenance.origin !== undefined && !mapping(provenance.origin)) ||
      (provenance.modified_locally !== undefined &&
        typeof provenance.modified_locally !== "boolean")
    ) {
      fail(
        "E_SKILL_PROVENANCE_INVALID",
        "Provenance origin or modified_locally has an invalid type.",
        {
          path: provenancePath,
          fix: "Use an origin mapping and a boolean modified_locally field; preserve the recorded source details.",
        },
      );
    }
  }
  return {
    description: typeof metadata.description === "string" ? metadata.description : null,
    metadata,
    provenance,
  };
}
