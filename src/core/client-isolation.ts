import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type ReceiptBinding,
  type ReceiptOptions,
  type ReceiptSnapshot,
  readBoundReceipt,
  writeBoundReceipt,
} from "./activation-state.js";
import { fail, SkillexError } from "./error.js";
import { inspectPath } from "./filesystem.js";
import { withLock } from "./lock.js";
import { resolveSelection } from "./resolution.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import type { ResolvedScope, ResolveOptions } from "./selection.js";

export interface ClientIsolationOptions extends Omit<ResolveOptions, "scope" | "inheritGlobal"> {
  readonly client?: string;
  readonly apply?: boolean;
  readonly dryRun?: boolean;
  /** Explicitly permit the project block to override shared user permissions, never agent rules. */
  readonly overridePermissions?: boolean;
  readonly stateHome?: string;
  readonly timeoutMs?: number;
}

export interface ClientVerifyOptions extends Omit<ClientIsolationOptions, "apply" | "dryRun"> {
  /** A caller-owned, existing probe session. Verification never creates sessions. */
  readonly session?: string;
  readonly agent?: string;
}

interface Rule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

export interface ClientIsolationPlan {
  readonly client: "opencode";
  readonly project: string;
  readonly set: string | null;
  readonly members: readonly string[];
  readonly config: string;
  readonly receipt: string;
  readonly changes: readonly { path: string; action: "create" | "update" | "remove" }[];
  readonly recovery: boolean;
  readonly overrides: readonly { path: string; rule: number }[];
}

export interface ClientIsolationResult extends ClientIsolationPlan {
  readonly dryRun: boolean;
  readonly applied: boolean;
  readonly runtimeVerified: false;
}

export interface ClientVerification {
  readonly client: "opencode";
  readonly project: string;
  readonly set: string;
  readonly session: string;
  readonly agent: string;
  readonly evidence: "opencode-v2-permission-evaluator";
  readonly registryCount: number;
  readonly checked: readonly {
    id: string;
    expected: Rule["effect"];
    effect: Rule["effect"];
    request: string;
  }[];
  readonly advertised: readonly string[];
}

/** Native V2 API envelope; a transport seam for fixtures, not an alternate evaluator. */
export type OpenCodeRequest = (
  method: "get" | "post",
  path: string,
  body?: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

type ObjectValue = Record<string, unknown>;
interface Property {
  key: Token;
  value: Node;
  comma?: Token;
}
interface Node {
  start: number;
  end: number;
  value: unknown;
  properties?: Map<string, Property>;
  items?: Node[];
  commas?: Token[];
}
interface Token {
  start: number;
  end: number;
  text: string;
}
interface Document {
  path: string;
  text: string;
  node: Node;
  info?: Stats;
}
interface Managed {
  set: string;
  rules: Rule[];
  permissionsAdded: boolean;
  /** Only generated-file bytes are hashed; user config is never copied into state. */
  createdHash: string | null;
}
interface State {
  schema: 1;
  client: "opencode";
  config: string;
  active: Managed | null;
  pending?: { before: string | null; after: string | null; active: Managed | null };
}
interface Prepared {
  plan: ClientIsolationPlan;
  document: Document;
  after: string | null;
  state: State;
  currentActive: Managed | null;
  snapshot: ReceiptSnapshot<State>;
  stateOptions: ReceiptOptions;
  parents: Map<string, Stats>;
  inputs: Document[];
  scope?: ResolvedScope;
}

// V2 contracts: https://opencode.ai/v2/docs/config and /v2/docs/permissions.
// The published /config.json schema may still describe V1; do not derive rules from it.
const configNames = [
  "opencode.json",
  "opencode.jsonc",
  ".opencode/opencode.json",
  ".opencode/opencode.jsonc",
];
// A distinct fixed binding reuses hardened state IO without claiming an activation receipt.
const binding: ReceiptBinding = {
  namespace: "migrations",
  targetParts: [".opencode", "skillex-client-isolation"],
};
async function apiDocument(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<unknown> {
  // OpenCode 2.0.26 can exit before flushing a large JSON response to a pipe.
  // A regular stdout file preserves the complete registry response without shell interpolation.
  const dir = await mkdtemp(join(tmpdir(), "skillex-client-probe-"));
  const path = join(dir, "response.json");
  try {
    const output = await open(path, "wx", 0o600);
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("opencode", args, {
          cwd,
          env,
          stdio: ["ignore", output.fd, "pipe"],
          timeout: 15000,
        });
        let error = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          if (error.length < 8192) error += chunk.toString();
        });
        const deadline = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("OpenCode API exceeded its 17-second deadline."));
        }, 17000);
        child.on("error", (cause) => {
          clearTimeout(deadline);
          reject(cause);
        });
        child.on("close", (code, signal) => {
          clearTimeout(deadline);
          if (code === 0) resolve();
          else reject(new Error(`OpenCode API failed (${code ?? signal}): ${error}`));
        });
      });
    } finally {
      await output.close();
    }
    if ((await stat(path)).size > 16 * 1024 * 1024)
      throw new Error("OpenCode API response exceeds the bounded 16 MiB limit.");
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function refuse(code: Diagnostic["code"], message: string, path?: string): never {
  fail(
    code,
    message,
    {
      ...(path === undefined ? {} : { path }),
      fix: "Preserve the reported config/receipt, resolve the conflict explicitly, then rerun skillex clients isolate --dry-run. No global configuration is changed.",
    },
    ExitCode.REFUSED,
  );
}

