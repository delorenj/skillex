import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

let usageSpec;

const cli = new URL("../../dist/cli.js", import.meta.url);
function run(args) {
  const result = spawnSync(process.execPath, [cli.pathname, ...args], {
    encoding: "utf8",
    cwd: process.env.TMPDIR,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
// The usage CLI on PATH (CI installs the release binary), else through mise (this host).
const direct = spawnSync("usage", ["--version"], { encoding: "utf8" }).status === 0;
function usageCli(args, input) {
  const [command, argv] = direct ? ["usage", args] : ["mise", ["exec", "--", "usage", ...args]];
  const result = spawnSync(command, argv, { input, encoding: "utf8" });
  assert.equal(result.error, undefined, `usage CLI not runnable: ${result.error?.message}`);
  return result;
}
function parse(kdl) {
  const lint = usageCli(["lint", "-"], kdl);
  assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  const result = usageCli(["generate", "json", "-f", "-"], kdl);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function parity(program, node) {
  assert.deepEqual(
    Object.keys(node.subcommands).sort(),
    program.commands.map((cmd) => cmd.name()).sort(),
  );
  const options = program.options;
  assert.deepEqual(
    node.flags.map((flag) => flag.name).sort(),
    options.map((opt) => (opt.long ?? opt.short).replace(/^-+/, "")).sort(),
  );
  assert.deepEqual(
    node.args.map((arg) => arg.name),
    program.registeredArguments.map((arg) => arg.name()),
  );
  for (const cmd of program.commands) parity(cmd, node.subcommands[cmd.name()]);
}
test("usage KDL matches every real Commander registration and catches omitted commands/options", async () => {
  const argv = process.argv;
  const write = process.stdout.write;
  let program;
  try {
    process.argv = [process.execPath, cli.pathname, "--usage-spec"];
    process.stdout.write = () => true;
    ({ program, usageSpec } = await import(cli.href));
  } finally {
    process.argv = argv;
    process.stdout.write = write;
  }
  const spec = parse(run(["--usage-spec"]));
  assert.equal(spec.bin, "skillex");
  parity(program, spec.cmd);
  const missingCommand = structuredClone(spec);
  delete missingCommand.cmd.subcommands.skill;
  assert.throws(() => parity(program, missingCommand.cmd));
  const missingOption = structuredClone(spec);
  missingOption.cmd.flags.pop();
  assert.throws(() => parity(program, missingOption.cmd));
  program.command("drift-sentinel").option("--sentinel <value>");
  const mutated = parse(usageSpec(program));
  assert.ok(mutated.cmd.subcommands["drift-sentinel"]);
});
test("description bypasses JSON envelope and respects the option terminator", () => {
  assert.equal(run(["--json", "--usage-spec"]), run(["--usage-spec"]));
  const result = spawnSync(process.execPath, [cli.pathname, "--", "--usage-spec"], {
    encoding: "utf8",
  });
  assert.notEqual(result.stdout, run(["--usage-spec"]));
});
