import { execFile } from "node:child_process";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import type {
  ConfiguredLegacyWriter,
  DoctorOptions,
  DoctorWriterInspection,
} from "./doctor-types.js";
import { type Diagnostic, ExitCode } from "./result.js";
import type { RegistrySelection } from "./selection.js";

const timeoutMs = 2_000;
const maxProcessBytes = 2_000_000;
const maxConfigBytes = 1_000_000;
const python = /^(?:python(?:\d+(?:\.\d+)*)?|pypy\d*)$/;
const shells = new Set(["sh", "bash", "zsh", "dash"]);
const writers = new Set(["sync-skills.py", "provision-packs.py"]);

/** Tokenize only for conservative entrypoint recognition; never evaluate shell text. */
function words(command: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
    } else if (char === "'" || char === '"') quote = char;
    else if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
    } else current += char;
  }
  if (quote || escaped) return undefined;
  if (current) tokens.push(current);
  return tokens;
}

function script(entry: string, args: readonly string[]): string | undefined {
  if (args.some((arg) => ["--help", "-h", "--version", "--dry-run"].includes(arg)))
    return undefined;
  const name = basename(entry);
  if (writers.has(name) || name === "skill-ssot-daemon.sh") return entry;
  if (name === "skill_ssot.py" && ["sweep", "rescue", "backfill"].includes(args[0] ?? ""))
    return entry;
  return undefined;
}

function pythonCli(args: readonly string[]): boolean {
  if (args.some((arg) => ["--help", "-h", "--version", "--dry-run"].includes(arg))) return false;
  return (
    args[0] === "sync" ||
    (args[0] === "pack" && ["activate", "deactivate"].includes(args[1] ?? "")) ||
    (args[0] === "vendor" && args[1] === "sync")
  );
}

function entrypoint(tokens: readonly string[], depth = 0): string | undefined {
  if (depth > 3 || !tokens[0]) return undefined;
  const executable = basename(tokens[0]);
  const args = tokens.slice(1);
  if (
    (python.test(executable) || executable === "uv") &&
    args.some((arg) => ["--help", "-h", "--version", "-V", "-VV"].includes(arg))
  )
    return undefined;
  const direct = script(tokens[0], args);
  if (direct) return direct;
  if (python.test(executable)) {
    let index = 0;
    for (; index < args.length; index++) {
      const arg = args[index];
      if (!arg) return undefined;
      if (arg === "-c" || arg.startsWith("-c")) return undefined;
      if (arg === "-m") {
        if (args[index + 1] === "skillex" && pythonCli(args.slice(index + 2)))
          return `${tokens[0]} -m skillex`;
        if (args[index + 1] === "uv")
          return entrypoint(["uv", ...args.slice(index + 2)], depth + 1);
        return undefined;
      }
      if (["-W", "-X"].includes(arg)) {
        index++;
        continue;
      }
      if (arg === "--") {
        index++;
        break;
      }
      if (!arg.startsWith("-")) break;
    }
    const path = args[index];
    if (path && basename(path) === "skillex" && pythonCli(args.slice(index + 1))) return path;
    return path ? script(path, args.slice(index + 1)) : undefined;
  }
  if (executable === "uv" && args[0] === "run") {
    let index = 1;
    const valued = new Set([
      "--directory",
      "--project",
      "--python",
      "--package",
      "--group",
      "--with",
      "--with-editable",
      "--with-requirements",
      "--env-file",
    ]);
    while (args[index]?.startsWith("-")) {
      if (args[index] === "--") {
        index++;
        break;
      }
      if (valued.has(args[index] ?? "")) index++;
      index++;
    }
    const command = args[index];
    if (command && basename(command) === "skillex" && pythonCli(args.slice(index + 1)))
      return `${tokens[0]} run ${command}`;
    return entrypoint(args.slice(index), depth + 1);
  }
  // An actual script argument is evidence. Quoted -c shell programs are not.
  if (shells.has(executable) && args[0] && !args[0].startsWith("-"))
    return script(args[0], args.slice(1));
  return undefined;
}

function commandEntrypoint(command: string): string | undefined {
  const tokens = words(command);
  return tokens ? entrypoint(tokens) : undefined;
}

function commandStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(commandStrings);
  return [];
}

