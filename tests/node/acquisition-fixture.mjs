import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

// The acquisition surface is wired into the public CLI by the coordinator;
// until then, tests bundle the new modules directly. The bundle lives in a
// temp tree with a package self-link so the manifest schema's
// import.meta.resolve("@delorenj/skillex/schemas/...") keeps resolving.
const cliReplica = `
import { Command, CommanderError } from "commander";
import { registerAcquisitionCommands } from {REGISTER};

const args = process.argv.slice(2);
const terminator = args.indexOf("--");
const flags = terminator === -1 ? args : args.slice(0, terminator);
const jsonOutput = flags.includes("--json");
let output = "";
let handled = false;

const program = new Command()
  .name("skillex")
  .description("Acquisition test fixture.")
  .version("0.0.0-fixture", "-V, --version", "Show the version.")
  .option("--json", "Emit a structured result on stdout.")
  .option("--registry-root <path>", "Use this local registry checkout.")
  .enablePositionalOptions()
  .allowExcessArguments(false)
  .configureOutput({
    writeOut: (text) => {
      output += text;
    },
    writeErr: () => {},
  })
  .exitOverride()
  .action(() => {
    handled = true;
    const text = program.helpInformation();
    if (jsonOutput)
      process.stdout.write(
        JSON.stringify({ schema: 2, command: "help", ok: true, exit: 0, data: { help: text }, findings: [] }) +
          "\\n",
      );
    else process.stdout.write(text);
  });

function emit(result, text = "") {
  handled = true;
  if (jsonOutput) {
    process.stdout.write(JSON.stringify(result) + "\\n");
  } else {
    if (text) process.stdout.write(text);
    for (const finding of result.findings) {
      process.stderr.write(finding.code + ": " + finding.message + "\\n");
      if (finding.fix) process.stderr.write("  " + finding.fix + "\\n");
    }
  }
  process.exitCode = result.exit;
}

registerAcquisitionCommands(program, { emit });

function registerSharedOptions(parent) {
  for (const command of parent.commands) {
    command
      .enablePositionalOptions()
      .option("--json", "Emit a structured result on stdout.")
      .option("--registry-root <path>", "Use this local registry checkout.");
    registerSharedOptions(command);
  }
}
registerSharedOptions(program);

function parseSharedOptions() {
  const shared = new Command()
    .option("--json")
    .option("--registry-root <path>")
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .exitOverride();
  const parsed = shared.parseOptions(flags);
  const { registryRoot } = shared.opts();
  if (registryRoot !== undefined) program.setOptionValue("registryRoot", registryRoot);
  return [
    ...parsed.operands,
    ...parsed.unknown,
    ...(terminator === -1 ? [] : args.slice(terminator)),
  ];
}

try {
  await program.parseAsync(parseSharedOptions(), { from: "user" });
  if (!handled) {
    handled = true;
    process.stdout.write(program.helpInformation());
  }
} catch (error) {
  if (
    error instanceof CommanderError &&
    (error.code === "commander.version" || error.code === "commander.helpDisplayed")
  ) {
    process.stdout.write(output);
  } else {
    const usage = error instanceof CommanderError;
    const message = (error instanceof Error ? error.message : String(error)).replace(/^error: /, "");
    const envelope = {
      schema: 2,
      command: "cli",
      ok: false,
      exit: usage ? 2 : 1,
      data: null,
      findings: [
        {
          code: usage ? "E_USAGE" : "E_RUNTIME",
          severity: "error",
          message,
          fix: usage ? "Run skillex --help for available arguments." : "Report the failing command.",
        },
      ],
    };
    if (jsonOutput) process.stdout.write(JSON.stringify(envelope) + "\\n");
    else process.stderr.write(message + "\\n");
    process.exitCode = envelope.exit;
  }
}
`;

let cached;

export async function loadAcquisitionFixture() {
  if (cached) return cached;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skillex-acquisition-fixture-")));
  try {
    const nodeModules = join(root, "node_modules");
    const scoped = join(nodeModules, "@delorenj");
    mkdirSync(scoped, { recursive: true });
    // Mirror the package build: dependencies stay external and resolve through
    // links, including the package self-link the manifest schema needs.
    symlinkSync(repositoryRoot, join(scoped, "skillex"), "dir");
    for (const dependency of ["ajv", "commander", "semver", "smol-toml", "yaml"])
      symlinkSync(
        join(repositoryRoot, "node_modules", dependency),
        join(nodeModules, dependency),
        "dir",
      );
    writeFileSync(
      join(root, "core.ts"),
      `export * from ${JSON.stringify(join(repositoryRoot, "src", "core", "skill-acquisition.ts"))};\n`,
    );
    writeFileSync(
      join(root, "cli.ts"),
      cliReplica.replace(
        "{REGISTER}",
        JSON.stringify(join(repositoryRoot, "src", "commands", "acquisition.ts")),
      ),
    );
    // version.ts reads ../package.json next to the bundle's parent directory.
    writeFileSync(join(root, "package.json"), '{"type":"module","version":"0.0.0-fixture"}\n');
    const bundle = join(root, "bundle");
    await build({
      entryPoints: [join(root, "core.ts"), join(root, "cli.ts")],
      outdir: bundle,
      bundle: true,
      packages: "external",
      platform: "node",
      format: "esm",
      target: "node24",
      logLevel: "silent",
    });
    cached = {
      root,
      core: await import(pathToFileURL(join(bundle, "core.js")).href),
      cli: join(bundle, "cli.js"),
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
    return cached;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/** Run one real git command in a fixture repository. */
export function gitAt(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
