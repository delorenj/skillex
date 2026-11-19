import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { addSetSkills, createSet, renderSkillGraphHtml, skillGraph } from "@delorenj/skillex";

const REPO = "git@github.com:delorenj/HeyMa.git";

function fixture(t) {
  const root = realpathSync(mkdtempSync("/tmp/skillex-graph-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = join(root, "registry");
  const home = join(root, "home");
  const project = join(root, "project");
  const file = (path, value) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
    return path;
  };
  for (const dir of ["all-skills", "sets", "packs"])
    mkdirSync(join(registry, dir), { recursive: true });
  mkdirSync(join(project, ".git"), { recursive: true });
  file(join(home, ".agents", "skills.json"), '{"skills":[]}\n');
  file(join(project, ".agents", "skills.json"), '{"skills":[]}\n');
  const checkouts = {};
  const options = {
    home,
    cwd: project,
    registryRoot: registry,
    stateHome: join(root, "state"),
    env: {},
    timeoutMs: 10_000,
    checkouts,
  };
  const git = (cwd, ...args) => {
    const result = spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    assert.equal(result.status, 0, result.stderr);
  };
  const skill = (dir, name, body) =>
    file(
      join(dir, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} fixture\n---\n${body}`,
    );
  /** A HeyMa checkout whose skills/ holds the heyma hub (plus any extra skill directories). */
  const checkout = (extra = []) => {
    const repo = join(root, "checkouts", "HeyMa");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "remote", "add", "origin", REPO);
    const skills = join(repo, "skills");
    skill(
      skills,
      "heyma",
      "# heyma\n\nFor scheduling, load the `wild-a` skill. See [crank](subskills/crank/SUBSKILL.md).\n\n| Not here | `wild-b` |\n",
    );
    file(
      join(skills, "heyma", "subskills", "crank", "SUBSKILL.md"),
      "---\ndescription: The crank sub-skill\n---\n# crank\nLoads the `wild-b` skill.\n",
    );
    for (const name of extra) skill(skills, name, `# ${name}\n`);
    git(repo, "add", "--all");
    git(
      repo,
      "-c",
      "user.name=f",
      "-c",
      "user.email=f@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    );
    checkouts.HeyMa = repo;
    file(
      join(registry, "all-skills", "sources.toml"),
      `version = 1\n\n[[source]]\nname = "heyma"\nrepo = "${REPO}"\ncheckout = "HeyMa"\nmode = "link"\nskills = ["heyma"]\n`,
    );
    return repo;
  };
  skill(join(registry, "all-skills"), "wild-a", "# wild-a\n");
  skill(join(registry, "all-skills"), "wild-b", "# wild-b\n[gone](missing.md)\n");
  return { registry, options, checkout };
}

const ok = (result) => {
  assert.equal(result.exit, 0, JSON.stringify(result.findings, null, 2));
  return result.data;
};
const node = (data, id) => data.nodes.find((item) => item.id === id);
const has = (data, from, to, kind) =>
  data.edges.some((edge) => edge.from === from && edge.to === to && edge.kind === kind);

it("maps a repo-owned hub: owner, sub-skill, loads, mentions and set membership", async (t) => {
  const f = fixture(t);
  const repo = f.checkout();
  ok(await createSet("daily", f.options));
  ok(await addSetSkills("daily", ["heyma", "wild-a"], f.options));
  const data = ok(await skillGraph(f.options));

  const hub = node(data, "skill:heyma");
  assert.equal(hub.kind, "hub");
  assert.equal(hub.source, "heyma");
  assert.equal(hub.root, realpathSync(repo), "a hub joins to the repository that holds skills/");
  assert.equal(hub.health, "ok", JSON.stringify(hub.findings));
  const source = node(data, "source:heyma");
  assert.deepEqual(source.hubs, ["heyma"]);
  assert.equal(source.health, "ok");

  assert.ok(has(data, "source:heyma", "skill:heyma", "owns"));
  assert.ok(has(data, "skill:heyma", "subskill:heyma/crank", "routes"));
  assert.ok(has(data, "skill:heyma", "skill:wild-a", "loads"));
  assert.ok(has(data, "skill:heyma", "skill:wild-b", "mentions"));
  assert.equal(
    has(data, "skill:heyma", "skill:wild-a", "mentions"),
    false,
    "loads supersedes mentions",
  );
  assert.ok(
    has(data, "subskill:heyma/crank", "skill:wild-b", "loads"),
    "sub-skill edges are its own",
  );
  assert.ok(has(data, "set:daily", "skill:heyma", "member"));
  assert.equal(node(data, "subskill:heyma/crank").description, "The crank sub-skill");
  assert.equal(node(data, "skill:wild-a").kind, "wild");
  assert.equal(data.summary.nodes.hub, 1);
  assert.equal(data.summary.nodes.subskill, 1);
});

it("a second skill in the owning repository is E_HUB_COUNT on the source and the hub", async (t) => {
  const f = fixture(t);
  f.checkout(["stray"]);
  const data = ok(await skillGraph(f.options));
  const source = node(data, "source:heyma");
  assert.deepEqual(source.hubs, ["heyma", "stray"]);
  assert.equal(source.health, "error");
  assert.ok(source.findings.some((item) => item.code === "E_HUB_COUNT"));
  assert.ok(node(data, "skill:heyma").findings.some((item) => item.code === "E_HUB_COUNT"));
  assert.equal(data.summary.health.error >= 2, true);
});

it("wild skills are linted only on request, and --no-lint skips lint entirely", async (t) => {
  const f = fixture(t);
  f.checkout(["stray"]);
  assert.deepEqual(node(ok(await skillGraph(f.options)), "skill:wild-b").findings, []);
  const wild = ok(await skillGraph({ ...f.options, lintWild: true }));
  assert.ok(
    node(wild, "skill:wild-b").findings.some((item) => item.code === "E_HUB_REFERENCE_MISSING"),
  );
  const bare = ok(await skillGraph({ ...f.options, lint: false }));
  assert.deepEqual(node(bare, "skill:heyma").findings, []);
});

it("renders a self-contained page whose embedded data cannot close its script tag", async (t) => {
  const f = fixture(t);
  f.checkout();
  const data = ok(await skillGraph(f.options));
  const tricky = {
    ...data,
    nodes: [...data.nodes, { ...data.nodes[0], id: "skill:x", description: "</script><b>" }],
  };
  const html = renderSkillGraphHtml(tricky, new Date("2026-11-18T00:00:00Z"));
  assert.match(html, /<title>Skill Graph<\/title>/);
  assert.equal(html.includes("</script><b>"), false);
  const embedded = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(embedded);
  const parsed = JSON.parse(embedded[1]);
  assert.equal(parsed.generatedAt, "2026-11-18T00:00:00.000Z");
  assert.ok(parsed.nodes.some((item) => item.description === "</script><b>"));
});