function hash(text: string | null): string | null {
  return text === null ? null : createHash("sha256").update(text).digest("hex");
}

/** A span parser lets us change rules without reserializing sibling JSONC or its comments. */
function parseDocument(text: string, path: string): Node {
  const tokens: Token[] = [];
  const re =
    /\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|[{}[\],:]|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/gy;
  const invalid = (): never => refuse("E_CLIENT_CONFIG", "Malformed JSON value.", path);
  const decode = (token: string): unknown => {
    try {
      return JSON.parse(token) as unknown;
    } catch {
      return invalid();
    }
  };
  let offset = 0;
  while (offset < text.length) {
    re.lastIndex = offset;
    const match = re.exec(text);
    if (!match) refuse("E_CLIENT_CONFIG", `Invalid JSON/JSONC at offset ${offset}.`, path);
    const word = match[0];
    if (!/^\s|^\/[/*]/.test(word)) tokens.push({ start: offset, end: re.lastIndex, text: word });
    offset = re.lastIndex;
  }
  let index = 0;
  const take = (expected?: string): Token => {
    const token = tokens[index++];
    if (!token || (expected !== undefined && token.text !== expected))
      refuse("E_CLIENT_CONFIG", `Expected ${expected ?? "JSON value"}.`, path);
    return token;
  };
  const value = (): Node => {
    const first = take();
    if (first.text === "{" || first.text === "[") {
      const isObject = first.text === "{";
      const end = isObject ? "}" : "]";
      const properties = new Map<string, Property>();
      const items: Node[] = [];
      const commas: Token[] = [];
      const result: ObjectValue = Object.create(null);
      while (tokens[index]?.text !== end) {
        let key: Token | undefined;
        let name: string | undefined;
        if (isObject) {
          key = take();
          if (!key.text.startsWith('"'))
            refuse("E_CLIENT_CONFIG", "Object keys must be strings.", path);
          name = decode(key.text) as string;
          if (properties.has(name))
            refuse("E_CLIENT_CONFIG", `Duplicate config key: ${name}.`, path);
          take(":");
        }
        const child = value();
        items.push(child);
        let comma: Token | undefined;
        if (tokens[index]?.text === ",") {
          comma = take(",");
          commas.push(comma);
        } else if (tokens[index]?.text !== end) {
          refuse("E_CLIENT_CONFIG", "Expected a comma or closing delimiter.", path);
        }
        if (key && name !== undefined) {
          properties.set(name, { key, value: child, ...(comma ? { comma } : {}) });
          result[name] = child.value;
        }
      }
      const last = take(end);
      return {
        start: first.start,
        end: last.end,
        value: isObject ? result : items.map((item) => item.value),
        ...(isObject ? { properties } : { items, commas }),
      };
    }
    return { start: first.start, end: first.end, value: decode(first.text) };
  };
  const root = value();
  if (index !== tokens.length || !object(root.value))
    refuse("E_CLIENT_CONFIG", "OpenCode config must contain exactly one JSON object.", path);
  return root;
}

async function readDocument(path: string): Promise<Document> {
  const info = await inspectPath(path);
  if (!info) return { path, text: "", node: parseDocument("{}", path) };
  if (!info.isFile())
    refuse(
      "E_CLIENT_CONFIG_PATH",
      "Config must be a regular file, not a symlink or directory.",
      path,
    );
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const current = await inspectPath(path);
    if (
      !before.isFile() ||
      before.ino !== info.ino ||
      before.dev !== info.dev ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      !current?.isFile() ||
      current.ino !== after.ino ||
      current.dev !== after.dev ||
      current.mtimeMs !== after.mtimeMs ||
      current.ctimeMs !== after.ctimeMs
    )
      refuse("E_CLIENT_CONFIG_CHANGED", "Config changed while being read.", path);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { path, text, node: parseDocument(text, path), info: after };
  } finally {
    await handle.close();
  }
}

function rules(node: Node, path: string): Rule[] {
  if (!Array.isArray(node.value))
    refuse("E_CLIENT_CONFIG", "V2 permissions must be an array.", path);
  for (const rule of node.value) {
    if (
      !object(rule) ||
      Object.keys(rule).sort().join(",") !== "action,effect,resource" ||
      typeof rule.action !== "string" ||
      typeof rule.resource !== "string" ||
      !["allow", "deny", "ask"].includes(String(rule.effect))
    )
      refuse(
        "E_CLIENT_CONFIG",
        "Expected native V2 {action, resource, effect} permission rules.",
        path,
      );
  }
  return node.value as Rule[];
}

function permissionNode(document: Document): Node | undefined {
  return document.node.properties?.get("permissions")?.value;
}

function ownRange(document: Document, active: Managed): { start: number; count: number } {
  const node = permissionNode(document);
  const current = node ? rules(node, document.path) : [];
  const matches: number[] = [];
  for (let i = 0; i <= current.length - active.rules.length; i++) {
    if (
      isDeepStrictEqual(
        current.slice(i, i + active.rules.length).map((r) => ({ ...r })),
        active.rules,
      )
    )
      matches.push(i);
  }
  if (matches.length !== 1)
    refuse(
      "E_CLIENT_OWNERSHIP_CHANGED",
      "The receipt-owned permission block is missing, edited, or ambiguous; no foreign rule was removed.",
      document.path,
    );
  return { start: matches[0] as number, count: active.rules.length };
}

function splice(text: string, edits: { start: number; end: number; text: string }[]): string {
  for (const edit of [...edits].reverse().sort((a, b) => b.start - a.start))
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}

function removeOwned(document: Document, active: Managed): string {
  const { start, count } = ownRange(document, active);
  const node = permissionNode(document) as Node;
  const items = node.items as Node[];
  const trivia = document.text.slice(node.start, node.end).replace(/"(?:\\[\s\S]|[^"\\])*"/g, "");
  if (items.length === count && active.permissionsAdded && !/\/[/*]/.test(trivia)) {
    const property = document.node.properties?.get("permissions") as Property;
    const properties = [...(document.node.properties?.values() ?? [])];
    const previous = properties[properties.indexOf(property) - 1];
    const edits = [{ start: property.key.start, end: property.value.end, text: "" }];
    const comma = property.comma ?? previous?.comma;
    if (comma) edits.push({ start: comma.start, end: comma.end, text: "" });
    return splice(document.text, edits);
  }
  const edits = items
    .slice(start, start + count)
    .map((item) => ({ start: item.start, end: item.end, text: "" }));
  // Remove one separator per removed item, except when removing an entire array.
  const commas = node.commas ?? [];
  const chosen =
    start + count < items.length
      ? commas.slice(start, start + count)
      : commas.slice(Math.max(0, start - 1));
  for (const comma of chosen) edits.push({ start: comma.start, end: comma.end, text: "" });
  return splice(document.text, edits);
}

function appendRules(document: Document, added: Rule[]): string {
  const node = permissionNode(document);
  const newline = document.text.includes("\r\n") ? "\r\n" : "\n";
  const rendered = added.map((rule) => `    ${JSON.stringify(rule)}`).join(`,${newline}`);
  if (node) {
    rules(node, document.path);
    const items = node.items ?? [];
    const last = items.at(-1);
    const trailing = last && (node.commas?.at(-1)?.start ?? -1) >= last.end;
    return splice(document.text, [
      ...(last && !trailing ? [{ start: last.end, end: last.end, text: "," }] : []),
      { start: node.end - 1, end: node.end - 1, text: `${newline}${rendered}${newline}  ` },
    ]);
  }
  const properties = [...(document.node.properties?.values() ?? [])];
  const last = properties.at(-1);
  return splice(document.text, [
    ...(last && !last.comma ? [{ start: last.value.end, end: last.value.end, text: "," }] : []),
    {
      start: document.node.end - 1,
      end: document.node.end - 1,
      text: `${newline}  "permissions": [${newline}${rendered}${newline}  ]${newline}`,
    },
  ]);
}

function matches(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  return new RegExp(`^${escaped}$`, "s").test(value);
}

function validateRules(
  document: Document,
  members: string[],
  override: boolean,
  overrides: { path: string; rule: number }[],
): void {
  const root = document.node.value as ObjectValue;
  if ("permission" in root || "agent" in root)
    refuse(
      "E_CLIENT_CONFIG_UNSUPPORTED",
      "Legacy permission/agent configuration needs explicit V2 migration before isolation.",
      document.path,
    );
  const top = permissionNode(document);
  if (top) {
    for (const [index, rule] of rules(top, document.path).entries()) {
      if (!matches(rule.action, "skill")) continue;
      const restrictsSelected =
        rule.effect !== "allow" && members.some((member) => matches(rule.resource, member));
      const exposesUnselected =
        rule.effect !== "deny" && (/[?*]/.test(rule.resource) || !members.includes(rule.resource));
      if (!restrictsSelected && !exposesUnselected) continue;
      if (!override)
        fail(
          "E_CLIENT_PERMISSION_CONFLICT",
          restrictsSelected
            ? "An existing deny/ask rule restricts a selected skill. Isolation will not append an allow over user intent."
            : "An existing permission allows or asks for unselected skills and would be overridden by isolation.",
          {
            path: document.path,
            detail: [`permissions[${index}]: ${JSON.stringify(rule)}`],
            fix: "Resolve that user-owned rule explicitly, or preview --override-permissions to authorize a project-local override. The original rules are retained for unisolate.",
          },
          ExitCode.REFUSED,
        );
      overrides.push({ path: document.path, rule: index });
    }
  }
  if ("agents" in root) {
    if (!object(root.agents))
      refuse("E_CLIENT_CONFIG", "V2 agents must be an object.", document.path);
    for (const [id, agent] of Object.entries(root.agents)) {
      if (!object(agent)) refuse("E_CLIENT_CONFIG", `Invalid agent ${id}.`, document.path);
      if ("permission" in agent)
        refuse(
          "E_CLIENT_CONFIG_UNSUPPORTED",
          `Agent ${id} uses legacy permission syntax.`,
          document.path,
        );
      if (!("permissions" in agent)) continue;
      for (const rule of rules({ start: 0, end: 0, value: agent.permissions }, document.path)) {
        if (!matches(rule.action, "skill")) continue;
        if (
          (rule.effect !== "allow" && members.some((member) => matches(rule.resource, member))) ||
          (rule.effect !== "deny" &&
            (/[?*]/.test(rule.resource) || !members.includes(rule.resource)))
        )
          refuse(
            "E_CLIENT_AGENT_OVERRIDE",
            `Agent ${id} has a skill permission that overrides isolation. Its rules were preserved.`,
            document.path,
          );
      }
    }
  }
}

async function projectRoot(options: ClientIsolationOptions): Promise<string> {
  if ((options.client ?? "opencode") !== "opencode")
    refuse(
      "E_CLIENT_UNSUPPORTED",
      "Only the OpenCode V2 permission adapter has evidence; other clients are not supported.",
    );
  if (options.apply && options.dryRun)
    fail("E_CLIENT_OPTIONS", "Choose --apply or --dry-run, not both.", {
      fix: "Preview without --apply, then apply separately.",
    });
  if (!options.project?.trim())
    fail("E_CLIENT_PROJECT", "Client isolation requires an explicit --project PATH.", {
      fix: "Select the project whose manifest selects a set.",
    });
  const requested = resolve(options.cwd ?? process.cwd(), options.project);
  if (!(await inspectPath(requested)))
    fail("E_CLIENT_PROJECT", "The selected project does not exist.", {
      path: requested,
      fix: "Choose an existing project directory.",
    });
  const project = await realpath(requested);
  const home = await realpath(options.home ?? homedir());
  if (project === home || project === dirname(project))
    refuse("E_CLIENT_PROJECT", "Global/home isolation is not a project operation.", project);
  if (!(await lstat(project)).isDirectory())
    refuse("E_CLIENT_PROJECT", "Project must be a directory.", project);
  return project;
}

async function selection(options: ClientIsolationOptions, project: string): Promise<ResolvedScope> {
  const result = await resolveSelection({ ...options, project, scope: "project" });
  if (!result.ok || !result.data) throw new SkillexError(result.exit, result.findings);
  const scope = result.data.scopes.find((entry) => entry.scope === "project");
  if (!scope?.set || scope.mode !== "set")
    refuse(
      "E_CLIENT_SET_REQUIRED",
      "Select a resolved project set before isolating client visibility.",
      project,
    );
  return scope;
}

async function parents(path: string): Promise<Map<string, Stats>> {
  const result = new Map<string, Stats>();
  for (let current = dirname(path); ; current = dirname(current)) {
    const info = await lstat(current);
    if (!info.isDirectory())
      refuse("E_CLIENT_CONFIG_PATH", "Refusing a redirected config parent.", current);
    result.set(current, info);
    if (current === dirname(current)) return result;
  }
}

async function configInputs(project: string, options: ClientIsolationOptions): Promise<Document[]> {
  const env = options.env ?? process.env;
  for (const key of [
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_DISABLE_PROJECT_CONFIG",
  ])
    if (env[key])
      refuse(
        "E_CLIENT_CONFIG_UNSUPPORTED",
        `${key} changes ordinary OpenCode discovery; this adapter cannot certify that precedence.`,
      );
  const directories: string[] = [];
  for (let path = project; ; path = dirname(path)) {
    directories.unshift(path);
    if (path === dirname(path)) break;
  }
  const global = resolve(
    env.XDG_CONFIG_HOME ?? join(options.home ?? homedir(), ".config"),
    "opencode",
  );
  const paths = [
    join(global, "opencode.json"),
    join(global, "opencode.jsonc"),
    ...directories.flatMap((path) => [join(path, "opencode.json"), join(path, "opencode.jsonc")]),
    ...directories.flatMap((path) => [
      join(path, ".opencode", "opencode.json"),
      join(path, ".opencode", "opencode.jsonc"),
    ]),
  ];
  const documents: Document[] = [];
  for (const path of new Set(paths)) documents.push(await readDocument(path));
  return documents;
}

function readState(snapshot: ReceiptSnapshot<State>, project: string): State | undefined {
  const state = snapshot.document?.data;
  if (state === undefined) return undefined;
  const validManaged = (value: unknown): value is Managed =>
    object(value) &&
    typeof value.set === "string" &&
    typeof value.permissionsAdded === "boolean" &&
    (value.createdHash === null ||
      (typeof value.createdHash === "string" && /^[a-f0-9]{64}$/.test(value.createdHash))) &&
    Array.isArray(value.rules) &&
    value.rules.length > 0 &&
    value.rules.every(
      (rule, index) =>
        object(rule) &&
        Object.keys(rule).sort().join(",") === "action,effect,resource" &&
        rule.action === "skill" &&
        typeof rule.resource === "string" &&
        (index === 0
          ? rule.resource === "*" && rule.effect === "deny"
          : !/[?*\\]/.test(rule.resource) && rule.effect === "allow"),
    );
  if (
    !object(state) ||
    state.schema !== 1 ||
    state.client !== "opencode" ||
    typeof state.config !== "string" ||
    !configNames.includes(relative(project, state.config)) ||
    (state.active !== null && !validManaged(state.active)) ||
    (state.pending !== undefined &&
      (!object(state.pending) ||
        ![state.pending.before, state.pending.after].every(
          (v) => v === null || typeof v === "string",
        ) ||
        (state.pending.active !== null && !validManaged(state.pending.active))))
  )
    refuse("E_CLIENT_RECEIPT", "Invalid client isolation ownership state.", snapshot.path);
  return state;
}

async function prepare(options: ClientIsolationOptions, remove: boolean): Promise<Prepared> {
  const project = await projectRoot(options);
  const scope = remove ? undefined : await selection(options, project);
  const members = scope?.bindings.map((entry) => entry.name).sort() ?? [];
  if (members.some((name) => /[?*\\]/.test(name)))
    refuse("E_CLIENT_SKILL_ID", "Selected skill IDs cannot contain permission wildcards.", project);
  const stateOptions: ReceiptOptions = {
    ...options,
    forbiddenRoots: [project, ...(scope ? [scope.registry.root] : [])],
  };
  const snapshot = await readBoundReceipt<State>(project, binding, stateOptions);
  const previous = readState(snapshot, project);
  const inputs = remove
    ? [await readDocument(previous?.config ?? join(project, "opencode.json"))]
    : await configInputs(project, options);
  const local = inputs.filter(
    (entry) => entry.info && configNames.includes(relative(project, entry.path)),
  );
  if (!remove && local.length > 1)
    refuse(
      "E_CLIENT_CONFIG_PRECEDENCE",
      "Multiple project OpenCode configs require explicit consolidation; none were rewritten.",
      project,
    );
  const ownedPath = previous?.active || previous?.pending ? previous.config : undefined;
  const path = ownedPath ?? local[0]?.path ?? join(project, "opencode.json");
  if (!remove && local[0] && local[0].path !== path)
    refuse(
      "E_CLIENT_CONFIG_PRECEDENCE",
      "The project config moved while the receipt still owns rules in another file.",
      local[0].path,
    );
  const document = inputs.find((entry) => entry.path === path) ?? (await readDocument(path));
  const identities = await parents(path);
  let active = previous?.active ?? null;
  if (previous?.pending) {
    const current = hash(document.info ? document.text : null);
    if (current === previous.pending.after) active = previous.pending.active;
    else if (current !== previous.pending.before)
      refuse(
        "E_CLIENT_RECOVERY",
        "Config matches neither side of the interrupted isolation write; preserve it and inspect the receipt.",
        path,
      );
  }
  let baseText = document.text;
  if (active) baseText = removeOwned(document, active);
  const base = { ...document, text: baseText || "{}", node: parseDocument(baseText || "{}", path) };
  const desired: Rule[] = [
    { action: "skill", resource: "*", effect: "deny" },
    ...members.map((resource): Rule => ({ action: "skill", resource, effect: "allow" })),
  ];
  let after: string | null = document.info ? document.text : null;
  let next: Managed | null = null;
  const overrides: { path: string; rule: number }[] = [];
  if (remove) {
    if (active) after = active.createdHash === hash(document.text) ? null : baseText;
  } else {
    // Native V2 discovery applies every .opencode document after all direct documents.
    const higher = inputs
      .slice(inputs.findIndex((entry) => entry.path === path) + 1)
      .filter((entry) => entry.info);
    if (
      higher.some(
        (entry) =>
          permissionNode(entry) ||
          (entry.node.value as ObjectValue).agents ||
          (entry.node.value as ObjectValue).permission ||
          (entry.node.value as ObjectValue).agent,
      )
    )
      refuse(
        "E_CLIENT_CONFIG_PRECEDENCE",
        "A higher-priority .opencode config can override this project's isolation rules.",
        higher[0]?.path,
      );
    for (const entry of inputs.filter((entry) => entry.info))
      validateRules(
        entry.path === path ? base : entry,
        members,
        options.overridePermissions === true,
        overrides,
      );
    const range = active ? ownRange(document, active) : undefined;
    const tail = range
      ? rules(permissionNode(document) as Node, path).slice(range.start + range.count)
      : [];
    if (
      active &&
      isDeepStrictEqual(active.rules, desired) &&
      !tail.some((rule) => matches(rule.action, "skill"))
    ) {
      next = { ...active, set: scope?.set?.name as string };
    } else {
      const starting = document.info
        ? base
        : {
            ...base,
            text: '{\n  "$schema": "https://opencode.ai/config.json"\n}\n',
            node: parseDocument('{\n  "$schema": "https://opencode.ai/config.json"\n}\n', path),
          };
      after = appendRules(starting, desired);
      next = {
        set: scope?.set?.name as string,
        rules: desired,
        permissionsAdded: active?.permissionsAdded ?? permissionNode(document) === undefined,
        createdHash:
          !document.info ||
          (active?.createdHash !== null && active?.createdHash === hash(document.text))
            ? hash(after)
            : null,
      };
      ownRange({ ...document, text: after, node: parseDocument(after, path) }, next);
    }
  }
  const state: State = { schema: 1, client: "opencode", config: path, active: next };
  const changed = after !== (document.info ? document.text : null);
  return {
    plan: {
      client: "opencode",
      project,
      set: next?.set ?? null,
      members,
      config: path,
      receipt: snapshot.path,
      changes: changed
        ? [{ path, action: after === null ? "remove" : document.info ? "update" : "create" }]
        : [],
      recovery: previous?.pending !== undefined,
      overrides,
    },
    document,
    after,
    state,
    currentActive: active,
    snapshot,
    stateOptions,
    parents: identities,
    inputs,
    ...(scope ? { scope } : {}),
  };
}

async function assertUnchanged(prepared: Prepared, options: ClientIsolationOptions): Promise<void> {
  for (const [path, old] of prepared.parents) {
    const now = await inspectPath(path);
    if (!now?.isDirectory() || old.ino !== now.ino || old.dev !== now.dev)
      refuse("E_CLIENT_CONFIG_CHANGED", "Config parent changed during isolation.", path);
  }
  for (const old of prepared.inputs) {
    const now = await readDocument(old.path);
    if (
      old.text !== now.text ||
      old.info?.ino !== now.info?.ino ||
      old.info?.dev !== now.info?.dev ||
      old.info?.mode !== now.info?.mode
    )
      refuse(
        "E_CLIENT_CONFIG_CHANGED",
        "Configuration changed during isolation; rerun the preview.",
        old.path,
      );
  }
  if (
    prepared.scope &&
    !isDeepStrictEqual(await selection(options, prepared.plan.project), prepared.scope)
  )
    refuse(
      "E_CLIENT_SELECTION_CHANGED",
      "Project selection changed during isolation; rerun the preview.",
      prepared.plan.project,
    );
}

async function publish(
  prepared: Prepared,
  options: ClientIsolationOptions,
  published: () => void,
): Promise<void> {
  await assertUnchanged(prepared, options);
  const path = prepared.document.path;
  if (prepared.after === null) {
    await unlink(path);
    published();
  } else {
    const temporary = join(dirname(path), `.skillex-client-${randomUUID()}.tmp`);
    let identity: Stats | undefined;
    try {
      const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        prepared.document.info ? prepared.document.info.mode & 0o777 : 0o600,
      );
      try {
        identity = await handle.stat();
        await handle.writeFile(prepared.after);
        if (prepared.document.info) await handle.chmod(prepared.document.info.mode & 0o777);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await assertUnchanged(prepared, options);
      if (prepared.document.info) await rename(temporary, path);
      else await link(temporary, path);
      published();
    } finally {
      if (identity) {
        const current = await inspectPath(temporary);
        if (current?.ino === identity.ino && current.dev === identity.dev) await unlink(temporary);
      }
    }
  }
  const directory = await open(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  const current = await readDocument(path);
  if ((current.info ? current.text : null) !== prepared.after)
    refuse(
      "E_CLIENT_CONFIG_CHANGED",
      "Published config changed before it could be confirmed; the pending receipt was retained.",
      path,
    );
}

function failure<T>(command: string, error: unknown, data: T, applied = false): ResultEnvelope<T> {
  return makeResult(command, data, {
    exit: applied
      ? ExitCode.PARTIAL
      : error instanceof SkillexError
        ? error.exit
        : ExitCode.FAILURE,
    findings:
      error instanceof SkillexError
        ? error.findings
        : [
            {
              code: "E_CLIENT_IO",
              severity: "error",
              message: error instanceof Error ? error.message : String(error),
              fix: "Inspect the project config and client state, then repeat the preview. Interrupted writes retain an ownership receipt.",
            },
          ],
  });
}

export class ClientIsolationCommand {
  constructor(
    readonly options: ClientIsolationOptions,
    readonly remove = false,
  ) {}

  async plan(): Promise<ClientIsolationPlan> {
    return (await prepare(this.options, this.remove)).plan;
  }

  async execute(): Promise<ResultEnvelope<ClientIsolationResult | null>> {
    const command = this.remove ? "clients.unisolate" : "clients.isolate";
    let data: ClientIsolationResult | null = null;
    let applied = false;
    try {
      const initial = await prepare(this.options, this.remove);
      data = {
        ...initial.plan,
        dryRun: !this.options.apply,
        applied: false,
        runtimeVerified: false,
      };
      const needsReceipt = (entry: Prepared) =>
        entry.snapshot.document !== undefined &&
        !isDeepStrictEqual(entry.snapshot.document.data, entry.state);
      let prepared = initial;
      if (this.options.apply && (initial.plan.changes.length || needsReceipt(initial))) {
        prepared = await withLock(
          `client-isolation:opencode:${initial.plan.project}`,
          async () => {
            const current = await prepare(this.options, this.remove);
            if (current.plan.changes.length) {
              const pending: State = {
                ...current.state,
                active: current.currentActive,
                pending: {
                  before: hash(current.document.info ? current.document.text : null),
                  after: hash(current.after),
                  active: current.state.active,
                },
              };
              const receipt = await writeBoundReceipt(
                current.snapshot,
                pending,
                current.stateOptions,
              );
              await publish(current, this.options, () => {
                applied = true;
              });
              await writeBoundReceipt(receipt, current.state, current.stateOptions);
            } else if (needsReceipt(current)) {
              await writeBoundReceipt(current.snapshot, current.state, current.stateOptions);
            }
            return current;
          },
          this.options,
        );
      }
      data = { ...prepared.plan, dryRun: !this.options.apply, applied, runtimeVerified: false };
      return makeResult(command, data, {
        findings: this.remove
          ? []
          : [
              {
                code: "W_CLIENT_RUNTIME_UNVERIFIED",
                severity: "warning",
                message:
                  "Project permission isolation is planned/configured, not runtime-certified. Agent, policy, or session overrides may still change effective visibility.",
                path: prepared.document.path,
                fix: `skillex clients verify --client opencode --project ${JSON.stringify(prepared.plan.project)} --session <existing-probe-session> --agent build`,
              },
            ],
      });
    } catch (error) {
      return failure(command, error, data ? { ...data, applied } : null, applied);
    }
  }
}

export function isolateClient(options: ClientIsolationOptions) {
  return new ClientIsolationCommand(options).execute();
}

/** Removes only receipt-owned rules; works after the project set has been unset. */
export function unisolateClient(options: ClientIsolationOptions) {
  return new ClientIsolationCommand(options, true).execute();
}

function envelope(value: unknown): ObjectValue {
  if (!object(value) || !("data" in value))
    refuse("E_CLIENT_API", "OpenCode returned an unsupported API envelope.");
  return value;
}

/** Checks the actual permission service, including agent and session overrides, without inference. */
export async function verifyClientIsolation(
  options: ClientVerifyOptions,
  request?: OpenCodeRequest,
): Promise<ResultEnvelope<ClientVerification | null>> {
  const findings: Diagnostic[] = [];
  try {
    const project = await projectRoot(options);
    const scope = await selection(options, project);
    const session = options.session;
    const agent = options.agent ?? "build";
    if (!session || !/^ses_[A-Za-z0-9_-]+$/.test(session) || !agent.trim())
      fail(
        "E_CLIENT_PROBE_SESSION",
        "Verification requires an existing --session ses_… and a nonempty --agent (default build).",
        {
          fix: "Supply a dedicated probe session already located in the project. No session is created and no inference is triggered.",
        },
      );
    const api: OpenCodeRequest =
      request ??
      (async (method, path, body) => {
        return apiDocument(
          ["api", method, path, ...(body ? ["--data", JSON.stringify(body)] : [])],
          project,
          { ...(options.env ?? process.env) },
        );
      });
    const sessionPath = `/api/session/${encodeURIComponent(session)}`;
    const found = envelope(await api("get", sessionPath)).data;
    if (
      !object(found) ||
      found.id !== session ||
      !object(found.location) ||
      found.location.directory !== project ||
      (found.subpath !== undefined && found.subpath !== "" && found.subpath !== ".")
    )
      refuse(
        "E_CLIENT_PROBE_LOCATION",
        "The supplied session is not located at the exact selected project. It was not moved.",
        project,
      );
    const list = envelope(
      await api("get", `/api/skill?${new URLSearchParams({ "location[directory]": project })}`),
    );
    if (!object(list.location) || list.location.directory !== project || !Array.isArray(list.data))
      refuse("E_CLIENT_API", "Skill registry response does not match the requested location.");
    const registered = new Map<string, ObjectValue>();
    for (const entry of list.data) {
      if (
        !object(entry) ||
        typeof entry.id !== "string" ||
        typeof entry.path !== "string" ||
        registered.has(entry.id)
      )
        refuse("E_CLIENT_API", "Skill registry returned malformed or duplicate IDs.");
      registered.set(entry.id, entry);
    }
    const selected = new Map(scope.bindings.map((entry) => [entry.name, entry]));
    const advertised: string[] = [];
    for (const [id, member] of selected) {
      const skill = registered.get(id);
      let code: Diagnostic["code"] | undefined;
      let message = "";
      if (!skill) {
        code = "E_CLIENT_SKILL_MISSING";
        message = `Selected skill ${id} is not registered.`;
      } else if (
        (await realpath(skill.path as string).catch(() => null)) !==
        (await realpath(join(member.path, "SKILL.md")))
      ) {
        code = "E_CLIENT_SKILL_SHADOWED";
        message = `Skill ${id} resolves to a different definition than the canonical selected set.`;
      } else if (
        typeof skill.description !== "string" ||
        !skill.description.trim() ||
        skill.autoinvoke === false
      ) {
        code = "E_CLIENT_NOT_ADVERTISED";
        message = `Selected skill ${id} lacks advertisement metadata or disables automatic invocation.`;
      } else advertised.push(id);
      if (code)
        findings.push({
          code,
          severity: "error",
          message,
          name: id,
          fix: "Correct discovery/activation or the canonical skill's metadata, then verify again.",
        });
    }
    let sentinel = `skillex-isolation-probe-${createHash("sha256").update(project).digest("hex").slice(0, 16)}`;
    while (registered.has(sentinel) || selected.has(sentinel)) sentinel += "-x";
    const ids = [...new Set([...selected.keys(), ...registered.keys(), sentinel])].sort();
    const checked: ClientVerification["checked"][number][] = [];
    for (const id of ids) {
      const response = envelope(
        await api("post", `${sessionPath}/permission`, { action: "skill", resources: [id], agent }),
      ).data;
      if (
        !object(response) ||
        typeof response.id !== "string" ||
        !["allow", "deny", "ask"].includes(String(response.effect))
      )
        refuse("E_CLIENT_API", "Permission evaluator returned an unsupported result.");
      const effect = response.effect as Rule["effect"];
      const expected = selected.has(id) ? "allow" : "deny";
      checked.push({ id, expected, effect, request: response.id });
      if (effect !== expected)
        findings.push({
          code: selected.has(id) ? "E_CLIENT_PERMISSION_MISMATCH" : "E_CLIENT_VISIBILITY_LEAK",
          severity: "error",
          name: id,
          message: `${agent}: ${id} evaluated ${effect}; expected ${expected}.`,
          fix: "Inspect effective agent/session permissions and policies, then repeat verification. The raw registry is not evidence of isolation.",
        });
      if (effect === "ask")
        findings.push({
          code: "W_CLIENT_PROBE_PENDING",
          severity: "warning",
          name: id,
          message: `Probe created pending permission ${response.id} in ${session}; it was not approved or rejected on your behalf.`,
          fix: "Review the pending request in the dedicated probe session. Automatic rejection could reject unrelated requests too.",
        });
    }
    const finalSession = envelope(await api("get", sessionPath)).data;
    if (
      !object(finalSession) ||
      !isDeepStrictEqual(finalSession.location, found.location) ||
      !isDeepStrictEqual(finalSession.permissions, found.permissions) ||
      finalSession.subpath !== found.subpath ||
      !isDeepStrictEqual(await selection(options, project), scope)
    )
      refuse(
        "E_CLIENT_PROBE_CHANGED",
        "Session location/permissions or selected set changed during verification. Repeat the bounded probe.",
        project,
      );
    const data: ClientVerification = {
      client: "opencode",
      project,
      set: scope.set?.name as string,
      session,
      agent,
      evidence: "opencode-v2-permission-evaluator",
      registryCount: registered.size,
      checked,
      advertised: advertised
        .filter((id) => checked.some((entry) => entry.id === id && entry.effect === "allow"))
        .sort(),
    };
    return makeResult("clients.verify", data, {
      exit: findings.some((finding) => finding.severity === "error")
        ? ExitCode.DRIFT
        : ExitCode.SUCCESS,
      findings,
    });
  } catch (error) {
    return failure("clients.verify", error, null);
  }
}
