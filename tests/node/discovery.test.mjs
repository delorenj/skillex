import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import test from "node:test";
import {
  discoverRegistry,
  discoverScopes,
  resolveSelection,
  SkillexError,
} from "@delorenj/skillex";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "skillex-discovery-")));
  const home = join(root, "home");
  const cwd = join(home, "work", "project");
  await mkdir(cwd, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    home,
    cwd,
    scopes: { home, cwd },
    registry: { home, cwd, env: {}, installedRoot: join(root, "uninstalled") },
  };
}

async function manifest(root, text = "{}") {
  const path = join(root, ".agents", "skills.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return path;
}

async function checkout(root) {
  await mkdir(join(root, "all-skills"), { recursive: true });
  return root;
}

function failure(code) {
  return (error) => {
    assert.ok(error instanceof SkillexError);
    assert.ok(error.findings.some((finding) => finding.code === code));
    assert.ok(error.findings.every((finding) => finding.fix));
    return true;
  };
}

async function snapshot(root) {
  const result = {};
  const visit = async (path, name) => {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) result[name] = { link: await readlink(path) };
    else if (entry.isDirectory()) {
      result[name] = { directory: true, mode: entry.mode };
      for (const child of (await readdir(path)).sort())
        await visit(join(path, child), join(name, child));
    } else result[name] = { bytes: (await readFile(path)).toString("base64"), mode: entry.mode };
  };
  await visit(root, ".");
  return result;
}

test("nested cwd selects the nearest project and global write scopes", async (t) => {
  const f = await fixture(t);
  const projectPath = await manifest(f.cwd);
  await manifest(join(f.home, "work"));
  const nested = join(f.cwd, "src", "commands");
  await mkdir(nested, { recursive: true });
  const result = await discoverScopes({ ...f.scopes, cwd: nested });
  assert.deepEqual(result.project, {
    scope: "project",
    root: f.cwd,
    path: projectPath,
    exists: true,
  });
  assert.deepEqual(result.writeScopes, ["global", "project"]);
  assert.equal(result.global.root, f.home);
  assert.equal(result.global.exists, false);
});

test("project-only writes retain the global inheritance source", async (t) => {
  const f = await fixture(t);
  const globalPath = await manifest(f.home);
  await manifest(f.cwd);
  const result = await discoverScopes({ ...f.scopes, scope: "project" });
  assert.deepEqual(result.writeScopes, ["project"]);
  assert.deepEqual(result.global, {
    scope: "global",
    root: f.home,
    path: globalPath,
    exists: true,
  });
});

test("global-only discovery ignores project paths and nested manifest errors", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.cwd, ".agents", "skills.json"), { recursive: true });
  const result = await discoverScopes({
    ...f.scopes,
    scope: "global",
    cwd: join(f.root, "missing-cwd"),
    project: join(f.root, "missing-project"),
  });
  assert.equal(result.project, undefined);
  assert.deepEqual(result.writeScopes, ["global"]);
});

for (const mode of ["independent", "pack"]) {
  for (const brokenGlobal of ["directory", "broken-link", "non-directory-parent"]) {
    test(`${mode} project defers dormant global ${brokenGlobal} validation`, async (t) => {
      const f = await fixture(t);
      const registryRoot = await checkout(join(f.root, "registry"));
      const skill = join(registryRoot, "all-skills", "local");
      await mkdir(skill);
      await writeFile(join(skill, "SKILL.md"), "---\nname: local\ndescription: Fixture\n---\n");
      if (mode === "pack") {
        const pack = join(registryRoot, "packs", "chosen", "1.0.0");
        await mkdir(pack, { recursive: true });
        await writeFile(
          join(pack, "pack.toml"),
          '[pack]\nname = "chosen"\nversion = "1.0.0"\n[freeform]\nskills = ["local"]\n',
        );
      }
      await manifest(
        f.cwd,
        JSON.stringify(
          mode === "pack"
            ? { packs: ["chosen@1.0.0"] }
            : { inherit_global: false, skills: ["local"] },
        ),
      );
      const globalPath = join(f.home, ".agents", "skills.json");
      if (brokenGlobal === "non-directory-parent") {
        await writeFile(dirname(globalPath), "not a directory");
      } else {
        await mkdir(dirname(globalPath));
        if (brokenGlobal === "directory") await mkdir(globalPath);
        else await symlink(join(f.root, "missing-global-manifest"), globalPath);
      }
      const before = await snapshot(f.root);
      const options = { ...f.registry, registryRoot, scope: "project" };
      const discovery = await discoverScopes(options);
      assert.equal(discovery.global.exists, true);
      const result = await resolveSelection(options);
      assert.equal(result.exit, 0, JSON.stringify(result.findings));
      assert.deepEqual(result.data.writeScopes, ["project"]);
      assert.deepEqual(
        result.data.scopes.map((scope) => scope.scope),
        ["project"],
      );
      assert.deepEqual(
        result.data.scopes[0].bindings.map((binding) => binding.name),
        ["local"],
      );
      // The same broken input remains a failure when global becomes a write target.
      const requiredGlobal = await resolveSelection({ ...options, scope: "both" });
      assert.equal(requiredGlobal.ok, false);
      assert.ok(
        requiredGlobal.findings.some((finding) =>
          ["E_MANIFEST_INVALID", "E_MANIFEST_MISSING"].includes(finding.code),
        ),
        JSON.stringify(requiredGlobal.findings),
      );
      assert.deepEqual(await snapshot(f.root), before);
    });
  }
}

