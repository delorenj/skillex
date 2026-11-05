import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { it } from "node:test";
import {
  ExitCode,
  HUB_SIZE_LIMIT,
  lintHub,
  lintSkill,
  localTarget,
  markdownLines,
} from "@delorenj/skillex";

const FRONTMATTER = "---\nname: alpha\ndescription: Hub fixture\n---\n";

function hub(t, { name = "alpha", body = "# alpha\n", frontmatter = FRONTMATTER } = {}) {
  const root = realpathSync(mkdtempSync("/tmp/skillex-hub-lint-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const parent = join(root, "skills");
  const directory = (path) => {
    mkdirSync(path, { recursive: true });
    return path;
  };
  const file = (path, value) => {
    directory(dirname(path));
    writeFileSync(path, value);
    return path;
  };
  directory(parent);
  const hubPath = directory(join(parent, name));
  file(join(hubPath, "SKILL.md"), `${frontmatter}${body}`);
  return {
    root,
    parent,
    path: hubPath,
    directory,
    file,
    link(path, target) {
      directory(dirname(path));
      symlinkSync(target, path);
      return path;
    },
  };
}

const codes = (report) => report.findings.map((finding) => finding.code);
const has = (report, code) => codes(report).includes(code);

it("passes a well-formed hub", async (t) => {
  const f = hub(t, {
    body: "# alpha\n\nRead [the guide](references/guide.md) first.\n",
  });
  f.file(join(f.path, "references", "guide.md"), "# Guide\nMore detail.\n");
  const report = await lintHub({ path: f.path });
  assert.deepEqual(report.findings, []);
  assert.equal(report.data.lines, 7);
  assert.equal(report.data.files, 2);
  assert.equal(report.data.links, 1);
});

it("E_HUB_COUNT: exactly one hub directory with a SKILL.md per repository", async (t) => {
  const f = hub(t);
  const report = await lintHub({ path: f.path });
  assert.equal(has(report, "E_HUB_COUNT"), false);
  // A second skill-shaped directory violates the one-hub rule.
  f.file(join(f.parent, "beta", "SKILL.md"), "---\nname: beta\ndescription: Second hub\n---\n");
  const crowded = await lintHub({ path: f.path });
  const finding = crowded.findings.find((item) => item.code === "E_HUB_COUNT");
  assert.ok(finding);
  assert.deepEqual(finding.detail, ["alpha", "beta"]);
});

it("E_HUB_NAME: directory, declared and frontmatter names must be one", async (t) => {
  const f = hub(t, { frontmatter: "---\nname: renamed\ndescription: Hub fixture\n---\n" });
  const report = await lintHub({ path: f.path, declaredName: "alpha" });
  const finding = report.findings.find((item) => item.code === "E_HUB_NAME");
  assert.ok(finding, JSON.stringify(report.findings));
  assert.ok(finding.detail.some((line) => line.includes("frontmatter renamed")));
  // A declared name differing from the directory is also a divergence.
  const declared = await lintHub({ path: f.path, declaredName: "other" });
  assert.ok(declared.findings.some((item) => item.code === "E_HUB_NAME"));
  // Matching everywhere is clean.
  const clean = hub(t);
  assert.equal(
    has(await lintHub({ path: clean.path, declaredName: "alpha" }), "E_HUB_NAME"),
    false,
  );
});

it("E_HUB_FRONTMATTER: name and description must be present and within limits", async (t) => {
  const missing = hub(t, { frontmatter: "---\nname: alpha\n---\n" });
  assert.ok(has(await lintHub({ path: missing.path }), "E_HUB_FRONTMATTER"));
  const noFile = hub(t);
  rmSync(join(noFile.path, "SKILL.md"));
  assert.ok(has(await lintHub({ path: noFile.path }), "E_HUB_FRONTMATTER"));
  const longName = hub(t, {
    frontmatter: `---\nname: ${"a".repeat(65)}\ndescription: Hub fixture\n---\n`,
  });
  assert.ok(has(await lintHub({ path: longName.path }), "E_HUB_FRONTMATTER"));
  const longDescription = hub(t, {
    frontmatter: `---\nname: alpha\ndescription: ${"d".repeat(1025)}\n---\n`,
  });
  assert.ok(has(await lintHub({ path: longDescription.path }), "E_HUB_FRONTMATTER"));
  // Frontmatter-less Markdown is not a hub definition.
  const plain = hub(t, { frontmatter: "" });
  assert.ok(has(await lintHub({ path: plain.path }), "E_HUB_FRONTMATTER"));
});

it("W_HUB_SIZE: SKILL.md over the budget routes facts into references", async (t) => {
  const f = hub(t, { body: `${"# padding\n".repeat(HUB_SIZE_LIMIT + 1)}` });
  const report = await lintHub({ path: f.path });
  const finding = report.findings.find((item) => item.code === "W_HUB_SIZE");
  assert.ok(finding);
  assert.ok(finding.message.includes(String(HUB_SIZE_LIMIT)));
  // A custom budget is honored both ways (frontmatter is 4 lines).
  const small = hub(t, { body: "one\ntwo\nthree\nfour\n" });
  assert.ok(has(await lintHub({ path: small.path }, { maxLines: 7 }), "W_HUB_SIZE"));
  assert.equal(has(await lintHub({ path: small.path }, { maxLines: 8 }), "W_HUB_SIZE"), false);
});

it("E_HUB_REFERENCE_MISSING: relative links must resolve inside the hub", async (t) => {
  const f = hub(t, { body: "# alpha\n\nSee [missing](references/missing.md).\n" });
  const report = await lintHub({ path: f.path });
  const finding = report.findings.find((item) => item.code === "E_HUB_REFERENCE_MISSING");
  assert.ok(finding);
  assert.ok(finding.detail.some((line) => line.startsWith("line ")));
  // URLs, anchors and scheme links are not filesystem references.
  const web = hub(t, {
    body: "# alpha\n\n[web](https://example.test/x) [anchor](#row) [proto](mailto:a@b.c)\n",
  });
  assert.equal(has(await lintHub({ path: web.path }), "E_HUB_REFERENCE_MISSING"), false);
  // A fragment-only or query-only suffix does not change the resolved file.
  const suffixed = hub(t, { body: "# alpha\n\n[guide](references/guide.md#row)\n" });
  suffixed.file(join(suffixed.path, "references", "guide.md"), "# Guide\n");
  assert.equal(has(await lintHub({ path: suffixed.path }), "E_HUB_REFERENCE_MISSING"), false);
});

it("E_HUB_REFERENCE_ESCAPE: absolute and leaving links are refused", async (t) => {
  for (const target of ["/etc/passwd", "~/notes.md", "../outside.md"]) {
    const f = hub(t, { body: `# alpha\n\n[bad](${target})\n` });
    const report = await lintHub({ path: f.path });
    const finding = report.findings.find((item) => item.code === "E_HUB_REFERENCE_ESCAPE");
    assert.ok(finding, `expected escape for ${target}: ${JSON.stringify(report.findings)}`);
    assert.ok(finding.detail.some((line) => line.includes(target)));
  }
  // A link that stays inside the hub is fine, including into subdirectories.
  const f = hub(t, { body: "# alpha\n\n[in](references/guide.md)\n" });
  f.file(join(f.path, "references", "guide.md"), "# Guide\n");
  assert.equal(has(await lintHub({ path: f.path }), "E_HUB_REFERENCE_ESCAPE"), false);
});

it("W_HUB_ORPHAN: unreferenced files under references and subskills", async (t) => {
  const f = hub(t, { body: "# alpha\n\nRead [the guide](references/guide.md).\n" });
  f.file(join(f.path, "references", "guide.md"), "# Guide\n");
  f.file(join(f.path, "references", "orphan.md"), "# Orphan\n");
  const report = await lintHub({ path: f.path });
  const orphans = report.findings.filter((item) => item.code === "W_HUB_ORPHAN");
  assert.deepEqual(
    orphans.map((finding) => finding.path),
    [join(f.path, "references", "orphan.md")],
  );
  // A code span naming the path also counts as a route.
  const routed = hub(t, { body: "# alpha\n\nThen read `references/deep.md` for detail.\n" });
  routed.file(join(routed.path, "references", "deep.md"), "# Deep\n");
  assert.equal(has(await lintHub({ path: routed.path }), "W_HUB_ORPHAN"), false);
  // Files outside references/subskills are never orphans.
  const loose = hub(t, { body: "# alpha\n" });
  loose.file(join(loose.path, "notes.md"), "# Notes\n");
  assert.equal(has(await lintHub({ path: loose.path }), "W_HUB_ORPHAN"), false);
});

it("E_HUB_NESTED_SKILL: no SKILL.md below the hub root", async (t) => {
  const f = hub(t);
  f.file(join(f.path, "subskills", "doctor", "SKILL.md"), "# Wrong entry name\n");
  const report = await lintHub({ path: f.path });
  assert.ok(
    report.findings.some(
      (item) => item.code === "E_HUB_NESTED_SKILL" && item.path.includes("subskills"),
    ),
  );
  const clean = hub(t);
  clean.file(join(clean.path, "subskills", "doctor", "SUBSKILL.md"), "# Doctor\n");
  assert.equal(has(await lintHub({ path: clean.path }), "E_HUB_NESTED_SKILL"), false);
});

it("E_HUB_SKILL_REF_UNKNOWN: load phrases must resolve", async (t) => {
  const f = hub(t, { body: "# alpha\n\nAlso load the `ghost` hub when the task spans repos.\n" });
  const unknown = await lintHub({ path: f.path }, { knownSkill: async () => false });
  const finding = unknown.findings.find((item) => item.code === "E_HUB_SKILL_REF_UNKNOWN");
  assert.ok(finding);
  assert.ok(finding.detail.some((line) => line === "skill ghost"));
  const known = await lintHub({ path: f.path }, { knownSkill: async () => true });
  assert.equal(has(known, "E_HUB_SKILL_REF_UNKNOWN"), false);
  // Without a registry the reference is reported unchecked, never silently skipped.
  const unchecked = await lintHub({ path: f.path });
  assert.equal(has(unchecked, "I_HUB_SKILL_REF_UNCHECKED"), true);
  // Mere backticks are prose, not load phrases.
  const prose = hub(t, { body: "# alpha\n\nUse `ghost` for spooky tasks.\n" });
  const report = await lintHub({ path: prose.path }, { knownSkill: async () => false });
  assert.equal(has(report, "E_HUB_SKILL_REF_UNKNOWN"), false);
});

it("E_HUB_SYMLINK and W_HUB_PROVENANCE: plain files only, repo provenance", async (t) => {
  const f = hub(t);
  f.file(join(f.root, "outside.md"), "Outside\n");
  f.link(join(f.path, "references", "alias.md"), join(f.root, "outside.md"));
  const report = await lintHub({ path: f.path });
  assert.ok(
    report.findings.some(
      (item) =>
        item.code === "E_HUB_SYMLINK" && item.path === join(f.path, "references", "alias.md"),
    ),
  );
  f.file(join(f.path, ".source.yaml"), "origin: {type: vendored}\n");
  const withProvenance = await lintHub({ path: f.path });
  assert.ok(has(withProvenance, "W_HUB_PROVENANCE"));
  const clean = hub(t);
  assert.equal(has(await lintHub({ path: clean.path }), "E_HUB_SYMLINK"), false);
  assert.equal(has(await lintHub({ path: clean.path }), "W_HUB_PROVENANCE"), false);
});

it("fenced code and inline code never produce link findings", async (t) => {
  const f = hub(t, {
    body: [
      "# alpha",
      "",
      "```markdown",
      "[fake](references/missing.md)",
      "```",
      "",
      "`[also-fake](references/missing.md)`",
      "",
    ].join("\n"),
  });
  const report = await lintHub({ path: f.path });
  assert.equal(has(report, "E_HUB_REFERENCE_MISSING"), false, JSON.stringify(report.findings));
  assert.equal(report.data.links, 0);
});

it("markdownLines and localTarget encode the link-scanning contract", () => {
  const lines = markdownLines("```\n[skip](x.md)\n```\n`[code](y.md)`\ntext\n");
  // Fenced lines are skipped entirely; the code-span line, the text line and
  // the trailing empty segment survive.
  assert.equal(lines.length, 3);
  assert.equal(lines[0].spans[0], "[code](y.md)");
  assert.equal(lines[0].prose.trim(), "");
  assert.equal(lines[1].raw, "text");
  assert.equal(localTarget("https://example.test/x"), null);
  assert.equal(localTarget("#anchor"), null);
  assert.equal(localTarget("//cdn.example/x.md"), null);
  assert.equal(localTarget("guide.md#row"), "guide.md");
  assert.equal(localTarget("<guide.md>"), "guide.md");
});

it("skill lint refuses both or neither of a name and a path", async (t) => {
  const f = hub(t);
  const both = await lintSkill("alpha", { path: f.path, cwd: f.root });
  assert.equal(both.exit, ExitCode.CONFIG);
  assert.ok(both.findings.some((item) => item.code === "E_USAGE"));
  const neither = await lintSkill(undefined, { cwd: f.root });
  assert.equal(neither.exit, ExitCode.CONFIG);
  assert.ok(neither.findings.some((item) => item.code === "E_USAGE"));
});

it("skill lint --path lints any hub directory", async (t) => {
  const f = hub(t, { body: "# alpha\n\nSee [missing](references/missing.md).\n" });
  const result = await lintSkill(undefined, { path: f.path, cwd: f.root });
  assert.equal(result.exit, ExitCode.REFUSED);
  assert.ok(result.findings.some((item) => item.code === "E_HUB_REFERENCE_MISSING"));
  assert.equal(result.data.path, f.path);
  f.file(join(f.path, "references", "missing.md"), "# Restored\n");
  const clean = await lintSkill(undefined, { path: f.path, cwd: f.root });
  assert.equal(clean.exit, ExitCode.SUCCESS, JSON.stringify(clean.findings));
});

it("skill lint <name> requires a link declaration and lints the owning checkout", async (t) => {
  const f = hub(t);
  // A name nobody owns is a configuration error, not a missing-hub refusal.
  const registry = join(f.root, "registry");
  mkdirSync(join(registry, "all-skills"), { recursive: true });
  const unknown = await lintSkill("alpha", {
    registryRoot: registry,
    home: f.root,
    cwd: f.root,
    env: {},
  });
  assert.equal(unknown.exit, ExitCode.CONFIG);
  assert.ok(unknown.findings.some((item) => item.code === "E_SKILL_NOT_REPO_OWNED"));
  // Declared and clean: the owning checkout's hub lints green with owner context.
  const repo = join(f.root, "repo");
  const git = (...args) => {
    const result = spawnSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  mkdirSync(join(repo, "skills", "alpha"), { recursive: true });
  writeFileSync(join(repo, "skills", "alpha", "SKILL.md"), readFileSync(join(f.path, "SKILL.md")));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Lint fixture");
  git("config", "user.email", "lint@example.test");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", "git@github.com:delorenj/alpha.git");
  git("add", "--all");
  git("commit", "-qm", "Hub");
  writeFileSync(
    join(registry, "all-skills", "sources.toml"),
    [
      "version = 1",
      "",
      "[[source]]",
      'name = "alpha"',
      'repo = "git@github.com:delorenj/alpha.git"',
      'checkout = "alpha"',
      'mode = "link"',
      'skills = ["alpha"]',
      "",
    ].join("\n"),
  );
  const linted = await lintSkill("alpha", {
    registryRoot: registry,
    home: f.root,
    cwd: f.root,
    env: {},
    checkouts: { alpha: repo },
  });
  assert.equal(linted.exit, ExitCode.SUCCESS, JSON.stringify(linted.findings, null, 2));
  assert.equal(linted.data.source, "alpha");
  assert.equal(linted.data.checkout, repo);
});
