import { convertRoot, renderKDL } from "@usage-spec/commander";
import type { Command } from "commander";

// Upstream drops every option named version/help, including local pack versions.
// Restore those registered options through its standard usage model.
export function usageSpec(program: Command): string {
  const spec = convertRoot(program);
  function restore(command: Command, node: typeof spec): void {
    for (const option of command.options.filter((item) =>
      ["version", "help"].includes(item.name()),
    )) {
      node.flags.push({
        short: option.short?.replace(/^-/, "") ?? "",
        long: option.long?.replace(/^--/, "") ?? "",
        help: option.description,
        helpLong: "",
        required: option.mandatory,
        hide: option.hidden,
        global: false,
        count: false,
        var: option.variadic,
        negate: "",
        deprecated: "",
        default: [],
        defaultBool: null,
        env: "",
        arg:
          option.required || option.optional
            ? {
                name: option.name().toUpperCase(),
                required: option.required,
                var: option.variadic,
                help: "",
                hide: false,
                default: [],
                choices: null,
              }
            : null,
      } as (typeof node.flags)[number]);
    }
    for (const child of command.commands) {
      const target = node.cmds.find((item) => item.name === child.name());
      if (target) restore(child, target as unknown as typeof spec);
    }
  }
  restore(program, spec);
  return renderKDL(spec);
}
