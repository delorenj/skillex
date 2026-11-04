import { isDeepStrictEqual } from "node:util";
import { fail, SkillexError } from "./error.js";
import { resolveSelection } from "./resolution.js";
import { ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import type { ResolvedBinding, ResolvedScope, ResolveOptions, ScopeName } from "./selection.js";

export interface EffectiveBinding extends ResolvedBinding {
  readonly registry: string;
  readonly winner: ScopeName;
}

export interface EffectiveSelection {
  readonly project: string;
  readonly scopes: readonly ResolvedScope[];
  readonly bindings: readonly EffectiveBinding[];
}

/** Scope inheritance controls materialization, never universal global availability. */
export async function resolveEffectiveSelection(
  options: Omit<ResolveOptions, "scope" | "inheritGlobal">,
): Promise<ResultEnvelope<EffectiveSelection | null>> {
  const resolved = await resolveSelection({ ...options, scope: "both" });
  if (!resolved.ok || !resolved.data) return makeResult("resolve effective", null, resolved);
  try {
    const project = resolved.data.scopes.find((scope) => scope.scope === "project");
    if (!project) fail("E_PROJECT", "Effective membership requires an explicit project manifest.");
    const bindings = new Map<string, EffectiveBinding>();
    for (const scope of resolved.data.scopes)
      for (const binding of scope.bindings) {
        const previous = bindings.get(binding.name);
        if (previous && previous.path !== binding.path)
          fail(
            "E_DIVERGENT_CANONICAL_NAME",
            `Canonical name ${binding.name} resolves to different global and project definitions.`,
            {
              name: binding.name,
              path: binding.path,
              detail: [previous.path, binding.path],
              fix: "Use one canonical definition per name; client precedence is not an ownership remedy.",
            },
            ExitCode.REFUSED,
          );
        const origins = [...(previous?.origins ?? []), ...binding.origins].filter(
          (origin, index, all) =>
            all.findIndex((other) => isDeepStrictEqual(other, origin)) === index,
        );
        bindings.set(binding.name, {
          ...binding,
          origins,
          // An inherited occurrence belongs to the original source catalog, not
          // the registry chosen for the project's own selectors. Publication
          // revalidates registry/all-skills/name, so retain that source identity.
          registry: previous?.registry ?? scope.registry.root,
          winner:
            [...origins].reverse().find((origin) => origin.kind !== "inherit")?.scope ??
            scope.scope,
        });
      }
    return makeResult(
      "resolve effective",
      {
        project: project.root,
        scopes: resolved.data.scopes,
        bindings: [...bindings.values()].sort((a, b) => a.name.localeCompare(b.name)),
      },
      resolved,
    );
  } catch (error) {
    if (!(error instanceof SkillexError)) throw error;
    return makeResult("resolve effective", null, {
      exit: error.exit,
      findings: [...resolved.findings, ...error.findings],
    });
  }
}
