import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { entry, matches } from "./activation-ownership.js";
import type { EntryIdentity } from "./activation-types.js";
import { fail, SkillexError } from "./error.js";
import { localHostIdentities } from "./host-identity.js";
import { type LockOptions, withLock } from "./lock.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";

/**
 * Retire inert activation / profile receipts.
 *
 * A receipt is the record of what skillex owns under one skill root. It goes inert in two
 * ways: the root was recreated (the recorded inode no longer matches: `stale`, the cause of
 * E_OWNERSHIP_CHANGED on every later sync), or the recorded path is gone (`orphan`). Neither
 * receipt protects anything, so retiring it backs the JSON up and removes it. The skill root
 * and everything in it are never read for content, written, moved, or deleted.
 */

export type ReceiptNamespace = "activations" | "profiles";
export type ReceiptState = "valid" | "stale" | "orphan" | "invalid" | "foreign-host";

export interface ReceiptRetireOptions extends LockOptions {
  /** Receipt ids (hex prefix, at least 8 characters), scope roots, or skill roots. */
  readonly targets?: readonly string[];
  /** Select every stale and orphan receipt. */
  readonly allStale?: boolean;
  readonly apply?: boolean;
  readonly dryRun?: boolean;
  /** Retire a valid, pending or unreadable receipt when it is named explicitly. */
  readonly force?: boolean;
  /** Where backups go; default `<state>/skillex/retired-receipts/<UTC ts>-receipt-retire`. */
  readonly backupDir?: string;
  readonly cwd?: string;
  readonly now?: Date;
}

export interface ReceiptListOptions extends LockOptions {
  readonly state?: ReceiptState;
  readonly namespace?: ReceiptNamespace;
}

export interface ReceiptRecord {
  readonly id: string;
  readonly namespace: ReceiptNamespace;
  readonly path: string;
  readonly scopeRoot: string | null;
  readonly activationRoot: string | null;
  readonly state: ReceiptState;
  readonly reason: string;
  /** An interrupted operation journal is recorded in the receipt. */
  readonly pending: boolean;
  readonly sha256: string;
}

export interface ReceiptListResult {
  readonly stateHome: string;
  readonly receipts: readonly ReceiptRecord[];
  readonly counts: Readonly<Record<ReceiptState, number>>;
}

export interface ReceiptRetireEntry extends ReceiptRecord {
  readonly action: "retire" | "refuse";
  readonly why: string;
}

export interface ReceiptRetireResult {
  readonly dryRun: boolean;
  readonly stateHome: string;
  readonly backupDir: string | null;
  readonly entries: readonly ReceiptRetireEntry[];
  readonly retired: readonly string[];
  readonly backups: readonly string[];
}

const NAMESPACES: readonly ReceiptNamespace[] = ["activations", "profiles"];
const RECEIPT_NAME = /^([a-f0-9]{64})\.json$/;
const STATES: readonly ReceiptState[] = ["valid", "stale", "orphan", "invalid", "foreign-host"];

interface Scanned {
  readonly record: ReceiptRecord;
  readonly bytes: Buffer;
  readonly info: Stats;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stateHomeFor(options: LockOptions): string {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const chosen = options.stateHome ?? env.XDG_STATE_HOME ?? join(home, ".local", "state");
  return resolve(
    chosen === "~" ? home : chosen.startsWith("~/") ? join(home, chosen.slice(2)) : chosen,
  );
}

function identityOf(value: unknown): EntryIdentity | undefined {
  if (!record(value)) return undefined;
  if (value.kind !== "directory" && value.kind !== "link") return undefined;
  if (typeof value.dev !== "string" || typeof value.ino !== "string") return undefined;
  return value as unknown as EntryIdentity;
}

/** The identity the receipt recorded for the skill root itself, if it recorded one. */
function recordedRoot(
  namespace: ReceiptNamespace,
  root: string,
  data: Record<string, unknown>,
): EntryIdentity | undefined {
  if (namespace === "profiles") return identityOf(data.root);
  const directories = record(data.directories) ? data.directories : {};
  const links = record(data.links) ? data.links : {};
  return identityOf(directories[root]) ?? identityOf(links[root]);
}

async function exists(path: string): Promise<boolean | "unknown"> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? false : "unknown";
  }
}

