import { execFileSync } from "node:child_process";
import { chmod, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "dist");

// Python distributions still share dist/ during the migration, so only Node build products
// (.js / .d.ts) are ever replaced. The build is staged outside dist/ and published file by file
// with rename(), so a concurrent reader (another agent's test run, the installed registry CLI)
// never sees an empty or half-cleaned dist/. Two builds in one checkout are serialized by a
// lock directory instead of deleting each other's output.
const stage = join(root, `.build-stage-${process.pid}`);
const lock = join(root, ".build.lock");

async function acquire() {
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    try {
      await mkdir(lock);
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const age = Date.now() - (await stat(lock)).mtimeMs;
        if (age > 10 * 60_000) await rm(lock, { recursive: true, force: true });
      } catch {
        // lock vanished between checks; retry
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${lock}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

const isBuildProduct = (name) => /\.(?:js|d\.ts)$/.test(name);

async function walk(base) {
  const found = [];
  for (const entry of await readdir(base, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && isBuildProduct(entry.name)) {
      found.push(relative(base, join(entry.parentPath, entry.name)));
    }
  }
  return found;
}

await acquire();
try {
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  await mkdir(output, { recursive: true });

  execFileSync(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--project",
      "tsconfig.build.json",
      "--outDir",
      stage,
    ],
    { cwd: root, stdio: "inherit" },
  );

  await build({
    absWorkingDir: root,
    entryPoints: { cli: "src/cli.ts", index: "src/index.ts" },
    outdir: stage,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    target: "node24",
    legalComments: "none",
    logLevel: "warning",
  });
  await chmod(join(stage, "cli.js"), 0o755);

  const fresh = await walk(stage);
  for (const file of fresh) {
    await mkdir(dirname(join(output, file)), { recursive: true });
    await rename(join(stage, file), join(output, file));
  }
  const keep = new Set(fresh);
  for (const file of await walk(output)) {
    if (!keep.has(file)) await rm(join(output, file));
  }
} finally {
  await rm(stage, { recursive: true, force: true });
  await rm(lock, { recursive: true, force: true });
}
