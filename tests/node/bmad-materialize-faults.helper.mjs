/**
 * Shared fault-injection helper for SKRILL-27 writer-hold regressions.
 *
 * The built CLI's ESM `node:fs/promises` imports are interceptable from a CJS
 * `--require` preload (verified by the independent reviewer and re-verified
 * here). Each helper writes a small preload under the fixture root and returns
 * the `NODE_OPTIONS` env fragment. The CLI under test runs as a real spawned
 * process against the built `dist/cli.js`, exactly like the repo's own
 * materializer tests.
 */

/** Fail the Nth open() call (1-indexed) with EIO. */
export function failAtOpenPreload(dir, n, excludedRoots = []) {
  return {
    NODE_OPTIONS: `--require ${preload(
      dir,
      `fail-open-${n}.cjs`,
      `
let count = 0;
const orig = require("fs").promises.open;
const excluded = ${JSON.stringify(excludedRoots)};
require("fs").promises.open = async function (path, flags, mode) {
  if (typeof path === "string" && excluded.some((root) => path.startsWith(root)))
    return orig.call(this, path, flags, mode);
  count += 1;
  if (count === ${n}) {
    const err = new Error("injected EIO at open");
    err.code = "EIO";
    throw err;
  }
  return orig.call(this, path, flags, mode);
};
`,
    )}`,
  };
}

/**
/** Plant foreign content (creating parents) when open() is called with a path
 *  ending in `triggerSuffix`. */
export function plantForeignOnOpenPathPreload(dir, triggerSuffix, victimPath, foreignBytes) {
  return {
    NODE_OPTIONS: `--require ${preload(
      dir,
      `plant-path-${Math.abs(hashCode(triggerSuffix))}.cjs`,
      `
const fs = require("fs");
const orig = fs.promises.open;
fs.promises.open = async function (path, flags, mode) {
  if (typeof path === "string" && path.endsWith(${JSON.stringify(triggerSuffix)})) {
    fs.mkdirSync(require("path").dirname(${JSON.stringify(victimPath)}), { recursive: true });
    fs.writeFileSync(${JSON.stringify(victimPath)}, ${JSON.stringify(foreignBytes)});
  }
  return orig.call(this, path, flags, mode);
};
`,
    )}`,
  };
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/** Rename `fromPath` to `toPath` synchronously the first time open() is called
 *  with a path NOT under `excludedRoots` (an apply-stage publication open). Used
 *  to prove the pending journal binds the ACTUAL published inode: the renamed-away
 *  original keeps its inode alive (no inode reuse), so a later byte-identical
 *  foreign replacement lands on a FRESH inode that must NOT be auto-owned. */
export function renameFirstOpenPreload(dir, excludedRoots, fromPath, toPath) {
  return {
    NODE_OPTIONS: `--require ${preload(
      dir,
      `rename-open-${Math.abs(hashCode(fromPath + toPath))}.cjs`,
      `
let done = false;
const fs = require("fs");
const orig = fs.promises.open;
const excluded = ${JSON.stringify(excludedRoots)};
fs.promises.open = async function (path, flags, mode) {
  if (!done && typeof path === "string" && !excluded.some((root) => path.startsWith(root))) {
    done = true;
    fs.renameSync(${JSON.stringify(fromPath)}, ${JSON.stringify(toPath)});
  }
  return orig.call(this, path, flags, mode);
};
`,
    )}`,
  };
}

/** Tamper `sourcePath` bytes on the Nth open() call whose path is NOT under
 *  `excludedRoots` (e.g. the runtime source tree and state home: opens there
 *  belong to verification/locking, not publication). */
export function tamperSourceAtOpenPreload(dir, n, excludedRoots, sourcePath, tamperedBytes) {
  return {
    NODE_OPTIONS: `--require ${preload(
      dir,
      `tamper-open-${n}.cjs`,
      `
let count = 0;
const fs = require("fs");
const orig = fs.promises.open;
const excluded = ${JSON.stringify(excludedRoots)};
fs.promises.open = async function (path, flags, mode) {
  if (typeof path === "string" && excluded.some((root) => path.startsWith(root)))
    return orig.call(this, path, flags, mode);
  count += 1;
  if (count === ${n}) fs.writeFileSync(${JSON.stringify(sourcePath)}, ${JSON.stringify(tamperedBytes)});
  return orig.call(this, path, flags, mode);
};
`,
    )}`,
  };
}

import { writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";

/** Write a preload under the fixture root and return its path for NODE_OPTIONS. */
function preload(dir, name, body) {
  const path = joinPath(dir, name);
  writeFileSync(path, body);
  return path;
}