test("HOME's manifest is never adopted as a project", async (t) => {
  const f = await fixture(t);
  await manifest(f.home);
  const result = await discoverScopes(f.scopes);
  assert.equal(result.project, undefined);
  assert.deepEqual(result.writeScopes, ["global"]);
});

for (const gitKind of ["directory", "file"]) {
  test(`a nested .git ${gitKind} prevents adopting the outer manifest`, async (t) => {
    const f = await fixture(t);
    await manifest(f.cwd);
    const nested = join(f.cwd, "nested");
    await mkdir(join(nested, "src"), { recursive: true });
    if (gitKind === "file") await writeFile(join(nested, ".git"), "gitdir: /unused/metadata\n");
    else await mkdir(join(nested, ".git"));
    const result = await discoverScopes({ ...f.scopes, cwd: join(nested, "src") });
    assert.equal(result.project, undefined);
    assert.deepEqual(result.writeScopes, ["global"]);
    await manifest(nested);
    const own = await discoverScopes({ ...f.scopes, cwd: join(nested, "src") });
    assert.equal(own.project.root, nested);
  });
}

test("explicit project selects its own root instead of searching ancestors", async (t) => {
  const f = await fixture(t);
  await manifest(f.cwd);
  const chosen = join(f.home, "chosen");
  await manifest(chosen);
  const result = await discoverScopes({ ...f.scopes, project: "../../chosen", scope: "both" });
  assert.equal(result.project.root, chosen);
  assert.deepEqual(result.writeScopes, ["global", "project"]);
  await assert.rejects(
    discoverScopes({ ...f.scopes, project: ".agents" }),
    failure("E_NO_PROJECT_MANIFEST"),
  );
});

test("explicit project errors distinguish a missing directory and manifest", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    discoverScopes({ ...f.scopes, project: "missing" }),
    failure("E_PROJECT_ROOT"),
  );
  await assert.rejects(
    discoverScopes({ ...f.scopes, project: "." }),
    failure("E_NO_PROJECT_MANIFEST"),
  );
});

test("explicit HOME and filesystem-root project targets are refused", async (t) => {
  const f = await fixture(t);
  await manifest(f.home);
  for (const project of [f.home, parse(f.root).root]) {
    await assert.rejects(discoverScopes({ ...f.scopes, project }), failure("E_PROJECT_ROOT"));
  }
});

for (const scope of ["project", "both"]) {
  test(`${scope} requires a project manifest`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(discoverScopes({ ...f.scopes, scope }), failure("E_NO_PROJECT_MANIFEST"));
  });
}

test("scope discovery reports invalid manifest paths instead of walking past them", async (t) => {
  const f = await fixture(t);
  await manifest(join(f.home, "work"));
  await mkdir(join(f.cwd, ".agents", "skills.json"), { recursive: true });
  await assert.rejects(discoverScopes(f.scopes), failure("E_MANIFEST_PATH"));
});

test("scope discovery canonicalizes an explicit symlinked project root", async (t) => {
  const f = await fixture(t);
  await manifest(f.cwd);
  const alias = join(f.home, "project-alias");
  await symlink(f.cwd, alias);
  const result = await discoverScopes({ ...f.scopes, project: alias });
  assert.equal(result.project.root, f.cwd);
});

