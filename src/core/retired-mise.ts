import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse, stringify } from "smol-toml";
import { fail, SkillexError } from "./error.js";
import { inspectPath } from "./filesystem.js";
import { type LockOptions, withLock } from "./lock.js";
import { ExitCode, makeResult, type ResultEnvelope } from "./result.js";

type Table = Record<string, unknown>;
const operation =
  /(?:^|[\s/'";&|(`=])(?:skillex\s+(?:sync|enable|disable|inherit|normalize|init|migrate|doctor|status|explain|topology|profile|skill|set|pack|vendor|bmad|integrations)(?:[\s)`;&|]|$)|(?:sync-skills|provision-packs|skill-ssot|hermes-skillex-resync|install-hermes-resync)(?:[.\s/'";-]|$))/;
const skillTask = /^(?:skills?(?::|-|$)|skillex(?::|-|$)|hermes:resync(?::|$))/;
const command = "integrations.retire-mise";

export interface RetireMiseOptions extends LockOptions {
  readonly project?: string;
  readonly global?: boolean;
  readonly file?: string;
  readonly cwd?: string;
  readonly apply?: boolean;
  readonly dryRun?: boolean;
}

export interface RetiredMiseChange {
  readonly path: string;
  readonly tasks: readonly string[];
  readonly references: number;
}

export interface RetiredMiseResult {
  readonly dryRun: boolean;
  readonly changes: readonly RetiredMiseChange[];
  readonly applied: readonly string[];
}

interface Snapshot {
  path: string;
  info: Stats;
  parents: Map<string, Stats>;
  before: Buffer;
  after: string;
  change: RetiredMiseChange;
}

function table(value: unknown): value is Table {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings) : [];
}

function retiredLine(line: string): boolean {
  // A prose reminder isn't an invocation. Substitutions in echo/printf still run.
  if (/^\s*(?:echo|printf)\s/.test(line) && !/[`]|\$\(/.test(line)) return false;
  return operation.test(line);
}

function retiredRun(value: unknown): boolean {
  return strings(value).some(retiredLine);
}

function invokesRetiredTask(line: string, names: Set<string>): boolean {
  const invocation = line.match(/(?:^|[;&|]\s*|\s)(?:\S*\/)?mise\s+(?:run|r)\s+([^\s;&|]+)/);
  const token = invocation?.[1]?.replace(/^['"]|['"]$/g, "");
  return matchesTask(token, names);
}

function assertPureRuns(runs: string[], names: Set<string>, path: string): void {
  if (
    runs.some(
      (run) => /[;&|\n`]|\$\(/.test(run) || (!retiredLine(run) && !invokesRetiredTask(run, names)),
    )
  ) {
    refuse(
      path,
      "A mixed task/hook invokes skill and unrelated or compound commands; separate those invocations before retirement.",
    );
  }
}

function refuse(path: string, message: string): never {
  fail(
    "E_MISE_RETIRE_UNSUPPORTED",
    message,
    {
      path,
      fix: "Preserve this config; extend the CLI's retirement handling for the reported representation, then retry. Do not execute its skill tasks.",
    },
    ExitCode.REFUSED,
  );
}

interface Section {
  text: string;
  keys: string[];
  array: boolean;
}

// Headers inside multiline TOML strings are data, not section boundaries.
function sections(text: string, path: string): Section[] {
  const result: Section[] = [{ text: "", keys: [], array: false }];
  let multiline: string | undefined;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const header = !multiline && line.match(/^\s*(\[\[?.*?\]\]?)\s*(?:#.*)?(?:\r?\n)?$/);
    if (header) {
      try {
        let node: unknown = parse(`${header[1]}\n__skillex_probe__ = true\n`);
        const keys: string[] = [];
        while (table(node) && !("__skillex_probe__" in node)) {
          const key = Object.keys(node)[0];
          if (!key) break;
          keys.push(key);
          node = node[key];
          if (Array.isArray(node)) node = node[0];
        }
        if (table(node) && "__skillex_probe__" in node) {
          result.push({ text: line, keys, array: header[1]?.startsWith("[[") ?? false });
          continue;
        }
      } catch {
        /* A bracket-shaped value is not necessarily a table header. */
      }
    }
    const current = result.at(-1);
    if (current) current.text += line;
    let quote: string | undefined;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (multiline) {
        if (multiline === '"""' && c === "\\") {
          i++;
          continue;
        }
        if (line.startsWith(multiline, i)) {
          i += 2;
          multiline = undefined;
        }
      } else if (quote) {
        if (quote === '"' && c === "\\") i++;
        else if (c === quote) quote = undefined;
      } else if (c === "#") break;
      else if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
        multiline = line.slice(i, i + 3);
        i += 2;
      } else if (c === '"' || c === "'") quote = c;
    }
  }
  if (multiline) refuse(path, "Unterminated multiline TOML value.");
  return result;
}

