import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

/**
 * Which machine wrote a receipt, journal or lock claim.
 *
 * `os.hostname()` is that answer on Linux, where the hostname is configured
 * state. On macOS it is not: with no `scutil --get HostName` set (the default),
 * `gethostname()` reports whatever name DHCP or Bonjour handed out last, and it
 * changes on its own. On one Mac it went from `Mac.attlocal.net` to
 * `HelloSub.local` between two runs, a few minutes apart, and every profile
 * receipt written under the first name was refused as "another host's"
 * (E_RECEIPT_INVALID). A lock claim left behind under the old name would be
 * a "foreign host" claim that can never be reaped.
 *
 * macOS therefore names the machine by its hardware UUID (IOPlatformUUID),
 * which survives renames, DHCP and Bonjour conflict renaming, and does not
 * survive a move to a different Mac, which is the case receipts must refuse.
 * When the UUID cannot be read, the hostname is used, as before.
 */
export interface HostIdentitySources {
  readonly platform: string;
  readonly hostname: () => string;
  readonly platformUuid: () => string | null;
}

const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/iu;

/** IOPlatformUUID from `ioreg`, or null. Never throws. */
export function readDarwinPlatformUuid(): string | null {
  try {
    const out = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const value = /"IOPlatformUUID"\s*=\s*"([^"]+)"/u.exec(out)?.[1];
    return value !== undefined && UUID.test(value) ? value.toUpperCase() : null;
  } catch {
    return null;
  }
}

/** The identity for `sources`; pure, so every platform branch is testable anywhere. */
export function resolveHostIdentity(sources: HostIdentitySources): string {
  if (sources.platform === "darwin") {
    const uuid = sources.platformUuid();
    if (uuid !== null && UUID.test(uuid)) return `darwin:${uuid.toUpperCase()}`;
  }
  return sources.hostname();
}

let cached: string | undefined;

/** This machine's stable identity (cached for the process). Linux: `os.hostname()`. */
export function hostIdentity(): string {
  cached ??= resolveHostIdentity({
    platform: process.platform,
    hostname,
    platformUuid: readDarwinPlatformUuid,
  });
  return cached;
}

/**
 * Every value a record written on THIS machine may carry: the stable identity,
 * and the bare hostname earlier releases wrote. Accepting the hostname keeps a
 * receipt written before the change valid exactly when it was valid before
 * (the hostname still matches); it never accepts another machine's record that
 * the old check would have refused.
 */
export function localHostIdentities(): readonly string[] {
  const legacy = hostname();
  const current = hostIdentity();
  return current === legacy ? [current] : [current, legacy];
}
