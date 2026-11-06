import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { it } from "node:test";
import {
  addPackSkills,
  addSetSkills,
  createPack,
  createSet,
  explainSkill,
  inspectVendorStatus,
  listSkills,
  listVendorSources,
  showSkill,
  sync,
  syncVendorSources,
} from "@delorenj/skillex";

const SSH_REPO = "git@github.com:delorenj/HeyMa.git";
const HTTPS_REPO = "https://github.com/delorenj/HeyMa.git";

function fixture(t) {
  const root = realpathSync(mkdtempSync("/tmp/skillex-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  const registry = join(root, "registry");
  const stateHome = join(root, "state");
  const directory = (path) => {
    mkdirSync(path, { recursive: true });
    return path;
  };
  const file = (path, value) => {
    directory(dirname(path));
    writeFileSync(path, value);
    return path;
  };
  const manifest = (scopeRoot, value) =>
    file(join(scopeRoot, ".agents", "skills.json"), `${JSON.stringify(value)}\n`);
  directory(join(registry, "all-skills"));
  directory(join(registry, "sets"));
  directory(join(registry, "packs"));
  directory(home);
  directory(join(project, ".git"));
  manifest(home, { skills: [] });
  manifest(project, { skills: [] });
  const checkouts = {};
  const options = {
    home,
    cwd: project,
    registryRoot: registry,
    stateHome,
    env: {},
    timeoutMs: 10_000,
    checkouts,
  };
  function git(checkoutRoot, ...args) {
    const result = spawnSync("git", ["-C", checkoutRoot, ...args], {
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
  }
  /** Materialize the owning repository: a git repo with skills/<name>/SKILL.md and an origin. */
  function hub({
    name = "heyma",
    checkout = "HeyMa",
    origin = SSH_REPO,
    body = `---\nname: ${name}\ndescription: The HeyMa hub fixture\n---\n# ${name}\n`,
  } = {}) {
    const rootPath = directory(join(root, "checkouts", checkout));
    git(rootPath, "init", "-q", "-b", "main");
    git(rootPath, "config", "user.name", "Link fixture");
    git(rootPath, "config", "user.email", "link@example.test");
    git(rootPath, "config", "commit.gpgsign", "false");
    git(rootPath, "remote", "add", "origin", origin);
    const hubPath = directory(join(rootPath, "skills", name));
    file(join(hubPath, "SKILL.md"), body);
    git(rootPath, "add", "--all");
    git(rootPath, "commit", "-qm", "Hub fixture");
    const head = git(rootPath, "rev-parse", "HEAD");
    checkouts[checkout] = rootPath;
    return { root: rootPath, hub: hubPath, head };
  }
  function sources(entries) {
    const value = (item) =>
      Array.isArray(item)
        ? `[${item.map(value).join(", ")}]`
        : item && typeof item === "object"
          ? `{ ${Object.entries(item)
              .map(([key, child]) => `${key} = ${value(child)}`)
              .join(", ")} }`
          : JSON.stringify(item);
    file(
      join(registry, "all-skills", "sources.toml"),
      `version = 1\n${entries
        .map(
          (entry) =>
            `\n[[source]]\n${Object.entries(entry)
              .map(([key, item]) => `${key} = ${value(item)}\n`)
              .join("")}`,
        )
        .join("")}`,
    );
  }
  return {
    root,
    home,
    project,
    registry,
    stateHome,
    checkouts,
    options,
    directory,
    file,
    manifest,
    git,
    hub,
    sources,
  };
}

function ok(result) {
  assert.equal(result.schema, 2);
  assert.equal(result.exit, 0, JSON.stringify(result.findings, null, 2));
  assert.equal(result.ok, true);
  assert.ok(result.data);
  return result.data;
}

function failure(result, code, exit) {
  assert.equal(result.ok, false);
  assert.equal(result.exit, exit, JSON.stringify(result.findings, null, 2));
  const found = result.findings.find((item) => item.code === code);
  assert.ok(found, `missing ${code}: ${JSON.stringify(result.findings, null, 2)}`);
  assert.ok(found.fix);
  return found;
}

it("lists and shows a repo-owned skill with its owner identity", async (t) => {
  const f = fixture(t);
  const owned = f.hub({ origin: HTTPS_REPO }); // git@ declaration matches an https origin.
  f.sources([
    { name: "heyma", repo: SSH_REPO, checkout: "HeyMa", mode: "link", skills: ["heyma"] },
  ]);
  const listed = ok(await listSkills(f.options));
  assert.deepEqual(
    listed.skills.map((skill) => skill.name),
    ["heyma"],
  );
  const entry = listed.skills[0];
  assert.equal(entry.path, realpathSync(owned.hub));
  assert.equal(entry.metadata.name, "heyma");
  assert.deepEqual(entry.owner, {
    kind: "repo",
    source: "heyma",
    repo: SSH_REPO,
    checkout: realpathSync(owned.root),
    commit: owned.head,
  });
  const shown = ok(await showSkill("heyma", f.options));
  assert.equal(shown.skill.path, realpathSync(owned.hub));
  assert.deepEqual(shown.skill.owner, entry.owner);
  // explain pairs the canonical target with its owner (its exit reflects activation drift,
  // which is a separate axis from owner identity).
  const explained = await explainSkill("heyma", f.options);
  assert.equal(explained.data.owner?.kind, "repo");
  assert.equal(explained.data.owner?.commit, owned.head);
});

it("refuses a name defined in both all-skills and a link source", async (t) => {
  const f = fixture(t);
  f.hub();
  f.sources([
    { name: "heyma", repo: SSH_REPO, checkout: "HeyMa", mode: "link", skills: ["heyma"] },
  ]);
  f.file(
    join(f.registry, "all-skills", "heyma", "SKILL.md"),
    "---\nname: heyma\ndescription: Wild copy\n---\n",
  );
  failure(await listSkills(f.options), "E_DIVERGENT_CANONICAL_NAME", 3);
  failure(await showSkill("heyma", f.options), "E_DIVERGENT_CANONICAL_NAME", 3);
  failure(await explainSkill("heyma", f.options), "E_DIVERGENT_CANONICAL_NAME", 3);
});

it("refuses a required link source whose checkout is unavailable", async (t) => {
  const f = fixture(t);
  f.sources([
    { name: "heyma", repo: SSH_REPO, checkout: "HeyMa", mode: "link", skills: ["heyma"] },
  ]);
  delete f.checkouts.HeyMa;
  failure(await showSkill("heyma", f.options), "E_SOURCE_CHECKOUT_MISSING", 3);
});

it("reports a skill missing when an optional link source has no checkout", async (t) => {
  const f = fixture(t);
  f.sources([
    {
      name: "heyma",
      repo: SSH_REPO,
      checkout: "HeyMa",
      mode: "link",
      optional: true,
      skills: ["heyma"],
    },
  ]);
  delete f.checkouts.HeyMa;
  failure(await showSkill("heyma", f.options), "E_SKILL_MISSING", 3);
  // Listing simply omits an unavailable optional source.
  assert.deepEqual(ok(await listSkills(f.options)).skills, []);
});

it("refuses a link skill whose directory differs from its name", async (t) => {
  const f = fixture(t);
  const owned = f.hub();
  f.sources([
    {
      name: "heyma",
      repo: SSH_REPO,
      checkout: "HeyMa",
      mode: "link",
      skills: [{ name: "heyma", dir: "wax" }],
    },
  ]);
  failure(await listVendorSources(f.options), "E_SOURCES_MANIFEST_INVALID", 2);
  assert.equal(existsSync(join(owned.root, "skills", "wax")), false);
});

it("verifies the checkout origin against the declared repository", async (t) => {
  const f = fixture(t);
  f.hub({ origin: "git@github.com:someoneelse/Other.git" });
  f.sources([
    { name: "heyma", repo: SSH_REPO, checkout: "HeyMa", mode: "link", skills: ["heyma"] },
  ]);
  const found = failure(await showSkill("heyma", f.options), "E_SOURCE_IDENTITY_MISMATCH", 3);
  assert.ok(found.detail.some((line) => line.includes(HTTPS_REPO) || line.includes(SSH_REPO)));
});

it("refuses a checkout marked stale", async (t) => {
  const f = fixture(t);
  const owned = f.hub();
  f.file(join(owned.root, "STALE-CHECKOUT.md"), "# Retired checkout\n");
  f.sources([
    { name: "heyma", repo: SSH_REPO, checkout: "HeyMa", mode: "link", skills: ["heyma"] },
  ]);
  failure(await showSkill("heyma", f.options), "E_SOURCE_CHECKOUT_STALE", 3);
});

it("refuses a skill link that escapes the owning checkout", async (t) => {
  const f = fixture(t);
  const owned = f.hub();
  f.file(join(f.root, "outside.md"), "Outside the checkout\n");
  f.directory(join(owned.hub, "references"));
  symlinkSync(
    relative(dirname(join(owned.hub, "references")), join(f.root, "outside.md")),
    join(owned.hub, "references", "escape.md"),
  );
  f.sources([
    { name: "heyma", repo: SSH_REPO, checkout: "HeyMa", mode: "link", skills: ["heyma"] },
  ]);
  failure(await showSkill("heyma", f.options), "E_OWNED_SKILL_ESCAPE", 3);
});

it("activates a hub through the owning repo itself with a relative link", async (t) => {
  const f = fixture(t);
  // The project is the owning repository: its manifest selects its own hub.
  const repo = join(f.root, "checkouts", "HeyMa");
  const owned = f.hub();
  assert.equal(owned.root, repo);
  f.manifest(repo, { skills: ["heyma"] });
  f.sources([
    { name: "heyma", repo: SSH_REPO, checkout: "HeyMa", mode: "link", skills: ["heyma"] },
  ]);
  const result = ok(await sync({ ...f.options, cwd: repo }));
  const activation = join(repo, ".agents", "skills");
  assert.equal(readlinkSync(join(activation, "heyma")), "../../skills/heyma");
  assert.equal(realpathSync(join(activation, "heyma")), realpathSync(owned.hub));
  const record = JSON.parse(
    readFileSync(result.scopes.find((scope) => scope.scope === "project").receiptPath, "utf8"),
  );
  const source = record.data.sources.find((entry) => entry.path === join(repo, "skills"));
  assert.ok(source, JSON.stringify(record.data.sources));
  assert.equal(source.commit, owned.head);
});

it("records the owning repo HEAD in activation receipts", async (t) => {
  const f = fixture(t);
  const owned = f.hub();
  f.sources([
    { name: "heyma", repo: SSH_REPO, checkout: "HeyMa", mode: "link", skills: ["heyma"] },
  ]);
  f.manifest(f.project, { inherit_global: false, skills: ["heyma"] });
  const result = ok(await sync({ ...f.options, scope: "project" }));
  const activation = join(f.project, ".agents", "skills");
  assert.equal(realpathSync(join(activation, "heyma")), realpathSync(owned.hub));
  const record = JSON.parse(
    readFileSync(result.scopes.find((scope) => scope.scope === "project").receiptPath, "utf8"),
  );
  const source = record.data.sources.find((entry) => entry.path === join(owned.root, "skills"));
  assert.ok(source, JSON.stringify(record.data.sources));
  assert.equal(source.commit, owned.head);
});

it("a commit in the owning repo alone does not make the receipt pending", async (t) => {
  const f = fixture(t);
  const owned = f.hub();
  f.sources([
    { name: "heyma", repo: SSH_REPO, checkout: "HeyMa", mode: "link", skills: ["heyma"] },
  ]);
  f.manifest(f.project, { inherit_global: false, skills: ["heyma"] });
  ok(await sync({ ...f.options, scope: "project" }));
  f.file(join(owned.root, "NOTES.md"), "unrelated change\n");
  f.git(owned.root, "add", "--all");
  f.git(owned.root, "commit", "-qm", "Unrelated commit");
  const again = await sync({ ...f.options, scope: "project", dryRun: true, exitCode: true });
  assert.equal(again.exit, 0, JSON.stringify(again.data?.scopes ?? again.findings, null, 2));
  assert.deepEqual(
    again.data.scopes.flatMap((scope) => scope.changes),
    [],
  );
});

it("an unreadable sources.toml never blocks catalog-only resolution", async (t) => {
  const f = fixture(t);
  f.file(
    join(f.registry, "all-skills", "wild", "SKILL.md"),
    "---\nname: wild\ndescription: A catalog skill\n---\n",
  );
  const real = f.file(join(f.root, "elsewhere", "sources.toml"), "version = 1\n");
  symlinkSync(real, join(f.registry, "all-skills", "sources.toml"));
  f.manifest(f.project, { inherit_global: false, skills: ["wild"] });
  ok(await showSkill("wild", f.options));
  ok(await sync({ ...f.options, scope: "project" }));
});

it("vendor sync reports link sources as linked and never vendors them", async (t) => {
  const f = fixture(t);
  const owned = f.hub();
  const UPSTREAM_REPO = "https://example.invalid/upstream.git";
  const upstreamRoot = f.directory(join(f.root, "checkouts", "Upstream"));
  f.git(upstreamRoot, "init", "-q", "-b", "main");
  f.git(upstreamRoot, "config", "user.name", "Link fixture");
  f.git(upstreamRoot, "config", "user.email", "link@example.test");
  f.git(upstreamRoot, "config", "commit.gpgsign", "false");
  f.git(upstreamRoot, "remote", "add", "origin", UPSTREAM_REPO);
  f.file(
    join(upstreamRoot, "skills", "alpha", "SKILL.md"),
    "---\nname: alpha\ndescription: Vendored sibling\n---\n",
  );
  f.git(upstreamRoot, "add", "--all");
  f.git(upstreamRoot, "commit", "-qm", "Vendor fixture");
  f.checkouts.Upstream = upstreamRoot;
  f.sources([
    { name: "heyma", repo: SSH_REPO, checkout: "HeyMa", mode: "link", skills: ["heyma"] },
    {
      name: "upstream",
      repo: UPSTREAM_REPO,
      version: "main",
      checkout: "Upstream",
      skills: ["alpha"],
    },
  ]);
  const result = await syncVendorSources(f.options);
  assert.equal(result.exit, 0, JSON.stringify(result.findings, null, 2));
  const linked = result.data.sources.find((source) => source.name === "heyma");
  assert.equal(linked.linked, true);
  assert.equal(linked.skipped, true);
  assert.equal(linked.checkout, null);
  assert.ok(
    result.findings.some(
      (finding) => finding.code === "I_SOURCE_LINKED" && finding.severity === "info",
    ),
  );
  // The hub is never copied into all-skills/; the vendor sibling still syncs.
  assert.equal(existsSync(join(f.registry, "all-skills", "heyma")), false);
  assert.equal(existsSync(join(f.registry, "all-skills", "alpha", "SKILL.md")), true);
  // Status reports the hub as linked, with checkout detail only under --upstream.
  const status = await inspectVendorStatus(f.options);
  assert.equal(status.exit, 0, JSON.stringify(status.findings, null, 2));
  const row = status.data.sources.find((source) => source.name === "heyma");
  assert.equal(row.mode, "link");
  assert.equal(row.checkout, null);
  const skillRow = status.data.skills.find((skill) => skill.name === "heyma");
  assert.equal(skillRow.state, "linked");
  const upstream = await inspectVendorStatus({ ...f.options, upstream: true });
  assert.equal(
    upstream.data.sources.find((source) => source.name === "heyma").checkout.root,
    realpathSync(owned.root),
  );
});

it("vendor prune preserves a skill whose provenance names a link source", async (t) => {
  const f = fixture(t);
  f.hub();
  f.sources([
    { name: "heyma", repo: SSH_REPO, checkout: "HeyMa", mode: "link", skills: ["heyma"] },
  ]);
  const copied = join(f.registry, "all-skills", "heyma");
  f.file(join(copied, "SKILL.md"), "---\nname: heyma\ndescription: Stale copied bytes\n---\n");
  f.file(
    join(copied, ".source.yaml"),
    `origin:\n  type: vendored\n  source: heyma\n  upstream: ${SSH_REPO}\n`,
  );
  const result = await syncVendorSources({ ...f.options, prune: true });
  // Prune never removes a directory whose provenance names a link source: the
  // link source owns the name, and it is not the prune baseline's to delete.
  assert.equal(existsSync(copied), true);
  assert.ok(
    !result.data.applied.some((change) => change.name === "heyma"),
    JSON.stringify(result.data.applied, null, 2),
  );
});

it("refuses a vendor source that claims a linked name", async (t) => {
  const f = fixture(t);
  f.hub();
  f.sources([
    { name: "heyma", repo: SSH_REPO, checkout: "HeyMa", mode: "link", skills: ["heyma"] },
    { name: "other", repo: SSH_REPO, version: "main", checkout: "HeyMa", skills: ["heyma"] },
  ]);
  // An explicit second claim is a manifest-level refusal: a repo-owned name has one owner.
  failure(await syncVendorSources(f.options), "E_SOURCES_MANIFEST_INVALID", 2);
});

it("sets and packs refuse repo-owned members", async (t) => {
  const f = fixture(t);
  f.hub();
  f.sources([
    { name: "heyma", repo: SSH_REPO, checkout: "HeyMa", mode: "link", skills: ["heyma"] },
  ]);
  ok(await createSet("daily", f.options));
  failure(await addSetSkills("daily", ["heyma"], f.options), "E_OWNED_SKILL_IN_COMPOSITION", 3);
  ok(await createPack("daily", "1.0.0", f.options));
  failure(await addPackSkills("daily", ["heyma"], f.options), "E_OWNED_SKILL_IN_COMPOSITION", 3);
});