function get(root: unknown, keys: string[]): unknown {
  let value = root;
  for (const key of keys) {
    if (!table(value)) return undefined;
    value = value[key];
  }
  return value;
}

function matchesTask(value: unknown, names: Set<string>): boolean {
  if (typeof value !== "string") return false;
  const pattern = value.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return [...names].some((name) => new RegExp(`^${pattern}$`).test(name));
}

/** Remove only proven skill-operation tables and their call edges. Never execute mise. */
export function retireMiseText(text: string, path = "mise.toml") {
  const original = structuredClone(parse(text)) as Table;
  const desired = structuredClone(original);
  const tasks = table(desired.tasks) ? desired.tasks : {};
  const removed = new Set(
    Object.entries(tasks)
      .filter(
        ([name, value]) => skillTask.test(name) || retiredRun(table(value) ? value.run : value),
      )
      .map(([name]) => name),
  );
  const allNames = new Set<string>();
  const addNames = () => {
    for (const name of removed) {
      allNames.add(name);
      const task = tasks[name];
      if (table(task)) for (const alias of strings(task.alias)) allNames.add(alias);
    }
  };
  addNames();
  // Wrapper tasks can recreate a retired task even when their names are unrelated.
  let added = true;
  while (added) {
    added = false;
    for (const [name, value] of Object.entries(tasks)) {
      if (removed.has(name)) continue;
      const runs = strings(table(value) ? value.run : value);
      if (runs.some((run) => invokesRetiredTask(run, allNames))) {
        assertPureRuns(runs, allNames, path);
        removed.add(name);
        addNames();
        added = true;
      }
    }
  }
  for (const name of removed) {
    const value = tasks[name];
    const runs = strings(table(value) ? value.run : value);
    if (retiredRun(runs)) assertPureRuns(runs, allNames, path);
  }
  let references = 0;
  for (const name of removed) delete tasks[name];
  for (const task of Object.values(tasks)) {
    if (!table(task)) continue;
    for (const key of ["depends", "depends_post", "wait_for"]) {
      if (!Array.isArray(task[key])) continue;
      const old = task[key];
      task[key] = old.flatMap((value) => {
        const ref = typeof value === "string" ? value : table(value) ? value.task : undefined;
        if (!matchesTask(ref, allNames)) return [value];
        references++;
        if (typeof ref === "string" && ref.includes("*")) {
          refuse(
            path,
            "A wildcard dependency can include tasks from other configs; replace it with explicit task edges before retirement.",
          );
        }
        return [];
      });
    }
  }
  const retireHook = (value: unknown): boolean => {
    if (!table(value)) return false;
    if (matchesTask(value.task, allNames)) {
      if (typeof value.task === "string" && value.task.includes("*")) {
        refuse(
          path,
          "A hook/watch wildcard also invokes retained tasks; split that call edge explicitly before retirement.",
        );
      }
      return true;
    }
    const runs = [...strings(value.run), ...strings(value.script)];
    if (retiredRun(runs) || runs.some((run) => invokesRetiredTask(run, allNames))) {
      assertPureRuns(runs, allNames, path);
      return true;
    }
    return false;
  };
  if (Array.isArray(desired.watch_files)) {
    const before = desired.watch_files;
    desired.watch_files = before.filter((value) => !retireHook(value));
    references += before.length - (desired.watch_files as unknown[]).length;
    if (!(desired.watch_files as unknown[]).length) delete desired.watch_files;
  }
  if (table(desired.hooks)) {
    for (const [name, hooks] of Object.entries(desired.hooks)) {
      if (Array.isArray(hooks)) {
        desired.hooks[name] = hooks.filter((value) => !retireHook(value));
        references += hooks.length - (desired.hooks[name] as unknown[]).length;
        if (!(desired.hooks[name] as unknown[]).length) delete desired.hooks[name];
      } else if (retireHook(hooks)) {
        delete desired.hooks[name];
        references++;
      }
    }
    if (!Object.keys(desired.hooks).length) delete desired.hooks;
  }
  if (!removed.size && !references) return { text, tasks: [], references: 0 };
  if (table(desired.tasks) && !Object.keys(desired.tasks).length) delete desired.tasks;
  const blocks = sections(text, path);
  const found = new Set<string>();
  const changedTasks = new Set<string>();
  const emitted = new Set<string>();
  for (const [name, task] of Object.entries(tasks)) {
    if (!isDeepStrictEqual(task, table(original.tasks) ? original.tasks[name] : undefined))
      changedTasks.add(name);
  }
  const rendered: string[] = [];
  for (const block of blocks) {
    const [first, second] = block.keys;
    if (first === "tasks" && second && removed.has(second)) {
      found.add(second);
      // Keep trailing comments, notably the next tool's managed-block markers.
      const lines = block.text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
      const trailing: string[] = [];
      while (lines.length && /^\s*(?:#[^\r\n]*)?\s*$/.test(lines.at(-1) ?? "")) {
        const line = lines.pop();
        if (line !== undefined) trailing.unshift(line);
      }
      rendered.push(trailing.join(""));
      continue;
    }
    if (first === "tasks" && second && changedTasks.has(second)) {
      if (!emitted.has(second)) {
        rendered.push(
          `${stringify({ tasks: { [second]: tasks[second] } } as Parameters<typeof stringify>[0])}\n`,
        );
        emitted.add(second);
      }
      continue;
    }
    if (first === "watch_files" || first === "hooks") {
      const parsed = parse(block.text) as Table;
      const v = get(parsed, block.keys);
      const hook = block.array && Array.isArray(v) ? v[0] : v;
      if (retireHook(hook)) continue;
    }
    rendered.push(block.text);
  }
  const after = rendered.join("");
  if (
    [...removed].some((name) => !found.has(name)) ||
    !isDeepStrictEqual(structuredClone(parse(after)), desired)
  ) {
    refuse(
      path,
      "Skill operations use inline/nested or mixed-hook syntax that cannot yet be removed without altering unrelated configuration.",
    );
  }
  return { text: after, tasks: [...removed].sort(), references };
}

async function parents(path: string): Promise<Map<string, Stats>> {
  const result = new Map<string, Stats>();
  let current = dirname(path);
  while (true) {
    const info = await lstat(current);
    if (!info.isDirectory())
      refuse(current, "Refusing to write through a redirected config parent.");
    result.set(current, info);
    if (current === dirname(current)) return result;
    current = dirname(current);
  }
}

async function paths(options: RetireMiseOptions): Promise<string[]> {
  if (
    (options.global && options.project) ||
    (options.file && (options.global || options.project)) ||
    (options.apply && options.dryRun)
  ) {
    fail(
      "E_SCOPE",
      "Choose one of --project, --global or --file, and either --apply or --dry-run.",
      { fix: "Remove conflicting selectors." },
    );
  }
  if (options.file) return [resolve(options.cwd ?? process.cwd(), options.file)];
  const root = options.global
    ? resolve(options.home ?? homedir())
    : resolve(options.cwd ?? process.cwd(), options.project ?? ".");
  const rootInfo = await inspectPath(root);
  if (!rootInfo?.isDirectory())
    fail(
      "E_MISE_ROOT",
      "Selected config root must be an existing real directory.",
      { path: root, fix: "Correct the project/global root and retry." },
      rootInfo ? ExitCode.REFUSED : ExitCode.CONFIG,
    );
  const names = options.global
    ? [".config/mise/config.toml", ".config/mise/config.local.toml", ".mise.toml", "mise.toml"]
    : [
        "mise.toml",
        "mise.local.toml",
        ".mise.toml",
        ".mise.local.toml",
        ".mise/config.toml",
        ".mise/config.local.toml",
      ];
  return names.map((name) => join(root, name));
}

/** A first-class remediation command: read-only plan, guarded apply, then convergence check. */
export class RetireMiseSkillTasksCommand {
  constructor(readonly options: RetireMiseOptions = {}) {}

  private async snapshots(): Promise<Snapshot[]> {
    const plans: Snapshot[] = [];
    for (const path of await paths(this.options)) {
      const info = await inspectPath(path);
      if (!info) {
        if (this.options.file)
          fail("E_MISE_CONFIG_MISSING", "Explicit mise config is missing.", { path });
        continue;
      }
      if (!info.isFile())
        refuse(
          path,
          "Mise config must be a regular file; symlink-owned config requires its explicit source path.",
        );
      const identity = await parents(path);
      const before = await readFile(path);
      const transformed = retireMiseText(
        new TextDecoder("utf-8", { fatal: true }).decode(before),
        path,
      );
      if (transformed.text !== before.toString("utf8"))
        plans.push({
          path,
          info,
          parents: identity,
          before,
          after: transformed.text,
          change: { path, tasks: transformed.tasks, references: transformed.references },
        });
    }
    return plans;
  }

  async plan(): Promise<readonly RetiredMiseChange[]> {
    return (await this.snapshots()).map((entry) => entry.change);
  }

  async verify(): Promise<boolean> {
    return (await this.plan()).length === 0;
  }

  async execute(): Promise<ResultEnvelope<RetiredMiseResult | null>> {
    const applied: string[] = [];
    let changes: RetiredMiseChange[] = [];
    try {
      const plan = await this.snapshots();
      changes = plan.map((entry) => entry.change);
      if (!this.options.apply || !plan.length)
        return makeResult(
          command,
          {
            dryRun: !this.options.apply,
            changes,
            applied,
          },
          {
            findings: changes.map((entry) => ({
              code: "W_RETIRED_MISE_SKILL_TASK",
              severity: "warning",
              path: entry.path,
              message: `Retire skill mise tasks: ${entry.tasks.join(", ") || "hook/watch invocations"}.`,
              fix: `skillex integrations retire-mise --file ${JSON.stringify(entry.path)} --apply`,
              detail: [
                "Task-local pins and retired wrappers can recreate invalid skill roots. Use skillex directly.",
              ],
            })),
          },
        );
      for (const entry of plan) {
        await withLock(
          `retire-mise:${await realpath(entry.path)}`,
          async () => {
            const check = async () => {
              for (const [parent, old] of entry.parents) {
                const now = await lstat(parent);
                if (!now.isDirectory() || now.ino !== old.ino || now.dev !== old.dev)
                  refuse(parent, "Config parent changed during retirement.");
              }
              const now = await lstat(entry.path);
              if (
                !now.isFile() ||
                now.ino !== entry.info.ino ||
                now.dev !== entry.info.dev ||
                now.mode !== entry.info.mode ||
                !(await readFile(entry.path)).equals(entry.before)
              ) {
                fail(
                  "E_MISE_CONFIG_CHANGED",
                  "Mise config changed after planning.",
                  { path: entry.path, fix: "Re-preview current intent and retry." },
                  ExitCode.REFUSED,
                );
              }
            };
            await check();
            const temporary = join(dirname(entry.path), `.skillex-tmp-${randomUUID()}`);
            try {
              const file = await open(temporary, "wx", entry.info.mode & 0o777);
              try {
                await file.writeFile(entry.after);
                await file.chmod(entry.info.mode & 0o777);
                await file.sync();
              } finally {
                await file.close();
              }
              await check();
              await rename(temporary, entry.path);
              applied.push(entry.path);
            } finally {
              await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
              });
            }
          },
          this.options,
        );
      }
      if (!(await this.verify()))
        fail(
          "E_MISE_RETIRE_INCOMPLETE",
          "Skill task retirement did not converge.",
          { fix: "Inspect current config and rerun the preview." },
          ExitCode.PARTIAL,
        );
      return makeResult(command, { dryRun: false, changes, applied });
    } catch (error) {
      return makeResult(
        command,
        { dryRun: !this.options.apply, changes, applied },
        {
          exit: applied.length
            ? ExitCode.PARTIAL
            : error instanceof SkillexError
              ? error.exit
              : ExitCode.CONFIG,
          findings:
            error instanceof SkillexError
              ? error.findings
              : [
                  {
                    code: "E_MISE_CONFIG",
                    severity: "error",
                    message: error instanceof Error ? error.message : String(error),
                    fix: "Preserve the config and inspect its TOML before retrying.",
                  },
                ],
        },
      );
    }
  }
}

export async function retireMiseSkillTasks(options: RetireMiseOptions = {}) {
  return new RetireMiseSkillTasksCommand(options).execute();
}