test("explicit registry root outranks environment, URL cache, and checkout", async (t) => {
  const f = await fixture(t);
  const chosen = await checkout(join(f.root, "selected"));
  const environment = await checkout(join(f.root, "environment"));
  await checkout(f.cwd);
  const result = await discoverRegistry({
    ...f.registry,
    registryRoot: chosen,
    env: { PJ_SKILLS_REGISTRY_ROOT: environment },
    registry: "https://example.test/registry.git",
  });
  assert.deepEqual(result, { root: chosen, source: "argument", searched: [chosen] });
});

test("an environment registry root is exclusive and accepts relative paths", async (t) => {
  const f = await fixture(t);
  const chosen = await checkout(join(f.cwd, "catalog"));
  await checkout(join(f.home, "code", "skillex"));
  const result = await discoverRegistry({
    ...f.registry,
    env: { PJ_SKILLS_REGISTRY_ROOT: "catalog" },
  });
  assert.deepEqual(result, { root: chosen, source: "environment", searched: [chosen] });
});

test("explicit and environment overrides never fall through when empty or incomplete", async (t) => {
  const f = await fixture(t);
  const fallback = await checkout(join(f.home, "code", "skillex"));
  for (const root of ["", "missing", f.cwd]) {
    await assert.rejects(
      discoverRegistry({
        ...f.registry,
        registryRoot: root,
        env: { PJ_SKILLS_REGISTRY_ROOT: fallback },
      }),
      failure("E_REGISTRY_ROOT"),
    );
    await assert.rejects(
      discoverRegistry({ ...f.registry, env: { PJ_SKILLS_REGISTRY_ROOT: root } }),
      failure("E_REGISTRY_ROOT"),
    );
  }
});

test("registry root supports home expansion and resolves root symlinks canonically", async (t) => {
  const f = await fixture(t);
  const chosen = await checkout(join(f.home, "catalog"));
  const alias = join(f.home, "registry-alias");
  await symlink(chosen, alias);
  const result = await discoverRegistry({ ...f.registry, registryRoot: "~/registry-alias" });
  assert.deepEqual(result, { root: chosen, source: "argument", searched: [alias] });
});

test("configured cache uses the legacy byte-compatible URL name and outranks cwd", async (t) => {
  const f = await fixture(t);
  const registry = "https://example.test/org/registry.git?ref=a-b";
  const cache = await checkout(
    join(
      f.home,
      ".agents",
      ".cache",
      "registries",
      "https___example_test_org_registry_git_ref_a_b",
    ),
  );
  await checkout(f.cwd);
  const result = await discoverRegistry({ ...f.registry, registry });
  assert.deepEqual(result, { root: cache, source: "cache", searched: [cache] });
});

test("missing configured cache falls through to a discovered enclosing checkout", async (t) => {
  const f = await fixture(t);
  await checkout(f.cwd);
  const nested = join(f.cwd, "src", "commands");
  await mkdir(nested, { recursive: true });
  const result = await discoverRegistry({
    ...f.registry,
    cwd: nested,
    registry: "https://example.test/registry.git",
  });
  assert.equal(result.root, f.cwd);
  assert.equal(result.source, "checkout");
  assert.equal(
    result.searched[0],
    join(f.home, ".agents", ".cache", "registries", "https___example_test_registry_git"),
  );
  assert.deepEqual(result.searched.slice(1), [nested, dirname(nested), f.cwd]);
});

test("installed checkout outranks the fallback checkout", async (t) => {
  const f = await fixture(t);
  const installed = await checkout(join(f.root, "installed"));
  await checkout(join(f.home, "code", "skillex"));
  const result = await discoverRegistry({ ...f.registry, installedRoot: installed });
  assert.equal(result.root, installed);
  assert.equal(result.source, "installed");
  assert.equal(result.searched.at(-1), installed);
});

test("an installed npm package without a catalog is skipped for the fallback checkout", async (t) => {
  const f = await fixture(t);
  const installed = join(f.root, "npm-package");
  await mkdir(join(installed, "dist"), { recursive: true });
  await writeFile(join(installed, "package.json"), '{"name":"@delorenj/skillex"}');
  const fallback = await checkout(join(f.home, "code", "skillex"));
  const result = await discoverRegistry({ ...f.registry, installedRoot: installed });
  assert.equal(result.root, fallback);
  assert.equal(result.source, "fallback");
  assert.deepEqual(result.searched.slice(-2), [installed, fallback]);
});

