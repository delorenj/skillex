#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { ExitCode, makeResult, type ResultEnvelope, VERSION } from "./index.js";

const args = process.argv.slice(2);
const terminator = args.indexOf("--");
const flags = terminator === -1 ? args : args.slice(0, terminator);
// Commander may stop parsing at help/version or an error before seeing --json.
// Recognize this output flag first so either flag order has the same contract.
const jsonOutput = flags.includes("--json");
let output = "";

const program = new Command()
  .name("skillex")
  .description("Manage the canonical skill catalog and agent activation roots.")
  .version(VERSION, "-V, --version", "Show the installed package version.")
  .option("--json", "Emit a structured result on stdout.")
  .allowExcessArguments(false)
  .configureOutput({
    writeOut: (text) => {
      output += text;
    },
    writeErr: () => {},
  })
  .exitOverride();

function emit(result: ResultEnvelope<unknown>, text = ""): void {
  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (result.ok) {
    process.stdout.write(text);
  } else {
    for (const finding of result.findings) {
      process.stderr.write(`${finding.code}: ${finding.message}\n`);
      if (finding.fix) process.stderr.write(`  ${finding.fix}\n`);
    }
  }
  process.exitCode = result.exit;
}

try {
  if (Number(process.versions.node.split(".")[0]) < 24) {
    emit(
      makeResult("cli", null, {
        exit: ExitCode.CONFIG,
        findings: [
          {
            code: "E_NODE_VERSION",
            severity: "error",
            message: `Node 24 or newer is required; running ${process.versions.node}.`,
            fix: "Run skillex with Node 24 or newer.",
          },
        ],
      }),
    );
  } else {
    program.parse(args, { from: "user" });
    const help = program.helpInformation();
    emit(makeResult("help", { help }), help);
  }
} catch (error) {
  if (error instanceof CommanderError && error.code === "commander.version") {
    emit(makeResult("version", { version: VERSION }), output);
  } else if (error instanceof CommanderError && error.code === "commander.helpDisplayed") {
    emit(makeResult("help", { help: output }), output);
  } else {
    const usage = error instanceof CommanderError;
    emit(
      makeResult("cli", null, {
        exit: usage ? ExitCode.CONFIG : ExitCode.FAILURE,
        findings: [
          {
            code: usage ? "E_USAGE" : "E_RUNTIME",
            severity: "error",
            message: error instanceof Error ? error.message.replace(/^error: /, "") : String(error),
            fix: usage
              ? "Run skillex --help for available arguments."
              : "Report the failing command.",
          },
        ],
      }),
    );
  }
}