async function classify(
  namespace: ReceiptNamespace,
  document: Record<string, unknown>,
): Promise<Pick<ReceiptRecord, "state" | "reason" | "pending" | "scopeRoot" | "activationRoot">> {
  const scopeRoot = typeof document.scopeRoot === "string" ? document.scopeRoot : null;
  const activationRoot =
    typeof document.activationRoot === "string" ? document.activationRoot : null;
  const base = { scopeRoot, activationRoot, pending: false };
  const data = record(document.data) ? document.data : undefined;
  if (
    document.schema !== 2 ||
    !scopeRoot ||
    !activationRoot ||
    !isAbsolute(scopeRoot) ||
    !isAbsolute(activationRoot) ||
    !data
  )
    return { ...base, state: "invalid", reason: "not a version 2 receipt document" };
  const pending = data.pending !== undefined;
  const withPending = { ...base, pending };
  if (typeof document.host !== "string" || !localHostIdentities().includes(document.host))
    return {
      ...withPending,
      state: "foreign-host",
      reason: `written on another host (${String(document.host)})`,
    };
  if (document.uid !== (process.getuid?.() ?? null))
    return { ...withPending, state: "invalid", reason: "written by another user" };

  const scope = await exists(scopeRoot);
  if (scope === "unknown")
    return { ...withPending, state: "invalid", reason: "the scope root cannot be inspected" };
  if (scope === false)
    return { ...withPending, state: "orphan", reason: "the scope root no longer exists" };
  const root = await exists(activationRoot);
  if (root === "unknown")
    return { ...withPending, state: "invalid", reason: "the skill root cannot be inspected" };
  if (root === false)
    return { ...withPending, state: "orphan", reason: "the recorded skill root no longer exists" };

  const expected = recordedRoot(namespace, activationRoot, data);
  if (!expected)
    return {
      ...withPending,
      state: "valid",
      reason: "the skill root exists and the receipt recorded no root identity to compare",
    };
  const actual = await entry(activationRoot);
  if (!matches(actual, expected))
    return {
      ...withPending,
      state: "stale",
      reason: "the skill root was recreated; its recorded identity no longer matches",
    };
  return { ...withPending, state: "valid", reason: "the skill root still matches its receipt" };
}

async function readReceipt(path: string): Promise<{ bytes: Buffer; info: Stats } | undefined> {
  const info = await lstat(path);
  if (!info.isFile()) return undefined;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = await handle.readFile();
    return { bytes, info };
  } finally {
    await handle.close();
  }
}

async function scanOne(
  namespace: ReceiptNamespace,
  directory: string,
  file: string,
  id: string,
): Promise<Scanned | undefined> {
  const path = join(directory, file);
  let loaded: { bytes: Buffer; info: Stats } | undefined;
  try {
    loaded = await readReceipt(path);
  } catch {
    loaded = undefined;
  }
  if (!loaded) return undefined;
  const sha256 = createHash("sha256").update(loaded.bytes).digest("hex");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(loaded.bytes));
  } catch {
    parsed = undefined;
  }
  if (!record(parsed))
    return {
      bytes: loaded.bytes,
      info: loaded.info,
      record: {
        id,
        namespace,
        path,
        scopeRoot: null,
        activationRoot: null,
        state: "invalid",
        reason: "the receipt is not a readable JSON object",
        pending: false,
        sha256,
      },
    };
  const verdict = await classify(namespace, parsed);
  return {
    bytes: loaded.bytes,
    info: loaded.info,
    record: { id, namespace, path, sha256, ...verdict },
  };
}

async function scan(
  stateHome: string,
  namespaces: readonly ReceiptNamespace[],
): Promise<Scanned[]> {
  const found: Scanned[] = [];
  for (const namespace of namespaces) {
    const directory = join(stateHome, "skillex", namespace, "v2");
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const file of names.sort()) {
      const match = RECEIPT_NAME.exec(file);
      if (!match) continue;
      const scanned = await scanOne(namespace, directory, file, match[1] as string);
      if (scanned) found.push(scanned);
    }
  }
  return found;
}

function count(records: readonly ReceiptRecord[]): Record<ReceiptState, number> {
  const counts = Object.fromEntries(STATES.map((state) => [state, 0])) as Record<
    ReceiptState,
    number
  >;
  for (const item of records) counts[item.state] += 1;
  return counts;
}

function failure(error: unknown, command: string): ResultEnvelope<null> {
  if (error instanceof SkillexError)
    return makeResult(command, null, { exit: error.exit, findings: error.findings });
  return makeResult(command, null, {
    exit: ExitCode.FAILURE,
    findings: [
      {
        code: "E_IO",
        severity: "error",
        message: `Receipt operation failed: ${error instanceof Error ? error.message : String(error)}`,
        fix: "Check the state directory and its permissions, then retry.",
      },
    ],
  });
}

