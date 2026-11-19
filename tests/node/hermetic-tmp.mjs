// Preloaded by `node --test --import` (see package.json "test"). Several suites create
// activation state under os.tmpdir(); skillex rightly refuses receipts that live inside a
// source repository (E_RECEIPT_UNSAFE_PATH). An agent shell can export TMPDIR inside a
// repository (for example ~/.claude/tmp), which made those suites fail depending on the
// caller's environment. Fall back to a temp root that is not inside any Git repository.
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function insideRepository(path) {
  let current;
  try {
    current = realpathSync(resolve(path));
  } catch {
    return false;
  }
  for (;;) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

// A git hook (pre-push runs this suite) exports GIT_DIR/GIT_INDEX_FILE/... pointing at the REAL
// repository, and fixtures that spawnSync("git", ...) without an env inherit them: on
// 2026-11-19 a pre-push run committed fixture trees onto main and repointed HEAD at a
// `fixture` branch. Strip the repository-locating variables before any suite loads.
const GIT_REPO_ENV =
  /^GIT_(DIR|WORK_TREE|INDEX_FILE|PREFIX|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/;
for (const key of Object.keys(process.env)) {
  if (GIT_REPO_ENV.test(key)) delete process.env[key];
}

if (process.platform !== "win32") {
  const configured = process.env.TMPDIR;
  if (configured !== undefined && configured !== "" && insideRepository(configured)) {
    for (const candidate of ["/tmp", "/var/tmp"]) {
      if (existsSync(candidate) && !insideRepository(candidate)) {
        process.env.TMPDIR = candidate;
        break;
      }
    }
  }
}
