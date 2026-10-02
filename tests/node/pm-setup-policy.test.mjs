import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";

it("PM setup opts out of bundled skills and never resets runtime state", () => {
  const script = readFileSync("agents/hermes/pm/.scripts/10-hermes-profile.sh", "utf8");
  assert.match(script, /profile create.*--no-skills/);
  assert.match(script, /--skillex-only/);
  assert.doesNotMatch(script, /rm -[fr]+.*PROFILE_HOME|\bstate\.db\b/);
  assert.doesNotMatch(script, /npm:@delorenj\/skillex@0\.1\.1/);
  assert.match(script, /--dry-run/);
  assert.match(script, /profile show/);
});