/** Read-only inventory of activation and profile receipts and whether each is still alive. */
export async function listReceipts(
  options: ReceiptListOptions = {},
): Promise<ResultEnvelope<ReceiptListResult | null>> {
  try {
    const stateHome = stateHomeFor(options);
    const scanned = await scan(stateHome, options.namespace ? [options.namespace] : NAMESPACES);
    const all = scanned.map((item) => item.record);
    const receipts = options.state ? all.filter((item) => item.state === options.state) : all;
    return makeResult("receipt list", { stateHome, receipts, counts: count(receipts) });
  } catch (error) {
    return failure(error, "receipt list") as ResultEnvelope<null>;
  }
}

async function comparable(path: string): Promise<string[]> {
  const lexical = resolve(path);
  try {
    const real = await realpath(lexical);
    return real === lexical ? [lexical] : [lexical, real];
  } catch {
    return [lexical];
  }
}

async function selects(
  item: ReceiptRecord,
  targets: readonly string[],
  cwd: string,
): Promise<boolean> {
  for (const target of targets) {
    if (/^[a-f0-9]{8,64}$/.test(target) && item.id.startsWith(target)) return true;
    const wanted = await comparable(isAbsolute(target) ? target : resolve(cwd, target));
    const known = [item.scopeRoot, item.activationRoot].filter((p): p is string => p !== null);
    if (known.some((p) => wanted.includes(p))) return true;
  }
  return false;
}

function timestamp(now: Date): string {
  return now
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replace(/[:]/g, "")
    .replace(/-/g, "");
}

function decide(item: ReceiptRecord, explicit: boolean, force: boolean): ReceiptRetireEntry {
  const retire = (why: string): ReceiptRetireEntry => ({ ...item, action: "retire", why });
  const refuse = (why: string): ReceiptRetireEntry => ({ ...item, action: "refuse", why });
  if (item.state === "foreign-host")
    return refuse("another host's receipt cannot be judged from here; retire it on that host");
  if ((item.state === "stale" || item.state === "orphan") && !item.pending)
    return retire(item.reason);
  if (!explicit)
    return refuse("not selected: only stale and orphan receipts without a pending journal");
  if (!force) {
    if (item.pending)
      return refuse(
        "an interrupted operation journal is recorded; use --force to retire it anyway",
      );
    if (item.state === "valid")
      return refuse(
        "the receipt is currently valid and protects its skill root; use --force to retire it anyway",
      );
    return refuse("the receipt is unreadable or unrecognized; use --force to retire it anyway");
  }
  return retire(`forced (${item.state}: ${item.reason})`);
}

