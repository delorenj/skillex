import { execFileSync } from "node:child_process";
import { dirname } from "node:path";

/**
 * Which volume an owned entry lives on.
 *
 * `st_dev` is a boot-time device number, not a durable identity. On macOS the
 * Data volume went 16777233 -> 16777234 across one restart and every receipt
 * that recorded `dev` was refused as "ownership changed" (2026-11-14); on Linux
 * a re-enumerated disk or a different mount order does the same. The volume UUID
 * (APFS volume UUID, or the filesystem UUID) survives that, so receipts record
 * it next to `ino` and the comparison trusts the UUID over the device number.
 *
 * Lookups shell out (`diskutil`, `findmnt`, `blkid`), so they are cached per
 * device number for the life of the process: a device number maps to exactly one
 * mount while the process runs. Any failure resolves to `undefined` (cached),
 * and callers then fall back to comparing the raw device number.
 */
export interface VolumeSources {
  readonly platform: string;
  /** Run a command and return stdout, or null on any failure. */
  readonly run: (command: string, args: readonly string[]) => string | null;
}

const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/iu;
// ext4/xfs/btrfs use UUIDs; vfat/ntfs use short serials such as `1A2B-3C4D`.
const FS_ID = /^[0-9A-Za-z][0-9A-Za-z-]{3,63}$/u;

function runCommand(command: string, args: readonly string[]): string | null {
  try {
    return execFileSync(command, [...args], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function darwin(path: string, run: VolumeSources["run"]): string | undefined {
  // `diskutil info` takes a device node or a mount point, not an arbitrary path
  // ("Could not find disk"), so ask `df` which volume holds the path first.
  const df = run("/bin/df", ["-P", path]);
  const device = df?.split("\n")[1]?.split(/\s+/u)[0];
  if (!device?.startsWith("/dev/")) return undefined;
  const plist = run("/usr/sbin/diskutil", ["info", "-plist", device]);
  const value = /<key>VolumeUUID<\/key>\s*<string>([^<]+)<\/string>/u.exec(plist ?? "")?.[1];
  return value !== undefined && UUID.test(value) ? value.toUpperCase() : undefined;
}

function linux(path: string, run: VolumeSources["run"]): string | undefined {
  const direct = run("findmnt", ["-no", "UUID", "-T", path])?.trim();
  if (direct && FS_ID.test(direct)) return direct.toLowerCase();
  const source = run("findmnt", ["-no", "SOURCE", "-T", path])?.trim();
  if (!source?.startsWith("/dev/")) return undefined;
  const blk = run("blkid", ["-s", "UUID", "-o", "value", source])?.trim();
  return blk && FS_ID.test(blk) ? blk.toLowerCase() : undefined;
}

/** The volume id for `path`, or undefined when the platform cannot say. Pure given `sources`. */
export function resolveVolumeUuid(path: string, sources: VolumeSources): string | undefined {
  if (sources.platform === "darwin") return darwin(path, sources.run);
  if (sources.platform === "linux") return linux(path, sources.run);
  return undefined;
}

const cache = new Map<string, string | undefined>();
let override: ((path: string, dev: string) => string | undefined) | undefined;

/** Test seam: replace the lookup (pass undefined to restore) and drop the cache. */
export function setVolumeResolver(
  resolver: ((path: string, dev: string) => string | undefined) | undefined,
): void {
  override = resolver;
  cache.clear();
}

/**
 * Volume id of the object at `path` whose `st_dev` is `dev`. A symbolic link is
 * looked up through its parent directory: the link lives on its parent's volume,
 * and `diskutil`/`findmnt` would otherwise follow it to the target's volume.
 */
export function volumeUuid(path: string, dev: bigint, isLink: boolean): string | undefined {
  const key = String(dev);
  if (cache.has(key)) return cache.get(key);
  const lookup = isLink ? dirname(path) : path;
  const found = override
    ? override(lookup, key)
    : resolveVolumeUuid(lookup, { platform: process.platform, run: runCommand });
  cache.set(key, found);
  return found;
}
