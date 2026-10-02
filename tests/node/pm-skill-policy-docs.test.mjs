import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";

it("documents persistent Skillex-only PM ownership and a safe cutover", () => {
  const adr = readFileSync("docs/architecture/ADR-0001-reference-only-skill-topology.md", "utf8");
  const profiles = readFileSync("docs/implementation/cli-profiles.md", "utf8");
  assert.match(adr, /mandatory \*\*Skillex-only\*\*/);
  assert.match(profiles, /--skillex-only/);
  assert.match(profiles, /\.skillex-only/);
  assert.match(profiles, /external_dirs/);
  assert.match(profiles, /quarantine/i);
  assert.match(profiles, /existing.*(?:database|runtime state)/i);
});