async function writeNew(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function lockResource(item: ReceiptRecord): string {
  return item.namespace === "activations"
    ? "skillex:activation:v2"
    : `skillex:profiles:v2:${item.activationRoot ?? item.id}`;
}

/**
 * Preview (default) or apply the retirement of inert receipts. Only receipt JSON under the
 * state directory is ever removed, after its bytes are copied to the backup directory and
 * read back. The skill roots the receipts describe are never touched.
 */
export async function retireReceipts(
  options: ReceiptRetireOptions = {},
): Promise<ResultEnvelope<ReceiptRetireResult | null>> {
  const command = "receipt retire";
  try {
    const targets = [...(options.targets ?? [])];
    if (options.apply && options.dryRun)
      fail("E_SCOPE", "--apply and --dry-run are mutually exclusive.", {
        fix: "Omit both to preview, or pass --apply to retire.",
      });
    if (!options.allStale && targets.length === 0)
      fail("E_RECEIPT_TARGET", "Name the receipts to retire, or pass --all-stale.", {
        fix: "Give a receipt id, a project or scope path, a skill root path, or --all-stale. `skillex receipt list` shows them.",
      });
    const stateHome = stateHomeFor(options);
    const cwd = options.cwd ?? process.cwd();
    const dryRun = !options.apply;
    const force = options.force === true;
    const scanned = await scan(stateHome, NAMESPACES);

    const chosen: Scanned[] = [];
    const unmatched: string[] = [];
    for (const target of targets) {
      let any = false;
      for (const item of scanned) {
        if (await selects(item.record, [target], cwd)) {
          any = true;
          if (!chosen.includes(item)) chosen.push(item);
        }
      }
      if (!any) unmatched.push(target);
    }
    if (unmatched.length)
      fail("E_RECEIPT_NOT_FOUND", `No receipt matches: ${unmatched.join(", ")}`, {
        fix: "Use `skillex receipt list` to see receipt ids, scope roots and skill roots.",
      });
    const explicit = new Set(chosen);
    if (options.allStale)
      for (const item of scanned)
        if (
          (item.record.state === "stale" || item.record.state === "orphan") &&
          !chosen.includes(item)
        )
          chosen.push(item);

    const rows = chosen.map((source) => ({
      source,
      entry: decide(source.record, explicit.has(source), force),
      named: explicit.has(source),
    }));
    const plan: ReceiptRetireEntry[] = rows.map((row) => row.entry);
    const findings: Diagnostic[] = rows
      .filter((row) => row.named && row.entry.action === "refuse")
      .map(({ entry: item }) => ({
        code: "E_RECEIPT_RETIRE_REFUSED",
        severity: "error",
        message: `Refused to retire ${item.id}: ${item.why}`,
        ...(item.activationRoot ? { path: item.activationRoot } : {}),
        fix: "Inspect `skillex receipt list`; only stale or orphan receipts retire without --force.",
      }));
    const retiring = rows.filter((row) => row.entry.action === "retire");

    if (dryRun || retiring.length === 0)
      return makeResult(
        command,
        { dryRun, stateHome, backupDir: null, entries: plan, retired: [], backups: [] },
        { exit: findings.length ? ExitCode.REFUSED : ExitCode.SUCCESS, findings },
      );
    if (findings.length)
      // A refused explicit target stops the whole apply: nothing is half-retired.
      return makeResult(
        command,
        { dryRun: false, stateHome, backupDir: null, entries: plan, retired: [], backups: [] },
        { exit: ExitCode.REFUSED, findings },
      );

    const now = options.now ?? new Date();
    const backupDir = options.backupDir
      ? resolve(cwd, options.backupDir)
      : join(stateHome, "skillex", "retired-receipts", `${timestamp(now)}-receipt-retire`);
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    const retired: string[] = [];
    const backups: string[] = [];
    const failures: Diagnostic[] = [];
    for (const { source, entry: item, named } of retiring) {
      try {
        await withLock(
          lockResource(item),
          async () => {
            const current = await readReceipt(item.path);
            if (
              !current ||
              createHash("sha256").update(current.bytes).digest("hex") !== item.sha256 ||
              current.info.ino !== source.info.ino
            )
              fail(
                "E_RECEIPT_CHANGED",
                `Receipt ${item.id} changed since it was inspected.`,
                {
                  path: item.path,
                  fix: "Re-run the preview.",
                },
                ExitCode.REFUSED,
              );
            const again = await scanOne(
              item.namespace,
              join(stateHome, "skillex", item.namespace, "v2"),
              `${item.id}.json`,
              item.id,
            );
            const verdict = again && decide(again.record, named, force);
            if (verdict?.action !== "retire")
              fail(
                "E_RECEIPT_CHANGED",
                `Receipt ${item.id} is no longer retirable: ${verdict?.why ?? "gone"}`,
                {
                  path: item.path,
                  fix: "Re-run the preview.",
                },
                ExitCode.REFUSED,
              );
            const folder = join(backupDir, item.namespace);
            await mkdir(folder, { recursive: true, mode: 0o700 });
            await chmod(folder, 0o700);
            const copy = join(folder, `${item.id}.json`);
            await writeNew(copy, current.bytes);
            const verify = await readReceipt(copy);
            if (!verify?.bytes.equals(current.bytes))
              fail("E_IO", `Backup of ${item.id} could not be verified; the receipt was kept.`, {
                path: copy,
              });
            await unlink(item.path);
            backups.push(copy);
            retired.push(item.path);
          },
          options,
        );
      } catch (error) {
        const result = failure(error, command);
        failures.push(...result.findings);
      }
    }
    if (retired.length > 0) {
      const manifest = {
        schema: 1,
        id: randomUUID(),
        at: now.toISOString(),
        stateHome,
        retired: plan
          .filter((item) => retired.includes(item.path))
          .map(({ id, namespace, path, scopeRoot, activationRoot, state, reason, why }) => ({
            id,
            namespace,
            path,
            scopeRoot,
            activationRoot,
            state,
            reason,
            why,
          })),
      };
      await writeNew(
        join(backupDir, "receipt-retire.json"),
        Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
      );
    }
    return makeResult(
      command,
      { dryRun: false, stateHome, backupDir, entries: plan, retired, backups },
      {
        exit: failures.length
          ? retired.length
            ? ExitCode.PARTIAL
            : ExitCode.REFUSED
          : ExitCode.SUCCESS,
        findings: failures,
      },
    );
  } catch (error) {
    return failure(error, command) as ResultEnvelope<null>;
  }
}
