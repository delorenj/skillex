import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { it } from "node:test";
import { gitAt, loadAcquisitionFixture } from "./acquisition-fixture.mjs";

const core = (await loadAcquisitionFixture()).core;
const {
  addSkillFromSource,
  importSkillFromSource,
  parseSourceLocation,
  provisionalSkillName,
  resolveTreeLocation,
} = core;

function makeWorld(t) {
  // Receipts, homes, and clones stay in /tmp fixtures: never ~/.claude, never
  // the live catalog, never the real global install.
  const root = realpathSync(mkdtempSync("/tmp/skillex-acquisition-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = join(root, "registry");
  mkdirSync(join(registry, "all-skills"), { recursive: true });
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const options = {
    registryRoot: registry,
    home,
    cwd: root,
    env: {},
    stateHome: join(root, "state"),
    timeoutMs: 10_000,
  };
  function write(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
  }
  return { root, registry, home, options, write };
}

function snapshot(root) {
  if (!existsSync(root)) return null;
  const rows = [];
  function visit(path) {
    const info = lstatSync(path);
    rows.push([
      relative(root, path),
      info.mode,
      info.isSymbolicLink()
        ? readlinkSync(path)
        : info.isFile()
          ? createHash("sha256").update(readFileSync(path)).digest("hex")
          : "directory",
    ]);
    if (info.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
  }
  visit(root);
  return rows;
}

function unchanged(roots, action) {
  const before = roots.map(snapshot);
  try {
    return action();
  } finally {
    for (const [index, root] of roots.entries())
      assert.deepEqual(snapshot(root), before[index], `preview changed ${root}`);
  }
}

function ok(result) {
  assert.equal(result.schema, 2);
  assert.equal(result.exit, 0, JSON.stringify(result.findings));
  assert.equal(result.ok, true);
  assert.ok(result.data);
  return result.data;
}

function refused(result, code, exit) {
  assert.equal(result.exit, exit ?? 3, JSON.stringify(result.findings));
  assert.equal(result.ok, false);
  const finding = result.findings.find(
    (entry) => entry.severity === "error" && (!code || entry.code === code),
  );
  assert.ok(finding, `${code ?? "error"} missing: ${JSON.stringify(result.findings)}`);
  assert.ok(finding.fix);
  return result.findings;
}

/** Build a real local git repository and return its file:// remote facts. */
function gitRepo(world, name, build) {
  const repo = join(world.root, "repos", name);
  mkdirSync(repo, { recursive: true });
  build(repo, world.write);
  const git = (args) => gitAt(repo, args);
  git(["init", "--quiet", "--initial-branch=main", "."]);
  git(["config", "user.email", "fixture@test"]);
  git(["config", "user.name", "fixture"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["add", "-A"]);
  git(["commit", "--quiet", "-m", "fixture source"]);
  return { repo, url: `file://${repo}`, head: () => git(["rev-parse", "HEAD"]).trim(), git };
}

/**
 * A GitRunner seam that delegates to the real git binary while rewriting the
 * repository transport URL onto a local fixture repository: full binary
 * integration for the github-tree flow without any network. The recorded
 * calls prove git only ever sees the repository endpoint, never the tree URL.
 */
function rewritingRunner(transport, repo, calls = []) {
  return {
    async exec(args) {
      const replaced = args.map((arg) => {
        if (arg === transport) return `file://${repo}`;
        // The allowlist names the transport of the original URL; the local
        // fixture speaks file://, so the simulated fetch allows that instead.
        if (arg === "protocol.https.allow=always") return "protocol.file.allow=always";
        return arg;
      });
      calls.push([...args]);
      return execFileSync("git", replaced, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      });
    },
  };
}

const noNetworkRunner = () => ({
  async exec() {
    throw new Error("network access was attempted for an existing canonical skill");
  },
});

const stubRunner = (text) => ({
  async exec() {
    return text;
  },
});

function findingOf(error, code) {
  const findings = error?.findings ?? [];
  assert.ok(
    findings.some((finding) => finding.code === code),
    `${code} missing: ${JSON.stringify(findings)}`,
  );
  return findings;
}

const GITHUB_TREE_URL =
  "https://github.com/fixture-owner/diagram-design/tree/main/skills/diagram-design";
const REPO_TRANSPORT = "https://github.com/fixture-owner/diagram-design.git";

function diagramDesignRepo(world) {
  return gitRepo(world, "diagram-design", (repo, write) => {
    write(join(repo, "README.md"), "# diagram-design source repository\n");
    write(
      join(repo, "skills", "diagram-design", "SKILL.md"),
      "---\nname: diagram-design\ndescription: Fixture diagram skill\n---\n\n# diagram-design\n",
    );
    write(
      join(repo, "skills", "diagram-design", "assets", "shapes.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
    );
    write(
      join(repo, "skills", "diagram-design", "references", "guide.md"),
      "Diagram reference guide\n",
    );
    write(join(repo, "skills", "diagram-design", "scripts", "render.py"), "print('diagram')\n");
    write(join(repo, "skills", "unrelated", "SKILL.md"), "# unrelated\n");
  });
}

it("classifies source locations and derives provisional names", () => {
  const tree = parseSourceLocation(GITHUB_TREE_URL);
  assert.equal(tree.kind, "github-tree");
  assert.equal(tree.owner, "fixture-owner");
  assert.equal(tree.repo, "diagram-design");
  assert.deepEqual(tree.segments, ["main", "skills", "diagram-design"]);
  assert.equal(provisionalSkillName(tree), "diagram-design");

  const refOnly = parseSourceLocation("https://github.com/fixture-owner/diagram-design/tree/main");
  assert.equal(provisionalSkillName(refOnly), "diagram-design");

  const trailing = parseSourceLocation(`${GITHUB_TREE_URL}/`);
  assert.deepEqual(trailing.segments, ["main", "skills", "diagram-design"]);

  const bare = parseSourceLocation("https://github.com/fixture-owner/diagram-design");
  assert.equal(bare.kind, "git");
  assert.equal(provisionalSkillName(bare), "diagram-design");

  const bareGit = parseSourceLocation("https://github.com/fixture-owner/diagram-design.git");
  assert.equal(bareGit.kind, "git");
  assert.equal(provisionalSkillName(bareGit), "diagram-design");

  const ssh = parseSourceLocation("git@github.com:fixture-owner/diagram-design.git");
  assert.equal(ssh.kind, "git");
  assert.equal(provisionalSkillName(ssh), "diagram-design");

  const file = parseSourceLocation("file:///tmp/fixture/diagram-design");
  assert.equal(file.kind, "git");
  assert.equal(provisionalSkillName(file), "diagram-design");

  const other = parseSourceLocation("https://gitlab.com/fixture-owner/diagram-design.git");
  assert.equal(other.kind, "git");
  assert.equal(provisionalSkillName(other), "diagram-design");

  assert.equal(provisionalSkillName(parseSourceLocation("./sources/local-skill")), "local-skill");

  assert.throws(
    () => parseSourceLocation(`${GITHUB_TREE_URL.replace("/tree/", "/blob/")}`),
    (error) => {
      findingOf(error, "E_IMPORT_SOURCE");
      return true;
    },
  );
});

it("resolves slash-bearing refs by longest matching prefix", async () => {
  const slash = "6a6a".padEnd(40, "0");
  const listing = [
    `ref: refs/heads/main\tHEAD`,
    `${slash}\tHEAD`,
    `${slash}\trefs/heads/main`,
    `${slash}\trefs/heads/release/1.0`,
  ].join("\n");
  const resolved = await resolveTreeLocation(
    stubRunner(listing),
    GITHUB_TREE_URL.replace("/main/", "/release/1.0/"),
    ["release", "1.0", "skills", "diagram-design"],
  );
  assert.equal(resolved.ref, "release/1.0");
  assert.equal(resolved.commit, slash);
  assert.equal(resolved.path, "skills/diagram-design");
});

it("resolves when a branch and tag share a name and commit", async () => {
  const commit = "b".repeat(40);
  const listing = [
    `${commit}\trefs/heads/main`,
    `${commit}\trefs/tags/main`,
    `${commit}\trefs/tags/main^{}`,
  ].join("\n");
  const resolved = await resolveTreeLocation(stubRunner(listing), GITHUB_TREE_URL, [
    "main",
    "skills",
    "diagram-design",
  ]);
  assert.equal(resolved.ref, "main");
  assert.equal(resolved.commit, commit);
  assert.equal(resolved.path, "skills/diagram-design");
});

it("refuses an ambiguous ref/path boundary instead of guessing", async () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const listing = [`${a}\trefs/heads/main`, `${b}\trefs/heads/main/skills`].join("\n");
  await assert.rejects(
    resolveTreeLocation(stubRunner(listing), GITHUB_TREE_URL, ["main", "skills", "diagram-design"]),
    (error) => {
      findingOf(error, "E_IMPORT_REF_AMBIGUOUS");
      return true;
    },
  );
});

it("refuses refs the source does not have", async () => {
  const listing = [`${"c".repeat(40)}\trefs/heads/trunk`].join("\n");
  await assert.rejects(
    resolveTreeLocation(stubRunner(listing), GITHUB_TREE_URL, ["main", "skills", "diagram-design"]),
    (error) => {
      findingOf(error, "E_IMPORT_REF_NOT_FOUND");
      return true;
    },
  );
});

it("honors an explicit ref and refuses one that does not prefix the URL path", async () => {
  const tag = "d".repeat(40);
  const listing = [`${tag}\trefs/tags/v1`, `${"e".repeat(40)}\trefs/heads/main`].join("\n");
  const resolved = await resolveTreeLocation(
    stubRunner(listing),
    GITHUB_TREE_URL,
    ["main", "skills", "diagram-design"],
    { ref: "main" },
  );
  assert.equal(resolved.ref, "main");
  assert.equal(resolved.path, "skills/diagram-design");
  await assert.rejects(
    resolveTreeLocation(
      stubRunner(listing),
      GITHUB_TREE_URL,
      ["main", "skills", "diagram-design"],
      {
        ref: "v1",
      },
    ),
    (error) => {
      findingOf(error, "E_IMPORT_SOURCE");
      return true;
    },
  );
  await assert.rejects(
    resolveTreeLocation(
      stubRunner(listing),
      GITHUB_TREE_URL,
      ["main", "skills", "diagram-design"],
      {
        ref: "missing",
      },
    ),
    (error) => {
      findingOf(error, "E_IMPORT_REF_NOT_FOUND");
      return true;
    },
  );
});

it("imports a github tree subtree with support files, provenance, and no clone residue", async (t) => {
  const world = makeWorld(t);
  const repo = diagramDesignRepo(world);
  const calls = [];
  const data = ok(
    await importSkillFromSource(GITHUB_TREE_URL, {
      ...world.options,
      git: rewritingRunner(REPO_TRANSPORT, repo.repo, calls),
    }),
  );
  assert.equal(data.name, "diagram-design");
  assert.equal(data.imported, true);
  assert.equal(data.reused, false);
  assert.equal(data.source.kind, "github-tree");
  assert.equal(data.source.repo, "fixture-owner/diagram-design");
  assert.equal(data.source.ref, "main");
  assert.equal(data.source.commit, repo.head());
  assert.equal(data.source.subtree, "skills/diagram-design");
  const canonical = join(world.registry, "all-skills", "diagram-design");
  assert.equal(readFileSync(join(canonical, "SKILL.md"), "utf8").includes("diagram-design"), true);
  assert.equal(
    readFileSync(join(canonical, "assets", "shapes.svg"), "utf8"),
    '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
  );
  assert.equal(
    readFileSync(join(canonical, "references", "guide.md"), "utf8"),
    "Diagram reference guide\n",
  );
  assert.equal(readFileSync(join(canonical, "scripts", "render.py"), "utf8"), "print('diagram')\n");
  assert.equal(existsSync(join(canonical, ".git")), false, "no gitlink or clone metadata lands");
  const receipt = readFileSync(join(canonical, ".source.yaml"), "utf8");
  assert.match(
    receipt,
    /imported_from: .*github\.com\/fixture-owner\/diagram-design\/tree\/main\/skills\/diagram-design#/,
  );
  assert.match(receipt, new RegExp(repo.head()));
  assert.notEqual(
    existsSync(join(canonical, "unrelated")),
    true,
    "only the selected subtree copies",
  );
  assert.ok(calls.some((args) => args.includes("ls-remote")));
  assert.ok(calls.some((args) => args.includes("clone") && args.includes("--depth")));
  // Git only ever sees the repository endpoint; the tree URL is provenance.
  assert.ok(calls.some((args) => args.includes("ls-remote") && args.includes(REPO_TRANSPORT)));
  assert.ok(calls.some((args) => args.includes("clone") && args.includes(REPO_TRANSPORT)));
  for (const call of calls) {
    assert.equal(call.includes(GITHUB_TREE_URL), false, "the tree URL never reaches git");
    assert.equal(
      call.some((arg) => typeof arg === "string" && arg.includes("/tree/")),
      false,
      "no tree-shaped URL reaches git",
    );
  }
});

it("re-importing identical content is a disclosed no-op", async (t) => {
  const world = makeWorld(t);
  const repo = diagramDesignRepo(world);
  const runner = { git: rewritingRunner(REPO_TRANSPORT, repo.repo) };
  ok(await importSkillFromSource(GITHUB_TREE_URL, { ...world.options, ...runner }));
  const catalog = join(world.registry, "all-skills");
  const result = await unchanged([catalog], () =>
    importSkillFromSource(GITHUB_TREE_URL, { ...world.options, ...runner }),
  );
  const data = ok(result);
  assert.equal(data.imported, false);
  assert.equal(data.reused, true);
  assert.deepEqual(data.changes, []);
  assert.ok(
    result.findings.some((finding) => finding.code === "I_IMPORT_REUSED"),
    JSON.stringify(result.findings),
  );
});

it("refuses to overwrite a same-named canonical with different content", async (t) => {
  const world = makeWorld(t);
  const repo = diagramDesignRepo(world);
  const canonical = join(world.registry, "all-skills", "diagram-design");
  world.write(
    join(canonical, "SKILL.md"),
    "---\nname: diagram-design\ndescription: pre-existing\n---\n\n# different\n",
  );
  const catalog = join(world.registry, "all-skills");
  const result = await unchanged([catalog], () =>
    importSkillFromSource(GITHUB_TREE_URL, {
      ...world.options,
      git: rewritingRunner(REPO_TRANSPORT, repo.repo),
    }),
  );
  refused(result, "E_IMPORT_NAME_CONFLICT");
  assert.equal(
    readFileSync(join(canonical, "SKILL.md"), "utf8").includes("pre-existing"),
    true,
    "canonical bytes are preserved",
  );
});

it("dry-run plans the catalog copy without writing anything", async (t) => {
  const world = makeWorld(t);
  const repo = diagramDesignRepo(world);
  const catalog = join(world.registry, "all-skills");
  const result = await unchanged([catalog], () =>
    importSkillFromSource(GITHUB_TREE_URL, {
      ...world.options,
      dryRun: true,
      git: rewritingRunner(REPO_TRANSPORT, repo.repo),
    }),
  );
  const data = ok(result);
  assert.equal(data.dryRun, true);
  assert.equal(data.imported, false);
  assert.ok(data.changes.some((change) => change.action === "create-directory"));
  assert.ok(data.changes.some((change) => change.action === "copy-file"));
  assert.notEqual(existsSync(join(catalog, "diagram-design")), true);
});

it("imports a local directory through the same guarded path", async (t) => {
  const world = makeWorld(t);
  world.write(join(world.root, "sources", "local-skill", "SKILL.md"), "# local\n");
  world.write(join(world.root, "sources", "local-skill", "notes", "a.md"), "support\n");
  const data = ok(
    await importSkillFromSource(join(world.root, "sources", "local-skill"), world.options),
  );
  assert.equal(data.name, "local-skill");
  assert.equal(data.imported, true);
  assert.equal(data.source.kind, "path");
  const canonical = join(world.registry, "all-skills", "local-skill");
  assert.equal(readFileSync(join(canonical, "notes", "a.md"), "utf8"), "support\n");
  assert.match(
    readFileSync(join(canonical, ".source.yaml"), "utf8"),
    /imported_from: .*sources\/local-skill/,
  );
});

it("imports a plain git remote root and pins the resolved commit", async (t) => {
  const world = makeWorld(t);
  const repo = gitRepo(world, "root-skill", (repo, write) => {
    write(join(repo, "SKILL.md"), "# root-skill\n");
    write(join(repo, "support.md"), "support\n");
  });
  const data = ok(await importSkillFromSource(repo.url, world.options));
  assert.equal(data.name, "root-skill");
  assert.equal(data.source.kind, "git");
  assert.equal(data.source.commit, repo.head());
  assert.equal(data.source.subtree, "");
  assert.equal(data.source.ref, "main");
  const receipt = readFileSync(
    join(world.registry, "all-skills", "root-skill", ".source.yaml"),
    "utf8",
  );
  assert.match(receipt, new RegExp(`file://\\S+root-skill#${repo.head()}`));
});

it("resolves an annotated tag to its peeled commit", async (t) => {
  const world = makeWorld(t);
  const repo = diagramDesignRepo(world);
  repo.git(["tag", "-a", "v1", "-m", "annotated"]);
  const tagUrl = "https://github.com/fixture-owner/diagram-design/tree/v1/skills/diagram-design";
  const data = ok(
    await importSkillFromSource(tagUrl, {
      ...world.options,
      ref: "v1",
      git: rewritingRunner(REPO_TRANSPORT, repo.repo),
    }),
  );
  assert.equal(data.source.ref, "v1");
  // A clone of the tag checks out the peeled commit, not the tag object.
  assert.equal(data.source.commit, repo.head());
});

it("accepts an authenticated URL but never persists its credentials", async (t) => {
  const world = makeWorld(t);
  const repo = diagramDesignRepo(world);
  const authed =
    "https://token-user:secret-token@github.com/fixture-owner/diagram-design/tree/main/skills/diagram-design";
  const authedTransport =
    "https://token-user:secret-token@github.com/fixture-owner/diagram-design.git";
  const calls = [];
  const data = ok(
    await importSkillFromSource(authed, {
      ...world.options,
      git: rewritingRunner(authedTransport, repo.repo, calls),
    }),
  );
  assert.equal(data.source.kind, "github-tree");
  assert.equal(data.source.subtree, "skills/diagram-design");
  assert.equal(data.source.label.includes("secret-token"), false);
  // Transport keeps the credentials; only the repository endpoint is used.
  assert.ok(calls.some((args) => args.includes("clone") && args.includes(authedTransport)));
  for (const call of calls)
    assert.equal(call.includes(authed), false, "the tree URL never reaches git");
  const receipt = readFileSync(
    join(world.registry, "all-skills", "diagram-design", ".source.yaml"),
    "utf8",
  );
  assert.equal(receipt.includes("secret-token"), false);
  assert.match(receipt, /https:\/\/\[redacted\]@github\.com\//);
});

it("sanitizes clone failures that echo the transport credentials", async (t) => {
  const world = makeWorld(t);
  const commit = "1".repeat(40);
  const transport = "https://user:leaked-pass@github.com/fixture-owner/diagram-design.git";
  const failing = {
    async exec(args) {
      if (args.includes("ls-remote"))
        return `ref: refs/heads/main\tHEAD\n${commit}\tHEAD\n${commit}\trefs/heads/main\n`;
      throw new Error(`Command failed: git clone ${transport} 'repository not found'`);
    },
  };
  const result = await importSkillFromSource(GITHUB_TREE_URL, {
    ...world.options,
    git: failing,
  });
  refused(result, "E_SOURCE_ACQUIRE");
  assert.equal(JSON.stringify(result.findings).includes("leaked-pass"), false);
  assert.ok(JSON.stringify(result.findings).includes("[redacted]"));
});

it("refuses traversal and encoded-separator tree path components", async (t) => {
  const world = makeWorld(t);
  for (const suffix of [
    "/../diagram-design",
    "/%2e%2e/diagram-design",
    "/diagram%2Fdesign",
    "/.",
  ]) {
    const url = `https://github.com/fixture-owner/diagram-design/tree/main/skills${suffix}`;
    const result = await importSkillFromSource(url, world.options);
    refused(result, "E_IMPORT_SOURCE", 2);
  }
  assert.notEqual(
    existsSync(join(world.registry, "all-skills", "diagram-design")),
    true,
    "a refused traversal imports nothing",
  );
  // Percent-encoded safe characters decode to the real checkout path.
  const tree = parseSourceLocation(
    "https://github.com/fixture-owner/diagram-design/tree/main/skills/diagram%20design",
  );
  assert.deepEqual(tree.segments, ["main", "skills", "diagram design"]);
});

it("refuses a subtree that does not exist or carries no SKILL.md", async (t) => {
  const world = makeWorld(t);
  const repo = diagramDesignRepo(world);
  const missing = "https://github.com/fixture-owner/diagram-design/tree/main/skills/absent";
  refused(
    await importSkillFromSource(missing, {
      ...world.options,
      git: rewritingRunner(REPO_TRANSPORT, repo.repo),
    }),
    "E_IMPORT_SUBTREE_MISSING",
  );
  const root = "https://github.com/fixture-owner/diagram-design/tree/main";
  refused(
    await importSkillFromSource(root, {
      ...world.options,
      git: rewritingRunner(REPO_TRANSPORT, repo.repo),
    }),
    "E_IMPORT_SUBTREE_SKILL",
  );
  assert.notEqual(
    existsSync(join(world.registry, "all-skills", "diagram-design")),
    true,
    "a refused source imports nothing",
  );
});

it("refuses when the source moves between resolution and clone", async (t) => {
  const world = makeWorld(t);
  const repo = diagramDesignRepo(world);
  const stale = "f".repeat(40);
  const drifting = {
    async exec(args) {
      if (args.includes("ls-remote"))
        return `ref: refs/heads/main\tHEAD\n${stale}\tHEAD\n${stale}\trefs/heads/main\n`;
      return execFileSync(
        "git",
        args.map((arg) => {
          if (arg === REPO_TRANSPORT) return `file://${repo.repo}`;
          if (arg === "protocol.https.allow=always") return "protocol.file.allow=always";
          return arg;
        }),
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
      );
    },
  };
  refused(
    await importSkillFromSource(GITHUB_TREE_URL, { ...world.options, git: drifting }),
    "E_SOURCE_CHANGED",
  );
});

it("refuses a name collision with a non-directory canonical entry", async (t) => {
  const world = makeWorld(t);
  world.write(join(world.registry, "all-skills", "diagram-design"), "not a directory");
  const repo = diagramDesignRepo(world);
  refused(
    await importSkillFromSource(GITHUB_TREE_URL, {
      ...world.options,
      git: rewritingRunner(REPO_TRANSPORT, repo.repo),
    }),
    "E_NONCANONICAL_REFERENCE",
  );
});

function projectWorld(t) {
  const world = makeWorld(t);
  const project = join(world.root, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  const nested = join(project, "src", "deep");
  mkdirSync(nested, { recursive: true });
  return { ...world, project, nested, projectOptions: { ...world.options, cwd: nested } };
}

function seedCanonical(world, name, body = `# ${name}\n`) {
  world.write(join(world.registry, "all-skills", name, "SKILL.md"), body);
  return join(world.registry, "all-skills", name);
}

it("add reuses an existing canonical skill without any network access", async (t) => {
  const world = projectWorld(t);
  seedCanonical(
    world,
    "diagram-design",
    "---\nname: diagram-design\ndescription: seeded\n---\n\n# seeded\n",
  );
  const result = await addSkillFromSource(GITHUB_TREE_URL, {
    ...world.projectOptions,
    git: noNetworkRunner(),
  });
  const data = ok(result);
  assert.equal(data.reused, true);
  assert.equal(data.imported, false);
  assert.equal(data.scope, "project");
  assert.equal(data.root, world.project);
  assert.equal(data.manifestCreated, true);
  assert.equal(data.activation.status, "applied");
  assert.ok(
    result.findings.some((finding) => finding.code === "I_ADD_REUSED"),
    JSON.stringify(result.findings),
  );
  const manifest = JSON.parse(readFileSync(join(world.project, ".agents", "skills.json"), "utf8"));
  assert.deepEqual(manifest.skills, ["diagram-design"]);
  assert.equal(
    realpathSync(join(world.project, ".agents", "skills", "diagram-design")),
    join(world.registry, "all-skills", "diagram-design"),
  );
});

it("add initializes a manifest-less checkout and enables the imported skill in it", async (t) => {
  const world = projectWorld(t);
  const repo = diagramDesignRepo(world);
  const data = ok(
    await addSkillFromSource(GITHUB_TREE_URL, {
      ...world.projectOptions,
      git: rewritingRunner(REPO_TRANSPORT, repo.repo),
    }),
  );
  assert.equal(data.imported, true);
  assert.equal(data.reused, false);
  assert.equal(data.scope, "project");
  assert.equal(data.root, world.project, "the checkout root, not the nested cwd, is the scope");
  assert.equal(data.manifestCreated, true);
  assert.equal(data.activation.status, "applied");
  assert.equal(
    realpathSync(join(world.project, ".agents", "skills", "diagram-design")),
    join(world.registry, "all-skills", "diagram-design"),
  );
  assert.notEqual(
    existsSync(join(world.home, ".agents", "skills.json")),
    true,
    "global scope is not touched from inside a project",
  );
});

it("add honors an explicit --project over the current directory", async (t) => {
  const world = projectWorld(t);
  // The cwd is itself a project with a valid manifest: only the pinned
  // preflight target may receive the skill, never the cwd's scope.
  world.write(join(world.project, ".agents", "skills.json"), '{"skills":[]}\n');
  const other = join(world.root, "other-project");
  mkdirSync(other, { recursive: true });
  world.write(join(other, ".agents", "skills.json"), '{"skills":[]}\n');
  const repo = diagramDesignRepo(world);
  const data = ok(
    await addSkillFromSource(GITHUB_TREE_URL, {
      ...world.options,
      cwd: join(world.project, "src"),
      project: other,
      git: rewritingRunner(REPO_TRANSPORT, repo.repo),
    }),
  );
  assert.equal(data.scope, "project");
  assert.equal(data.root, other);
  assert.deepEqual(JSON.parse(readFileSync(join(other, ".agents", "skills.json"), "utf8")).skills, [
    "diagram-design",
  ]);
  assert.deepEqual(
    JSON.parse(readFileSync(join(world.project, ".agents", "skills.json"), "utf8")).skills,
    [],
    "the cwd project stays untouched",
  );
});

it("add refuses a manifest the selection machinery cannot consume before importing", async (t) => {
  const world = projectWorld(t);
  // Legacy plural sets: the declaration needs normalize first, and nothing
  // may be fetched or imported until it is valid.
  world.write(join(world.project, ".agents", "skills.json"), '{"sets":["legacy"]}\n');
  const repo = diagramDesignRepo(world);
  const calls = [];
  const catalog = join(world.registry, "all-skills");
  const result = await unchanged([catalog], () =>
    addSkillFromSource(GITHUB_TREE_URL, {
      ...world.projectOptions,
      git: rewritingRunner(REPO_TRANSPORT, repo.repo, calls),
    }),
  );
  refused(result, "E_MANIFEST_INVALID", 2);
  assert.match(
    JSON.stringify(result.findings),
    /E_LEGACY_FIELD/,
    "the preflight surfaces the underlying legacy finding",
  );
  assert.equal(calls.length, 0, "preflight refuses before any acquisition");
});

it("add -g selects the global scope", async (t) => {
  const world = projectWorld(t);
  const repo = diagramDesignRepo(world);
  const data = ok(
    await addSkillFromSource(GITHUB_TREE_URL, {
      ...world.projectOptions,
      global: true,
      git: rewritingRunner(REPO_TRANSPORT, repo.repo),
    }),
  );
  assert.equal(data.scope, "global");
  assert.equal(data.root, world.home);
  assert.deepEqual(
    JSON.parse(readFileSync(join(world.home, ".agents", "skills.json"), "utf8")).skills,
    ["diagram-design"],
  );
  assert.equal(
    realpathSync(join(world.home, ".agents", "skills", "diagram-design")),
    join(world.registry, "all-skills", "diagram-design"),
  );
  assert.notEqual(
    existsSync(join(world.project, ".agents")),
    true,
    "the project scope is untouched by -g",
  );
});

it("add rejects -p with -g before acquiring anything", async (t) => {
  const world = projectWorld(t);
  const catalog = join(world.registry, "all-skills");
  const result = await unchanged([catalog, world.project, world.home], () =>
    addSkillFromSource(GITHUB_TREE_URL, {
      ...world.projectOptions,
      project: world.project,
      global: true,
      git: noNetworkRunner(),
    }),
  );
  refused(result, "E_SCOPE", 2);
});

it("add outside any project or checkout selects the global scope", async (t) => {
  const world = makeWorld(t);
  const outside = join(world.root, "plain-dir");
  mkdirSync(outside, { recursive: true });
  const repo = diagramDesignRepo(world);
  const data = ok(
    await addSkillFromSource(GITHUB_TREE_URL, {
      ...world.options,
      cwd: outside,
      git: rewritingRunner(REPO_TRANSPORT, repo.repo),
    }),
  );
  assert.equal(data.scope, "global");
  assert.deepEqual(
    JSON.parse(readFileSync(join(world.home, ".agents", "skills.json"), "utf8")).skills,
    ["diagram-design"],
  );
});

it("add reports PARTIAL when the import lands but activation fails, and a retry reuses it", async (t) => {
  const world = projectWorld(t);
  // A valid manifest selecting a set the registry does not have: the scope is
  // fine, the import lands, and enabling refuses only afterwards.
  world.write(join(world.project, ".agents", "skills.json"), '{"set":"missing-set"}\n');
  const repo = diagramDesignRepo(world);
  const partial = await addSkillFromSource(GITHUB_TREE_URL, {
    ...world.projectOptions,
    git: rewritingRunner(REPO_TRANSPORT, repo.repo),
  });
  assert.equal(partial.exit, 4);
  assert.equal(partial.ok, false);
  assert.equal(partial.data.imported, true);
  assert.equal(partial.data.activation.status, "failed");
  assert.ok(
    partial.findings.some((finding) => finding.code === "E_ADD_PARTIAL"),
    JSON.stringify(partial.findings),
  );
  assert.ok(
    partial.findings.some(
      (finding) => finding.severity === "error" && finding.code !== "E_ADD_PARTIAL",
    ),
    JSON.stringify(partial.findings),
  );
  assert.ok(
    existsSync(join(world.registry, "all-skills", "diagram-design", "SKILL.md")),
    "the imported definition survives, truthfully disclosed",
  );
  // Retry after repairing the manifest: the catalog is reused, no fetching.
  world.write(join(world.project, ".agents", "skills.json"), '{"skills":[]}\n');
  const retried = ok(
    await addSkillFromSource(GITHUB_TREE_URL, {
      ...world.projectOptions,
      git: noNetworkRunner(),
    }),
  );
  assert.equal(retried.reused, true);
  assert.equal(retried.imported, false);
  assert.equal(retried.activation.status, "applied");
  assert.equal(
    realpathSync(join(world.project, ".agents", "skills", "diagram-design")),
    join(world.registry, "all-skills", "diagram-design"),
  );
});

it("add dry-run stages an honest plan and writes nothing", async (t) => {
  const world = projectWorld(t);
  const repo = diagramDesignRepo(world);
  const catalog = join(world.registry, "all-skills");
  const result = await unchanged([catalog, world.project, world.home], () =>
    addSkillFromSource(GITHUB_TREE_URL, {
      ...world.projectOptions,
      dryRun: true,
      git: rewritingRunner(REPO_TRANSPORT, repo.repo),
    }),
  );
  const data = ok(result);
  assert.equal(data.imported, false);
  assert.equal(data.dryRun, true);
  assert.equal(data.activation.status, "deferred");
  assert.equal(data.activation.reason, "canonical-not-imported");
  assert.deepEqual(data.activation.stages, ["init", "enable"]);
  assert.ok(
    data.changes.some((change) => change.action === "copy-file"),
    "import plan is staged",
  );
  assert.ok(
    data.activation.changes.some((change) => change.action === "write-manifest"),
    "the would-be init is planned",
  );
  assert.ok(
    result.findings.some((finding) => finding.code === "W_ADD_ACTIVATION_DEFERRED"),
    JSON.stringify(result.findings),
  );
  assert.notEqual(existsSync(join(world.project, ".agents")), true);
});

it("add dry-run fully preflights activation once the canonical exists", async (t) => {
  const world = projectWorld(t);
  seedCanonical(
    world,
    "diagram-design",
    "---\nname: diagram-design\ndescription: seeded\n---\n\n# seeded\n",
  );
  world.write(join(world.project, ".agents", "skills.json"), '{"skills":[]}\n');
  const result = await unchanged(
    [join(world.registry, "all-skills"), world.project, world.home],
    () =>
      addSkillFromSource(GITHUB_TREE_URL, {
        ...world.projectOptions,
        dryRun: true,
        git: noNetworkRunner(),
      }),
  );
  const data = ok(result);
  assert.equal(data.reused, true);
  assert.equal(data.activation.status, "planned");
  assert.deepEqual(data.activation.stages, ["enable"]);
  assert.ok(
    data.activation.changes.some((change) => change.action === "write-manifest"),
    "enable plan is concrete",
  );
  assert.equal(
    JSON.parse(readFileSync(join(world.project, ".agents", "skills.json"), "utf8")).skills.length,
    0,
    "the manifest is not written by a dry-run",
  );
});

it("add dry-run defers enable when the scope manifest does not exist yet", async (t) => {
  const world = projectWorld(t);
  seedCanonical(
    world,
    "diagram-design",
    "---\nname: diagram-design\ndescription: seeded\n---\n\n# seeded\n",
  );
  const result = await unchanged([world.project], () =>
    addSkillFromSource(GITHUB_TREE_URL, {
      ...world.projectOptions,
      dryRun: true,
      git: noNetworkRunner(),
    }),
  );
  const data = ok(result);
  assert.equal(data.activation.status, "deferred");
  assert.equal(data.activation.reason, "manifest-missing");
  assert.ok(
    data.activation.changes.some((change) => change.action === "write-manifest"),
    "init is planned, enable is deferred",
  );
});