test("no local catalog reports all searched candidates without creating a cache", async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.root);
  await assert.rejects(
    discoverRegistry({ ...f.registry, registry: "https://example.test/missing.git" }),
    (error) => {
      failure("E_REGISTRY_NOT_FOUND")(error);
      const finding = error.findings[0];
      assert.equal(
        finding.detail[0],
        join(f.home, ".agents", ".cache", "registries", "https___example_test_missing_git"),
      );
      assert.equal(finding.detail.at(-1), join(f.home, "code", "skillex"));
      return true;
    },
  );
  assert.deepEqual(await snapshot(f.root), before);
});

// Real git, not a hand-written .gitmodules: a plain clone of the catalog leaves its
// all-skills submodule as an empty directory, which is exactly what a URL registry cache
// looked like when every project-selected skill reported E_SKILL_MISSING (SKRILL-22).
async function catalogRepositories(t) {
  const root = await realpath(await mkdtemp("/tmp/skillex-discovery-submodule-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const xdg = join(root, "xdg");
  await mkdir(xdg);
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    XDG_CONFIG_HOME: xdg,
    GIT_CEILING_DIRECTORIES: root,
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Catalog fixture",
    GIT_AUTHOR_EMAIL: "catalog@example.test",
    GIT_COMMITTER_NAME: "Catalog fixture",
    GIT_COMMITTER_EMAIL: "catalog@example.test",
  };
  const git = (cwd, ...args) => {
    const result = spawnSync(
      "git",
      ["-c", "protocol.file.allow=always", "-c", "commit.gpgsign=false", "-C", cwd, ...args],
      { encoding: "utf8", env },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const skills = join(root, "skills");
  await mkdir(join(skills, "alpha"), { recursive: true });
  await writeFile(join(skills, "alpha", "SKILL.md"), "---\nname: alpha\n---\n# Alpha\n");
  git(skills, "init", "-q", "-b", "main");
  git(skills, "add", ".");
  git(skills, "commit", "-q", "-m", "skills");
  const catalog = join(root, "catalog");
  await mkdir(join(catalog, "sets"), { recursive: true });
  await writeFile(join(catalog, "sets", ".keep"), "");
  git(catalog, "init", "-q", "-b", "main");
  git(catalog, "submodule", "add", "-q", skills, "all-skills");
  git(catalog, "add", ".");
  git(catalog, "commit", "-q", "-m", "catalog");
  return { root, catalog, git };
}

test("an uninitialized all-skills submodule is refused with its repair, never selected", async (t) => {
  const f = await fixture(t);
  const repos = await catalogRepositories(t);
  const registry = "https://example.test/org/catalog.git";
  const cache = join(
    f.home,
    ".agents",
    ".cache",
    "registries",
    "https___example_test_org_catalog_git",
  );
  await mkdir(dirname(cache), { recursive: true });
  repos.git(dirname(cache), "clone", "-q", repos.catalog, cache);
  assert.deepEqual(await readdir(join(cache, "all-skills")), []);
  // A complete fallback checkout exists; a broken cache must not silently fall through to it.
  await checkout(join(f.home, "code", "skillex"));
  const before = await snapshot(f.root);
  await assert.rejects(discoverRegistry({ ...f.registry, registry }), (error) => {
    failure("E_REGISTRY_ROOT")(error);
    const [finding] = error.findings;
    assert.equal(finding.path, join(cache, "all-skills"));
    assert.match(finding.message, /uninitialized git submodule/);
    assert.match(finding.fix, /pull --ff-only/);
    assert.match(finding.fix, /submodule update --init --recursive/);
    return true;
  });
  await assert.rejects(discoverRegistry({ ...f.registry, registryRoot: cache }), (error) => {
    failure("E_REGISTRY_ROOT")(error);
    assert.match(error.findings[0].fix, /submodule update --init --recursive/);
    assert.doesNotMatch(error.findings[0].fix, /pull --ff-only/);
    return true;
  });
  assert.deepEqual(await snapshot(f.root), before);

  // The repair the fix names is sufficient: the cache becomes the selected, populated catalog.
  repos.git(cache, "submodule", "update", "-q", "--init", "--recursive");
  const result = await discoverRegistry({ ...f.registry, registry });
  assert.deepEqual(result, { root: cache, source: "cache", searched: [cache] });
  assert.ok((await lstat(join(cache, "all-skills", "alpha", "SKILL.md"))).isFile());
});

// A cache cloned while all-skills was still ordinary tracked files, then brought forward with
// `git pull --ff-only` across the submodule conversion: git deletes the tracked files but leaves
// ignored ones (a skill script's __pycache__, a .env) in place. all-skills is then non-empty,
// holds no skill definition and has no .git, and `submodule update --init` refuses to populate
// it. Emptiness is not the signal; an uninitialized declared submodule is.
async function pulledAcrossSubmoduleConversion(t) {
  const repos = await catalogRepositories(t);
  const { root, git } = repos;
  const skills = join(root, "skills-flat");
  await mkdir(join(skills, "foo", "scripts"), { recursive: true });
  await writeFile(join(skills, "foo", "SKILL.md"), "---\nname: foo\n---\n# Foo\n");
  await writeFile(join(skills, "foo", "scripts", "run.py"), "print('foo')\n");
  git(skills, "init", "-q", "-b", "main");
  git(skills, "add", ".");
  git(skills, "commit", "-q", "-m", "skills");
  const catalog = join(root, "catalog-flat");
  await mkdir(join(catalog, "all-skills", "foo", "scripts"), { recursive: true });
  await writeFile(join(catalog, "all-skills", "foo", "SKILL.md"), "---\nname: foo\n---\n# Foo\n");
  await writeFile(join(catalog, "all-skills", "foo", "scripts", "run.py"), "print('foo')\n");
  await writeFile(join(catalog, ".gitignore"), "__pycache__/\n.env\n");
  git(catalog, "init", "-q", "-b", "main");
  git(catalog, "add", ".");
  git(catalog, "commit", "-q", "-m", "catalog with ordinary all-skills");
  return { ...repos, skills, flat: catalog };
}

async function convertToSubmodule(repos) {
  repos.git(repos.flat, "rm", "-q", "-r", "all-skills");
  repos.git(repos.flat, "commit", "-q", "-m", "drop ordinary all-skills");
  repos.git(repos.flat, "submodule", "add", "-q", repos.skills, "all-skills");
  repos.git(repos.flat, "commit", "-q", "-m", "all-skills becomes a submodule");
}

test("an uninitialized all-skills submodule holding only leftover ignored files is still refused", async (t) => {
  const f = await fixture(t);
  const repos = await pulledAcrossSubmoduleConversion(t);
  const registry = "https://example.test/org/catalog.git";
  const cache = join(
    f.home,
    ".agents",
    ".cache",
    "registries",
    "https___example_test_org_catalog_git",
  );
  await mkdir(dirname(cache), { recursive: true });
  repos.git(dirname(cache), "clone", "-q", repos.flat, cache);
  // Before the conversion the populated cache is a working catalog and stays selectable.
  assert.deepEqual(await discoverRegistry({ ...f.registry, registry }), {
    root: cache,
    source: "cache",
    searched: [cache],
  });
  const leftover = join(cache, "all-skills", "foo", "scripts", "__pycache__");
  await mkdir(leftover, { recursive: true });
  await writeFile(join(leftover, "run.cpython-312.pyc"), "bytecode\n");
  await writeFile(join(cache, "all-skills", ".env"), "TOKEN=local\n");
  await convertToSubmodule(repos);
  repos.git(cache, "pull", "-q", "--ff-only");
  assert.match(await readFile(join(cache, ".gitmodules"), "utf8"), /path = all-skills/);
  assert.deepEqual((await readdir(join(cache, "all-skills"))).sort(), [".env", "foo"]);
  assert.deepEqual(await readdir(join(cache, "all-skills", "foo")), ["scripts"]);
  await checkout(join(f.home, "code", "skillex"));
  const before = await snapshot(f.root);
  for (const options of [
    { ...f.registry, registry },
    { ...f.registry, registryRoot: cache },
  ]) {
    await assert.rejects(discoverRegistry(options), (error) => {
      failure("E_REGISTRY_ROOT")(error);
      const [finding] = error.findings;
      assert.equal(finding.path, join(cache, "all-skills"));
      assert.match(finding.message, /uninitialized git submodule/);
      // The leftovers block `submodule update --init`; the fix names them and moves, never deletes.
      assert.match(finding.fix, /\.env/);
      assert.match(finding.fix, /foo/);
      assert.match(finding.fix, /submodule update --init --recursive/);
      assert.doesNotMatch(finding.fix, /\brm\b/);
      return true;
    });
  }
  assert.deepEqual(await snapshot(f.root), before);
  // The index is authoritative when git can answer: a stray untracked definition left behind
  // does not make the uninitialized submodule a catalog (the other skills would still be missing).
  await writeFile(join(cache, "all-skills", "foo", "SKILL.md"), "---\nname: foo\n---\n# Stale\n");
  await assert.rejects(
    discoverRegistry({ ...f.registry, registryRoot: cache }),
    failure("E_REGISTRY_ROOT"),
  );

  // The named repair works: move the leftovers aside, then populate the submodule.
  const aside = join(f.root, "aside");
  await mkdir(aside);
  for (const name of await readdir(join(cache, "all-skills")))
    await rename(join(cache, "all-skills", name), join(aside, name));
  repos.git(cache, "submodule", "update", "-q", "--init", "--recursive");
  assert.deepEqual(await discoverRegistry({ ...f.registry, registry }), {
    root: cache,
    source: "cache",
    searched: [cache],
  });
  assert.ok((await lstat(join(cache, "all-skills", "foo", "SKILL.md"))).isFile());
});

test("a declared all-skills without git metadata is refused only when it holds no definition", async (t) => {
  const f = await fixture(t);
  const declared = '[submodule "all-skills"]\n\tpath = all-skills\n\turl = ../skills\n';
  // Not a git checkout at all (an rsync or archive copy): no index to consult, so the catalog
  // is judged by whether it holds any skill definition.
  const stray = await checkout(join(f.root, "stray"));
  await writeFile(join(stray, ".gitmodules"), declared);
  await writeFile(join(stray, "all-skills", ".DS_Store"), "finder\n");
  await mkdir(join(stray, "all-skills", "foo", "scripts", "__pycache__"), { recursive: true });
  await assert.rejects(
    discoverRegistry({ ...f.registry, registryRoot: stray }),
    failure("E_REGISTRY_ROOT"),
  );
  const copied = await checkout(join(f.root, "copied"));
  await writeFile(join(copied, ".gitmodules"), declared);
  await mkdir(join(copied, "all-skills", "foo"), { recursive: true });
  await writeFile(join(copied, "all-skills", "foo", "SKILL.md"), "---\nname: foo\n---\n# Foo\n");
  const result = await discoverRegistry({ ...f.registry, registryRoot: copied });
  assert.equal(result.root, copied);
});

test("an empty all-skills that is not a submodule remains a valid empty catalog", async (t) => {
  const f = await fixture(t);
  const chosen = await checkout(join(f.home, "catalog"));
  await writeFile(join(chosen, ".gitmodules"), '[submodule "vendor"]\n\tpath = vendor\n');
  const result = await discoverRegistry({ ...f.registry, registryRoot: chosen });
  assert.equal(result.root, chosen);
});

test("all-skills must be a real directory rather than an activation-style symlink", async (t) => {
  const f = await fixture(t);
  const catalog = join(f.root, "catalog");
  await mkdir(catalog);
  await symlink(catalog, join(f.cwd, "all-skills"));
  await checkout(join(f.home, "code", "skillex"));
  await assert.rejects(
    discoverRegistry({ ...f.registry, registryRoot: f.cwd }),
    failure("E_REGISTRY_ROOT"),
  );
  await assert.rejects(discoverRegistry(f.registry), failure("E_REGISTRY_ROOT"));
});

test("broken symlinks and non-directory parents produce IO errors instead of fallback", async (t) => {
  const f = await fixture(t);
  await checkout(join(f.home, "code", "skillex"));
  const broken = join(f.root, "broken");
  await symlink(join(f.root, "absent"), broken);
  await assert.rejects(
    discoverRegistry({ ...f.registry, registryRoot: broken }),
    failure("E_PATH_READ"),
  );
  const file = join(f.root, "file");
  await writeFile(file, "not a directory");
  await assert.rejects(
    discoverRegistry({ ...f.registry, registryRoot: join(file, "child") }),
    failure("E_PATH_READ"),
  );
});

test("successful discovery leaves every fixture file and link unchanged", async (t) => {
  const f = await fixture(t);
  const registryRoot = await checkout(join(f.root, "catalog"));
  await manifest(f.home);
  await manifest(f.cwd);
  await symlink("../catalog", join(f.root, "catalog", "untouched-link"));
  const before = await snapshot(f.root);
  await discoverScopes({ ...f.scopes, scope: "project" });
  await discoverRegistry({ ...f.registry, registryRoot });
  assert.deepEqual(await snapshot(f.root), before);
});
