import { homedir } from "node:os";
import { resolve } from "node:path";
import type { RegistryOptions, RegistrySelection } from "./selection.js";

/**
 * The machine context a registry was discovered with. Repo-owned (link) sources resolve their
 * checkouts per machine, so a lookup must use the same home, environment and working directory
 * that selected the registry. Kept beside the selection, never inside it: selections are wire
 * data, and this context is not.
 */
export interface RegistryContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly cwd: string;
  readonly checkouts?: Readonly<Record<string, string>>;
}

/** A registry identity: a discovered selection, or a bare root path from older call sites. */
export type RegistryRef = string | RegistrySelection;

const bySelection = new WeakMap<RegistrySelection, RegistryContext>();
const byRoot = new Map<string, RegistryContext>();

export function registryRoot(registry: RegistryRef): string {
  return typeof registry === "string" ? registry : registry.root;
}

export function contextFromOptions(
  options: RegistryOptions & { readonly checkouts?: Readonly<Record<string, string>> },
): RegistryContext {
  return {
    env: options.env ?? process.env,
    home: resolve(options.home ?? homedir()),
    cwd: resolve(options.cwd ?? process.cwd()),
    ...(options.checkouts === undefined ? {} : { checkouts: options.checkouts }),
  };
}

/** Called by registry discovery so later lookups through this selection share its context. */
export function bindRegistryContext(selection: RegistrySelection, context: RegistryContext): void {
  bySelection.set(selection, context);
  byRoot.set(selection.root, context);
}

/**
 * A selection's own context; a bare root falls back to the most recent discovery of that root in
 * this process, then to the process defaults.
 */
export function registryContext(registry: RegistryRef): RegistryContext {
  if (typeof registry !== "string") {
    const bound = bySelection.get(registry);
    if (bound) return bound;
  }
  return byRoot.get(registryRoot(registry)) ?? contextFromOptions({});
}