function miseCommands(raw: Record<string, unknown>): string[] {
  const commands: string[] = [];
  if (raw.tasks && typeof raw.tasks === "object" && !Array.isArray(raw.tasks)) {
    for (const task of Object.values(raw.tasks)) {
      if (typeof task === "string") commands.push(task);
      else if (task && typeof task === "object" && !Array.isArray(task) && "run" in task)
        commands.push(...commandStrings(task.run));
    }
  }
  const hooks = (value: unknown): void => {
    if (typeof value === "string" || Array.isArray(value)) {
      if (Array.isArray(value)) for (const item of value) hooks(item);
      else commands.push(value);
    } else if (value && typeof value === "object") {
      if ("script" in value) commands.push(...commandStrings(value.script));
      else for (const child of Object.values(value)) hooks(child);
    }
  };
  hooks(raw.hooks);
  return commands;
}

function configuredStatements(command: string): string[] {
  // Multiline task bodies are common. Do not interpret substitutions or shell
  // expressions; a direct writer invocation on its own line is enough evidence.
  return command
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function candidateCommand(command: string): boolean {
  const tokens = words(command);
  const executable = basename(tokens?.[0] ?? "");
  if (["echo", "printf", "cat", "grep", "rg"].includes(executable)) return false;
  if (python.test(executable) && tokens?.some((word) => word === "-c" || word.startsWith("-c")))
    return false;
  if (tokens?.some((word) => ["--help", "-h", "--version", "-V", "-VV"].includes(word)))
    return false;
  const reference =
    /(?:^|[\s/])(?:sync-skills\.py|provision-packs\.py|skill_ssot\.py|skill-ssot-daemon\.sh)(?=$|[\s'";&|])/.test(
      command,
    );
  return (
    reference &&
    /(?:&&|\|\||[;|]|(?:^|\s)(?:exec|env|sudo|timeout|nohup)\s|(?:^|\s)(?:sh|bash|zsh|dash)\s+-c\s)/.test(
      command,
    )
  );
}

export async function inspectDoctorWriters(
  options: DoctorOptions,
  registries: readonly RegistrySelection[],
  scopes: readonly { readonly scope: string; readonly root: string }[],
): Promise<{ data: DoctorWriterInspection; findings: Diagnostic[]; exits: ExitCode[] }> {
  const findings: Diagnostic[] = [];
  const exits: ExitCode[] = [];
  const configured: ConfiguredLegacyWriter[] = [];
  const running: { pid: number; command: string; entrypoint: string }[] = [];
  const env = options.env ?? process.env;
  const home = resolve(options.home ?? homedir());
  const configHome = resolve(home, env.XDG_CONFIG_HOME ?? ".config");
  const roots = new Set<string>();
  const ancestors = (path: string) => {
    let current = resolve(path);
    while (true) {
      roots.add(current);
      const parent = dirname(current);
      if (current === home || parent === current) break;
      current = parent;
    }
  };
  const global =
    scopes.some((scope) => scope.scope === "global") ||
    options.scope === "global" ||
    scopes.length === 0;
  if (global) {
    roots.add(home);
    roots.add(join(home, ".agents"));
    for (const registry of registries) ancestors(registry.root);
  }
  for (const scope of scopes) if (scope.scope === "project") ancestors(scope.root);
  if (!scopes.length && options.scope !== "global")
    ancestors(options.project ?? options.cwd ?? process.cwd());
  const candidates = new Map<string, "mise" | "service">();
  for (const root of roots)
    for (const file of ["mise.toml", "mise.local.toml", ".mise.toml"])
      candidates.set(join(root, file), "mise");
  candidates.set(join(configHome, "mise", "config.toml"), "mise");
  const unavailable = (path: string, message: string) => {
    findings.push({
      code: "W_WRITER_CONFIG_UNREADABLE",
      severity: "warning",
      path,
      message,
      fix: "Restore readable configuration and rerun doctor; writer configuration is not fully observed.",
    });
    exits.push(ExitCode.PARTIAL);
  };
  const observeConfigured = (
    kind: "mise" | "service",
    path: string,
    line: number,
    command: string,
  ) => {
    if (commandEntrypoint(command)) configured.push({ kind, path, line, command });
    else if (candidateCommand(command)) {
      findings.push({
        code: "W_LEGACY_WRITER_CANDIDATE",
        severity: "warning",
        path,
        message:
          "A configured shell command references a legacy writer, but its invocation is unresolved.",
        detail: [`line ${line}: ${command}`],
        fix: "Inspect the wrapper command during consumer migration; this candidate does not prove a configured or running writer.",
      });
      exits.push(ExitCode.PARTIAL);
    }
  };
  const serviceRoot = join(configHome, "systemd", "user");
  try {
    for (const entry of await readdir(serviceRoot, { withFileTypes: true })) {
      const path = join(serviceRoot, entry.name);
      if (entry.name.endsWith(".service")) candidates.set(path, "service");
      else if (entry.isDirectory() && entry.name.endsWith(".service.d")) {
        try {
          for (const file of await readdir(path))
            if (file.endsWith(".conf")) candidates.set(join(path, file), "service");
        } catch {
          unavailable(path, "Cannot inspect user service overrides.");
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      unavailable(serviceRoot, "Cannot inspect user service definitions.");
  }
  for (const [path, kind] of [...candidates].sort(([a], [b]) => a.localeCompare(b))) {
    try {
      const info = await stat(path);
      // A systemd unit or drop-in masked with /dev/null cannot configure a writer.
      if (kind === "service" && info.isCharacterDevice() && (await realpath(path)) === "/dev/null")
        continue;
      if (!info.isFile() || info.size > maxConfigBytes) {
        unavailable(path, "Writer configuration is not a bounded regular file.");
        continue;
      }
      const content = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
      const lines = content.split(/\r?\n/);
      if (kind === "service") {
        for (const [index, line] of lines.entries()) {
          const match = /^\s*Exec(?:Start|Stop|Reload)(?:Pre|Post)?\s*=\s*([-+!:@]*)(.*)$/.exec(
            line,
          );
          const command = match?.[2];
          if (command) observeConfigured(kind, path, index + 1, command);
        }
      } else {
        for (const command of miseCommands(parseToml(content))) {
          for (const statement of configuredStatements(command)) {
            const index = lines.findIndex(
              (line) =>
                !line.trimStart().startsWith("#") &&
                !/^\s*(?:description|desc)\s*=/.test(line) &&
                line.includes(statement),
            );
            if (index !== -1) observeConfigured(kind, path, index + 1, statement);
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        unavailable(path, "Cannot read or parse writer configuration.");
    }
  }
  const unique = [
    ...new Map(
      configured.map((entry) => [`${entry.path}\0${entry.line}\0${entry.command}`, entry]),
    ).values(),
  ];
  for (const entry of unique) {
    findings.push({
      code: "W_LEGACY_WRITER_CONFIGURED",
      severity: "warning",
      path: entry.path,
      message: "A legacy writer command is configured; this does not establish that it is running.",
      detail: [`line ${entry.line}: ${entry.command}`],
      fix: "Replace the task or service command during explicit consumer migration.",
    });
    exits.push(ExitCode.DRIFT);
  }
  let processObservation: "complete" | "unknown" = "complete";
  try {
    const snapshot = await boundedSnapshot(options, env);
    if (typeof snapshot !== "string" || Buffer.byteLength(snapshot) > maxProcessBytes)
      throw new Error("process observation exceeds its limit");
    for (const line of snapshot.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      if (
        !match?.[1] ||
        !match[2] ||
        !Number.isSafeInteger(Number(match[1])) ||
        Number(match[1]) < 1
      )
        throw new Error("invalid process observation");
      const writer = commandEntrypoint(match[2]);
      if (writer) running.push({ pid: Number(match[1]), command: match[2], entrypoint: writer });
    }
  } catch {
    processObservation = "unknown";
    findings.push({
      code: "W_PROCESS_OBSERVATION_UNKNOWN",
      severity: "warning",
      message: "Running legacy writers could not be fully observed.",
      fix: "Make ps -axo pid=,args= available and retry; configured commands do not prove process activity.",
    });
    exits.push(ExitCode.PARTIAL);
  }
  for (const entry of running) {
    findings.push({
      code: "W_LEGACY_WRITER_RUNNING",
      severity: "warning",
      message: "A running process has a legacy writer entrypoint.",
      detail: [`pid ${entry.pid}`, entry.command],
      fix: "Finish or stop that writer explicitly before migrating its consumer to the Node CLI.",
    });
    exits.push(ExitCode.DRIFT);
  }
  return { data: { configured: unique, running, processObservation }, findings, exits };
}

async function boundedSnapshot(
  options: DoctorOptions,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  const observation = options.processSnapshot
    ? options.processSnapshot()
    : new Promise<string>((accept, reject) => {
        execFile(
          "ps",
          ["-axo", "pid=,args="],
          { env, timeout: timeoutMs, maxBuffer: maxProcessBytes, encoding: "utf8" },
          (error, stdout) => {
            if (error) reject(error);
            else accept(stdout);
          },
        );
      });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      observation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("process observation timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
