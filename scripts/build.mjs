import { execFileSync } from "node:child_process";
import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "dist");

// Python distributions still share dist/ during the migration. Clean only Node
// build products; packaging's allowlist also excludes wheels and source archives.
await mkdir(output, { recursive: true });
for (const entry of await readdir(output, { withFileTypes: true, recursive: true })) {
  if (entry.isFile() && /\.(?:js|d\.ts)$/.test(entry.name)) {
    await rm(join(entry.parentPath, entry.name));
  }
}

execFileSync(
  process.execPath,
  [join(root, "node_modules/typescript/bin/tsc"), "--project", "tsconfig.build.json"],
  { cwd: root, stdio: "inherit" },
);

await build({
  absWorkingDir: root,
  entryPoints: { cli: "src/cli.ts", index: "src/index.ts" },
  outdir: output,
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node24",
  legalComments: "none",
  logLevel: "warning",
});
await chmod(join(output, "cli.js"), 0o755);
