import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { it } from "node:test";
import {
  contextSkillGraph,
  listGraphContexts,
  parseContextSpec,
  renderSkillGraphHtml,
  startSkillGraphServer,
} from "@delorenj/skillex";

/**
 * A registry with three wild skills, a global root, a project, and a Hermes installation whose
 * resolver is a stub that replays a recorded catalog (probe.json in the profile home).
 */
function fixture(t) {
  const root = realpathSync(mkdtempSync("/tmp/skillex-graph-context-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = join(root, "registry");
  const home = join(root, "home");
  const project = join(root, "project");
  const hermes = join(root, "hermes");
  const agent = join(root, "hermes-agent");
  const file = (path, value) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
    return path;
  };
  const skill = (dir, name, body = `# ${name}\n`) =>
    file(
      join(dir, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} fixture\n---\n${body}`,
    );
  for (const dir of ["all-skills", "sets", "packs"])
    mkdirSync(join(registry, dir), { recursive: true });
  const catalog = join(registry, "all-skills");
  skill(catalog, "wild-a", "# wild-a\n\nFor anything else, load the `wild-b` skill.\n");
  skill(catalog, "wild-b");
  skill(catalog, "wild-c");
  mkdirSync(join(project, ".git"), { recursive: true });
  file(join(home, ".agents", "skills.json"), '{"skills":[]}\n');
  const globalRoot = join(home, ".agents", "skills");
  mkdirSync(globalRoot, { recursive: true });
  // The Hermes resolver stub: prints the catalog recorded for the profile it runs under.
  file(join(agent, "venv", "bin", "python"), '#!/bin/sh\nexec cat "$HERMES_HOME/probe.json"\n');
  chmodSync(join(agent, "venv", "bin", "python"), 0o755);
  const profile = (name, rows = [], quarantined = []) => {
    const dir = join(hermes, "profiles", name);
    mkdirSync(join(dir, "skills"), { recursive: true });
    file(
      join(dir, "probe.json"),
      JSON.stringify({
        cwd: project,
        roots: [{ tier: 1, path: join(dir, "skills") }],
        rows,
        quarantined,
      }),
    );
    return dir;
  };
  const row = (name, path, extra = {}) => ({
    name,
    load_name: null,
    status: "unique",
    tier: 1,
    root: dirname(dirname(path)),
    path,
    hidden: false,
    disabled: false,
    ...extra,
  });
  const options = {
    home,
    cwd: project,
    registryRoot: registry,
    stateHome: join(root, "state"),
    env: {},
    hermesRoot: hermes,
    hermesAgent: agent,
    lint: false,
  };
  return {
    root,
    registry,
    catalog,
    home,
    project,
    hermes,
    globalRoot,
    options,
    file,
    skill,
    profile,
    row,
  };
}

const node = (data, id) => data.nodes.find((item) => item.id === id);
const codes = (result) => result.findings.map((finding) => finding.code);

it("parses context specs and rejects unknown kinds", () => {
  assert.deepEqual(parseContextSpec(undefined, "/x"), { kind: "auto" });
  assert.deepEqual(parseContextSpec("global", "/x"), { kind: "global" });
  assert.deepEqual(parseContextSpec("project:sub", "/x"), { kind: "project", path: "/x/sub" });
  assert.deepEqual(parseContextSpec("profile:ops-pm", "/x"), { kind: "profile", name: "ops-pm" });
  assert.throws(() => parseContextSpec("galaxy", "/x"), /Unknown context/);
});

it("global: what the global root holds, local copies, broken links and unavailable targets", async (t) => {
  const f = fixture(t);
  symlinkSync(join(f.catalog, "wild-a"), join(f.globalRoot, "wild-a"));
  f.skill(f.globalRoot, "homegrown");
  symlinkSync(join(f.root, "nowhere"), join(f.globalRoot, "dangling"));
  const result = await contextSkillGraph({ ...f.options, context: "global" });
  assert.ok(result.data, JSON.stringify(result.findings, null, 2));
  const data = result.data;
  assert.equal(data.context.kind, "global");
  assert.equal(node(data, "skill:wild-a").context.status, "loaded");
  assert.equal(node(data, "local:homegrown").kind, "local");
  assert.equal(node(data, "local:homegrown").context.status, "loaded");
  assert.equal(node(data, "skill:wild-c"), undefined, "a skill the context cannot see is absent");
  const ghost = node(data, "skill:wild-b");
  assert.equal(ghost.context.status, "unavailable", "pointed at, but not loadable here");
  assert.ok(
    data.edges.some(
      (e) => e.from === "skill:wild-a" && e.to === "skill:wild-b" && e.kind === "loads",
    ),
  );
  assert.ok(
    node(data, "skill:wild-a").findings.some((x) => x.code === "W_CONTEXT_LOADS_UNAVAILABLE"),
  );
  assert.ok(
    data.nodes.some((n) => n.context?.status === "broken"),
    "the dangling link is broken",
  );
});

it("auto: a .project.json binds the PM, read through Hermes' resolver", async (t) => {
  const f = fixture(t);
  f.file(
    join(f.project, ".project.json"),
    JSON.stringify({
      project_id: "proj",
      agents: { "proj-pm": { role: "pm" }, helper: { role: "dev" } },
    }),
  );
  const skills = join(f.hermes, "profiles", "proj-pm", "skills");
  f.profile(
    "proj-pm",
    [
      f.row("wild-a", join(f.catalog, "wild-a", "SKILL.md")),
      f.row("wild-c", join(f.catalog, "wild-c", "SKILL.md"), { disabled: true }),
      f.row("twin", join(skills, "twin-1", "SKILL.md"), { status: "ambiguous", load_name: "twin" }),
      f.row("twin", join(skills, "twin-2", "SKILL.md"), { status: "ambiguous", load_name: "twin" }),
    ],
    [{ path: join(f.project, ".agents", "skills", "risky", "SKILL.md"), root: f.project, tier: 0 }],
  );
  f.skill(skills, "twin-1");
  f.skill(skills, "twin-2");
  f.skill(join(f.project, ".agents", "skills"), "risky");
  const result = await contextSkillGraph(f.options);
  const data = result.data;
  assert.ok(data, JSON.stringify(result.findings, null, 2));
  assert.equal(data.context.kind, "profile");
  assert.equal(data.context.profile, "proj-pm");
  assert.match(data.context.detectedFrom, /bound PM proj-pm/);
  assert.equal(node(data, "skill:wild-a").context.status, "loaded");
  assert.equal(node(data, "skill:wild-c").context.status, "disabled");
  assert.equal(node(data, "skill:wild-b").context.status, "unavailable");
  const twin = data.nodes.find((n) => n.name === "twin");
  assert.equal(twin.context.status, "ambiguous");
  assert.ok(twin.findings.some((x) => x.code === "E_CONTEXT_AMBIGUOUS"));
  const risky = data.nodes.find((n) => n.name === "risky");
  assert.equal(risky.context.status, "quarantined");
  assert.ok(
    risky.findings.some((x) => x.code === "E_CONTEXT_QUARANTINED"),
    "nothing else provides it",
  );
  assert.equal(data.context.counts.loaded, 1);
  // Like the catalog graph, node problems are health, not a failed read.
  assert.equal(result.exit, 0, JSON.stringify(result.findings));
  assert.ok(data.summary.health.error >= 2, "the ambiguous pair and the quarantined copy");

  // A Hermes session's own profile wins over the project binding.
  f.profile("other", [f.row("wild-c", join(f.catalog, "wild-c", "SKILL.md"))]);
  const session = await contextSkillGraph({
    ...f.options,
    env: { HERMES_HOME: join(f.hermes, "profiles", "other") },
  });
  assert.equal(session.data.context.profile, "other");
  assert.match(session.data.context.detectedFrom, /HERMES_HOME/);
});

it("auto: a PM with no Hermes profile falls back, and says so", async (t) => {
  const f = fixture(t);
  f.file(
    join(f.project, ".project.json"),
    JSON.stringify({ agents: { "ghost-pm": { role: "pm" } } }),
  );
  const result = await contextSkillGraph(f.options);
  assert.ok(result.data);
  assert.equal(result.data.context.kind, "global");
  assert.ok(codes(result).includes("W_CONTEXT_PM_PROFILE_MISSING"));
  const plain = await contextSkillGraph({ ...f.options, cwd: f.root });
  assert.equal(plain.data.context.kind, "global");
  assert.equal(codes(plain).includes("W_CONTEXT_PROJECT_MANIFEST"), false);
});

it("focus: a neighbourhood around named skills; unknown names are a usage error", async (t) => {
  const f = fixture(t);
  const focused = await contextSkillGraph({ ...f.options, context: "catalog", focus: ["wild-a"] });
  const ids = focused.data.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ["skill:wild-a", "skill:wild-b"]);
  assert.deepEqual(focused.data.focus.seeds, ["skill:wild-a"]);
  const reverse = await contextSkillGraph({ ...f.options, context: "catalog", focus: ["wild-b"] });
  assert.ok(
    reverse.data.nodes.some((n) => n.id === "skill:wild-a"),
    "focus follows edges both ways",
  );
  const glob = await contextSkillGraph({
    ...f.options,
    context: "catalog",
    focus: ["wild-*"],
    depth: 0,
  });
  assert.equal(glob.data.focus.seeds.length, 3);
  const unknown = await contextSkillGraph({ ...f.options, context: "catalog", focus: ["nope"] });
  assert.equal(unknown.data, null);
  assert.ok(codes(unknown).includes("E_FOCUS_UNKNOWN"));
});

it("serve: every request reads the roots again", async (t) => {
  const f = fixture(t);
  const server = await startSkillGraphServer({ ...f.options, context: "global", port: 0 });
  t.after(() => server.close());
  const get = async (path) => {
    const response = await fetch(new URL(path, server.url));
    return {
      status: response.status,
      type: response.headers.get("content-type"),
      body: await response.text(),
      cache: response.headers.get("cache-control"),
    };
  };
  assert.equal((await get("/healthz")).body, "ok\n");
  const contexts = JSON.parse((await get("/contexts.json")).body).map((c) => c.id);
  assert.ok(contexts.includes("global") && contexts.includes("catalog"));

  const before = JSON.parse((await get("/graph.json")).body);
  assert.equal(before.data.context.kind, "global");
  assert.equal(
    before.data.nodes.some((n) => n.name === "wild-c"),
    false,
  );
  symlinkSync(join(f.catalog, "wild-c"), join(f.globalRoot, "wild-c"));
  const after = await get("/graph.json");
  assert.equal(after.cache, "no-store");
  assert.ok(
    JSON.parse(after.body).data.nodes.some((n) => n.name === "wild-c"),
    "no stale cache",
  );

  const page = await get("/?focus=wild-c");
  assert.equal(page.status, 200);
  assert.match(page.body, /<title>Skill Graph<\/title>/);
  assert.match(page.body, /"live":true/);
  const bad = await get("/?context=galaxy");
  assert.equal(bad.status, 422);
  assert.match(bad.body, /Unknown context: galaxy/);
  assert.equal((await get("/nope")).status, 404);
});

it("lists catalog, global and each Hermes profile as pickable contexts", async (t) => {
  const f = fixture(t);
  f.profile("alpha");
  f.profile("beta");
  const ids = (await listGraphContexts(f.options)).map((c) => c.id);
  assert.deepEqual(ids, ["global", "catalog", "profile:alpha", "profile:beta"]);
});

it("a snapshot page names its context and says it is a snapshot", async (t) => {
  const f = fixture(t);
  const { data } = await contextSkillGraph({ ...f.options, context: "global" });
  const html = renderSkillGraphHtml(data, new Date("2026-11-20T00:00:00Z"));
  assert.match(html, /"live":false/);
  assert.match(html, /"kind":"global"/);
});

it("profile: loadable means Hermes' loader serves that file for the name", async (t) => {
  const f = fixture(t);
  const skills = join(f.hermes, "profiles", "ops-pm", "skills");
  const projectSkills = join(f.project, ".agents", "skills");
  const served = (path) => ({ ok: true, path, error: null });
  f.skill(skills, "guarded");
  f.skill(projectSkills, "guarded");
  mkdirSync(skills, { recursive: true });
  symlinkSync(join(f.catalog, "wild-b"), join(skills, "wild-b"));
  symlinkSync(join(f.catalog, "wild-c"), join(projectSkills, "wild-c"));
  symlinkSync(join(f.catalog, "wild-c"), join(projectSkills, "see"));
  f.profile(
    "ops-pm",
    [
      f.row("wild-a", join(f.catalog, "wild-a", "SKILL.md"), {
        lookup: served(join(f.catalog, "wild-a", "SKILL.md")),
      }),
      // wild-a loads wild-b, which is switched off here.
      f.row("wild-b", join(skills, "wild-b", "SKILL.md"), { disabled: true }),
      // A quarantined project copy owns the name, so the profile copy never loads.
      f.row("guarded", join(skills, "guarded", "SKILL.md"), {
        lookup: {
          ok: false,
          path: null,
          error: "Project skill 'guarded' is quarantined: the security scan flagged it.",
        },
      }),
      // One skill linked twice: the catalog calls it ambiguous, the loader serves both names.
      f.row("wild-c", join(projectSkills, "wild-c", "SKILL.md"), {
        status: "ambiguous",
        tier: 0,
        lookup: served(join(projectSkills, "wild-c", "SKILL.md")),
      }),
      f.row("wild-c", join(projectSkills, "see", "SKILL.md"), {
        status: "ambiguous",
        load_name: "see",
        tier: 0,
        lookup: served(join(projectSkills, "see", "SKILL.md")),
      }),
    ],
    [{ path: join(projectSkills, "guarded", "SKILL.md"), root: projectSkills, tier: 0 }],
  );
  const result = await contextSkillGraph({ ...f.options, context: "profile:ops-pm" });
  const data = result.data;
  assert.ok(data, JSON.stringify(result.findings, null, 2));
  const guarded = data.nodes.filter((n) => n.name === "guarded");
  assert.ok(guarded.length >= 1);
  assert.ok(
    guarded.every((n) => n.context.status !== "loaded"),
    "a name Hermes refuses is never drawn as loaded",
  );
  assert.ok(guarded.some((n) => n.findings.some((x) => x.code === "E_CONTEXT_QUARANTINED")));
  const c = node(data, "skill:wild-c");
  assert.equal(c.context.status, "loaded", "identical links are one skill, not ambiguous");
  assert.deepEqual(c.context.entries.map((e) => e.name).sort(), ["see", "wild-c"]);
  assert.equal(node(data, "skill:wild-b").context.status, "disabled");
  assert.ok(
    node(data, "skill:wild-a").findings.some(
      (x) => x.code === "W_CONTEXT_LOADS_UNAVAILABLE" && /disabled/.test(x.message),
    ),
    "a load into a switched-off skill is a routing hole",
  );
  assert.equal(data.context.counts.loaded, 3);
});

it("global: an alias link still satisfies a load by the skill's own name", async (t) => {
  const f = fixture(t);
  symlinkSync(join(f.catalog, "wild-a"), join(f.globalRoot, "wild-a"));
  symlinkSync(join(f.catalog, "wild-b"), join(f.globalRoot, "bee"));
  const { data } = await contextSkillGraph({ ...f.options, context: "global" });
  assert.equal(node(data, "skill:wild-b").context.status, "loaded");
  assert.equal(data.context.counts.unavailable, 0);
  assert.deepEqual(node(data, "skill:wild-a").findings, []);
});

it("project: each copy of a name owns its own sub-skills", async (t) => {
  const f = fixture(t);
  const projectSkills = join(f.project, ".agents", "skills");
  f.file(join(f.project, ".agents", "skills.json"), '{"skills":[]}\n');
  for (const [root, target] of [
    [f.globalRoot, "wild-b"],
    [projectSkills, "wild-c"],
  ]) {
    f.skill(root, "foo", "# foo\n\nSee [s1](subskills/s1/SUBSKILL.md).\n");
    f.file(
      join(root, "foo", "subskills", "s1", "SUBSKILL.md"),
      `---\ndescription: s1 of ${target}\n---\nLoad the \`${target}\` skill.\n`,
    );
  }
  const { data } = await contextSkillGraph({ ...f.options, context: `project:${f.project}` });
  const foos = data.nodes.filter((n) => n.kind === "local" && n.name === "foo");
  assert.equal(foos.length, 2);
  const winner = foos.find((n) => n.context.status === "loaded");
  const sub = data.edges.find((e) => e.from === winner.id && e.kind === "routes").to;
  assert.equal(node(data, sub).description, "s1 of wild-c");
  const loads = data.edges.filter((e) => e.from === sub && e.kind === "loads").map((e) => e.to);
  assert.deepEqual(loads, ["skill:wild-c"]);
});

it("project:<dir> that does not exist is a usage error, not another project's graph", async (t) => {
  const f = fixture(t);
  const result = await contextSkillGraph({
    ...f.options,
    context: `project:${join(f.project, "typo")}`,
  });
  assert.equal(result.data, null);
  assert.equal(result.exit, 2);
  assert.ok(codes(result).includes("E_CONTEXT"));
});
