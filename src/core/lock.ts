import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fail, SkillexError } from "./error.js";
import { ExitCode } from "./result.js";

export interface LockOptions {
  readonly home?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stateHome?: string;
  readonly timeoutMs?: number;
}

interface Identity {
  readonly name: string;
  readonly hostHash: string;
  readonly pid: number;
  readonly id: string;
}

interface Claim extends Identity {
  readonly path: string;
  readonly identity: Stats;
  readonly number?: bigint;
}

interface Ticket {
  readonly schema: 1;
  readonly host: string;
  readonly pid: number;
  readonly id: string;
  readonly resource: string;
  readonly number: string;
}

const ticketFile = "ticket.json";
const preparingFile = "ticket.preparing";
const claimPattern =
  /^([a-f0-9]{64})\.([1-9][0-9]*)\.([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.claim$/;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stateFailure(path: string, message: string): never {
  fail(
    "E_LOCK_STATE",
    message,
    {
      path,
      fix: "Inspect the lock state and restore its owned directories/files before retrying; unrelated state is never removed.",
    },
    ExitCode.REFUSED,
  );
}

function ioFailure(error: unknown, path: string): never {
  if (error instanceof SkillexError) throw error;
  fail(
    "E_IO",
    `Cannot access lock state: ${error instanceof Error ? error.message : String(error)}`,
    {
      path,
      fix: "Check the selected XDG state directory and its filesystem permissions, then retry.",
    },
    ExitCode.FAILURE,
  );
}

async function inspect(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function owned(path: string, stat: Stats, directory: boolean): void {
  if (directory ? !stat.isDirectory() : !stat.isFile()) {
    stateFailure(path, `Lock state must be a real ${directory ? "directory" : "file"}: ${path}`);
  }
  if (process.getuid && stat.uid !== process.getuid()) {
    stateFailure(path, `Lock state belongs to a different filesystem user: ${path}`);
  }
}

async function ensureDirectory(path: string, checkOwner = true): Promise<Stats> {
  let stat = await inspect(path);
  if (!stat) {
    const parent = dirname(path);
    if (parent !== path) await ensureDirectory(parent, false);
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    stat = await lstat(path);
  }
  if (!stat.isDirectory()) stateFailure(path, `Lock state is not a real directory: ${path}`);
  if (checkOwner) owned(path, stat, true);
  return stat;
}

async function sameDirectory(path: string, identity: Stats): Promise<boolean> {
  const current = await inspect(path);
  if (!current) return false;
  owned(path, current, true);
  if (current.dev !== identity.dev || current.ino !== identity.ino) {
    stateFailure(path, `A lock directory was replaced during the operation: ${path}`);
  }
  return true;
}

function identityFrom(name: string, path: string): Identity {
  const parts = claimPattern.exec(name);
  const hostHash = parts?.[1];
  const pidText = parts?.[2];
  const id = parts?.[3];
  const pid = Number(pidText);
  if (!hostHash || !id || !Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647) {
    stateFailure(path, `Unrecognized entry in the lock directory: ${name}`);
  }
  return { name, hostHash, pid, id };
}

function ownerGone(identity: Identity, localHostHash: string): boolean {
  if (identity.hostHash !== localHostHash) return false;
  try {
    process.kill(identity.pid, 0);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return true;
    if (code === "EPERM") return false;
    throw error;
  }
}

async function claimFiles(claim: Claim): Promise<string[] | undefined> {
  if (!(await sameDirectory(claim.path, claim.identity))) return undefined;
  let names: string[];
  try {
    names = await readdir(claim.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  for (const name of names) {
    const path = join(claim.path, name);
    if (![ticketFile, preparingFile].includes(name)) {
      stateFailure(path, `A lock claim contains unrecognized content: ${path}`);
    }
    const stat = await inspect(path);
    if (stat) owned(path, stat, false);
  }
  if (names.includes(ticketFile) && names.includes(preparingFile)) {
    const published = await inspect(join(claim.path, ticketFile));
    const preparing = await inspect(join(claim.path, preparingFile));
    if (
      published &&
      preparing &&
      (published.dev !== preparing.dev || published.ino !== preparing.ino)
    ) {
      stateFailure(
        claim.path,
        "Published and preparing ticket files have different owners; cleanup refused.",
      );
    }
  }
  return names;
}

async function readTicket(claim: Claim, resource: string): Promise<bigint | undefined> {
  const path = join(claim.path, ticketFile);
  const stat = await inspect(path);
  if (!stat) return undefined;
  owned(path, stat, false);
  if (stat.size > 4096) stateFailure(path, "Lock ticket is too large to be a valid claim.");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) stateFailure(path, "Lock ticket is malformed JSON.");
    throw error;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    stateFailure(path, "Lock ticket is not an ownership record.");
  }
  const ticket = raw as Record<string, unknown>;
  if (
    Object.keys(ticket).sort().join(",") !== "host,id,number,pid,resource,schema" ||
    ticket.schema !== 1 ||
    ticket.id !== claim.id ||
    ticket.pid !== claim.pid ||
    ticket.resource !== resource ||
    typeof ticket.host !== "string" ||
    hash(ticket.host) !== claim.hostHash ||
    typeof ticket.number !== "string" ||
    !/^[1-9][0-9]*$/.test(ticket.number)
  ) {
    stateFailure(path, "Lock ticket does not match its immutable claim identity.");
  }
  return BigInt(ticket.number);
}

/** Unique claim names are never reused, so concurrent reapers cannot unlink a new owner. */
async function removeClaim(
  claim: Claim,
  expectedTicket?: string,
  ownedTicket?: Stats | null,
): Promise<void> {
  const names = await claimFiles(claim);
  if (!names) return;
  if (ownedTicket !== undefined) {
    for (const name of names) {
      const current = await inspect(join(claim.path, name));
      if (
        current &&
        (!ownedTicket || current.dev !== ownedTicket.dev || current.ino !== ownedTicket.ino)
      ) {
        stateFailure(
          claim.path,
          "This invocation does not own a file added to its claim; release refused.",
        );
      }
    }
  }
  if (expectedTicket !== undefined && names.includes(ticketFile)) {
    let current: string | undefined;
    try {
      current = await readFile(join(claim.path, ticketFile), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current !== undefined && current !== expectedTicket) {
      stateFailure(
        claim.path,
        "This invocation's immutable lock ticket was changed; release refused.",
      );
    }
  }
  if (!(await sameDirectory(claim.path, claim.identity))) return;
  for (const name of names) {
    try {
      await unlink(join(claim.path, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  try {
    await rmdir(claim.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY") {
      stateFailure(claim.path, "Unrecognized content appeared in a lock claim; cleanup refused.");
    }
    throw error;
  }
}

async function claims(
  path: string,
  directory: Stats,
  resource: string,
  localHostHash: string,
): Promise<Claim[]> {
  if (!(await sameDirectory(path, directory))) stateFailure(path, "Lock directory disappeared.");
  const result: Claim[] = [];
  for (const name of (await readdir(path)).sort()) {
    const claimPath = join(path, name);
    const identity = identityFrom(name, claimPath);
    const stat = await inspect(claimPath);
    if (!stat) continue;
    owned(claimPath, stat, true);
    const claim: Claim = { ...identity, path: claimPath, identity: stat };
    if (!(await claimFiles(claim))) continue;
    const number = await readTicket(claim, resource);
    if (ownerGone(claim, localHostHash)) {
      await removeClaim(claim);
      continue;
    }
    // Disappearance means that participant returned to its noncritical section.
    if (!(await sameDirectory(claim.path, claim.identity))) continue;
    result.push({ ...claim, ...(number === undefined ? {} : { number }) });
  }
  return result;
}

function statePath(options: LockOptions): string {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const selected = options.stateHome ?? env.XDG_STATE_HOME ?? join(home, ".local", "state");
  if (typeof selected !== "string" || !selected.trim() || selected.includes("\0")) {
    fail("E_LOCK_CONFIG", "Lock state requires a nonempty directory path.", {
      fix: "Set stateHome or XDG_STATE_HOME to the intended local state directory.",
    });
  }
  return resolve(
    selected === "~" ? home : selected.startsWith("~/") ? join(home, selected.slice(2)) : selected,
  );
}

/**
 * Filesystem adaptation of Lamport's bakery algorithm (CACM, August 1974):
 * https://lamport.azurewebsites.net/pubs/bakery.pdf
 *
 * A published unique claim without a ticket is choosing. Its immutable ticket is
 * max(existing tickets)+1; contenders wait for choosing peers and smaller
 * (ticket, claim-name) pairs. A later entrant sees the current ticket before
 * choosing, so newly appearing participants cannot bypass a holder. Local atomic
 * mkdir/link and coherent directory reads are required; this is not a network
 * filesystem lease. Only a proven-dead local PID can erase a failed participant.
 */
export async function withLock<T>(
  resource: string,
  action: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  if (typeof resource !== "string" || !resource.trim() || typeof action !== "function") {
    fail("E_LOCK_CONFIG", "A lock requires a nonempty resource identity and an action.", {
      fix: "Pass the canonical resource key and an asynchronous callback.",
    });
  }
  const timeout = options.timeoutMs ?? 2000;
  if (!Number.isFinite(timeout) || timeout < 0) {
    fail("E_LOCK_CONFIG", "Lock timeout must be a finite nonnegative number of milliseconds.", {
      fix: "Choose timeoutMs >= 0; zero performs one immediate acquisition attempt.",
    });
  }
  const started = performance.now();
  const base = statePath(options);
  const resourceHash = hash(resource);
  const host = hostname();
  const hostHash = hash(host);
  const id = randomUUID();
  const name = `${hostHash}.${process.pid}.${id}.claim`;
  let lockPath = base;
  let claim: Claim | undefined;
  let ticketText: string | undefined;
  let ticketIdentity: Stats | undefined;
  let inAction = false;
  try {
    await ensureDirectory(base);
    lockPath = await realpath(base);
    for (const part of ["skillex", "locks", resourceHash]) {
      lockPath = join(lockPath, part);
      await ensureDirectory(lockPath);
    }
    const directory = await lstat(lockPath);
    const claimPath = join(lockPath, name);
    await mkdir(claimPath, { mode: 0o700 });
    claim = {
      name,
      hostHash,
      id,
      pid: process.pid,
      path: claimPath,
      identity: await lstat(claimPath),
    };
    const peers = await claims(lockPath, directory, resourceHash, hostHash);
    const number =
      peers.reduce(
        (largest, peer) => (peer.number && peer.number > largest ? peer.number : largest),
        0n,
      ) + 1n;
    const ticket: Ticket = {
      schema: 1,
      host,
      pid: process.pid,
      id,
      resource: resourceHash,
      number: number.toString(),
    };
    ticketText = `${JSON.stringify(ticket)}\n`;
    const temporary = join(claimPath, preparingFile);
    const file = await open(temporary, "wx", 0o600);
    try {
      ticketIdentity = await file.stat();
      await file.writeFile(ticketText);
    } finally {
      await file.close();
    }
    // link publishes complete bytes exclusively; neither readers nor reapers see
    // a partially written ticket or a reusable shared ownership pathname.
    await link(temporary, join(claimPath, ticketFile));
    await unlink(temporary);
    while (true) {
      const current = await claims(lockPath, directory, resourceHash, hostHash);
      if (!current.some((peer) => peer.name === name && peer.number === number)) {
        stateFailure(
          claimPath,
          "This invocation's lock claim disappeared or changed before acquisition.",
        );
      }
      const blockers = current.filter(
        (peer) =>
          peer.name !== name &&
          (peer.hostHash !== hostHash ||
            peer.number === undefined ||
            peer.number < number ||
            (peer.number === number && peer.name < name)),
      );
      if (!blockers.length) break;
      const remaining = timeout - (performance.now() - started);
      if (remaining <= 0) {
        fail(
          "E_LOCK_BUSY",
          "Another invocation still owns or is choosing this resource lock.",
          {
            path: lockPath,
            detail: blockers.map(
              (peer) =>
                `PID ${peer.pid}, ${peer.hostHash === hostHash ? "local host" : "foreign host"}, claim ${peer.id}`,
            ),
            fix: "Retry after the owner finishes. Age never permits stealing a live or foreign-host claim.",
          },
          ExitCode.LOCK_BUSY,
        );
      }
      await delay(Math.min(25, remaining));
    }
    inAction = true;
    return await action();
  } catch (error) {
    if (inAction) throw error;
    return ioFailure(error, lockPath);
  } finally {
    if (claim) {
      try {
        await removeClaim(claim, ticketText, ticketIdentity ?? null);
      } catch (error) {
        ioFailure(error, claim.path);
      }
    }
  }
}
