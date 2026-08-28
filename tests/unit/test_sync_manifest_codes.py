"""The three manifest-error codes, and the vocabulary that carries them.

``skills.json`` can be wrong in three distinguishable ways, and the whole point of
splitting them is that each sends the reader somewhere different:

======================  ==================================  ====================
code                    the manifest is                     where you look
======================  ==================================  ====================
``E_MANIFEST_PARSE``    not JSON at all                     a bracket, a comma
``E_MANIFEST_INVALID``  JSON, saying something impossible   a value
``E_UNSUPPORTED_FIELD`` JSON, in the schema, refused        the field, and why
======================  ==================================  ====================

All three are configuration errors: exit 2, and **nothing on disk moves**. The
exit code alone cannot tell them apart, so every test here asserts the
:class:`~skillex.core.diagnostics.Code` member and never the prose -- renaming a
message is free, renaming a code is a breaking change to ``--json``.

The last two tests are about the vocabulary rather than any one run:
``E_STRICT`` is gone (``Finding.strict`` carries that now), and every remaining
``Code`` member is actually emitted by something in ``src/``. A diagnostic code
that no code path can produce is a promise the CLI does not keep.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from skillex.core.diagnostics import EXIT_CONFIG, Code
from skillex.core.loader import (
    ManifestError,
    ManifestParseError,
    load_skills_manifest,
)
from tests.conftest import Sandbox

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def outside(sandbox: Sandbox) -> Path:
    """A CWD inside no project, so a run resolves the GLOBAL scope only.

    Deliberately not ``sandbox.tmp``: its ``home/`` child carries the global
    manifest and would be reported as a project one level below, adding an
    ``I_*`` finding to every payload this module inspects.
    """
    path = sandbox.tmp / "elsewhere"
    path.mkdir(exist_ok=True)
    return path


def codes(payload: dict) -> list[str]:
    """Every ``findings[].code``, in emission order."""
    return [f["code"] for f in payload["findings"]]


def only_finding(payload: dict) -> dict:
    """The single finding a manifest error produces.

    A manifest that does not load aborts the preflight loop before any scope is
    resolved, so exactly one finding is the correct shape -- more than one would
    mean sync kept working on a manifest it could not read.
    """
    assert len(payload["findings"]) == 1, codes(payload)
    return payload["findings"][0]


#: Manifests that are not JSON. ``write_manifest`` writes a ``str`` verbatim.
UNPARSEABLE = {
    "stray-comma": '{"sets": ["a",], "skills": []}',
    "trailing-comma-object": '{"sets": [],}',
    "truncated": '{"sets": ["a"',
    "empty-file": "",
    "not-json-at-all": "{ this is not json",
}

#: Manifests that parse as JSON and then say something impossible.
IMPOSSIBLE = {
    # Top level must be an object; a bare array is the shape someone reaches for
    # when they think skills.json is "just a list of skills".
    "top-level-list": '["hindsight", "pjangler"]',
    "top-level-string": '"hindsight"',
    # An array key given a scalar.
    "sets-is-a-string": '{"sets": "min-global"}',
    "skills-is-a-string": '{"skills": "hindsight"}',
    "packs-is-an-object": '{"packs": {"name": "bmad"}}',
    # An entry that is neither the string shorthand nor the object form.
    "skills-entry-is-a-number": '{"skills": [3]}',
    "skills-entry-is-null": '{"skills": [null]}',
    "sets-entry-is-a-list": '{"sets": [["min-global"]]}',
    # Parses, is a string, and is still impossible: it would be joined straight
    # onto the registry root and escape it.
    "skills-traversal-shorthand": '{"skills": ["../../etc"]}',
    "skills-traversal-deeper": '{"skills": ["sets/../../../etc/passwd"]}',
    "skills-absolute-path": '{"skills": ["/etc/passwd"]}',
}

#: Manifests whose offending field is IN the published schema and refused anyway.
#: Silently ignoring any of these is worse than failing: ``sets[].flatten`` would
#: project zero skills and report success.
UNSUPPORTED = {
    "sets-flatten": {"sets": [{"name": "gset", "flatten": True}]},
    "sets-sealed": {"sets": [{"name": "gset", "sealed": True}]},
    "sets-version": {"sets": [{"name": "gset", "version": "1.0.0"}]},
    "sets-registry": {"sets": [{"name": "gset", "registry": "git@example.com:x/y.git"}]},
    "sets-at-version-shorthand": {"sets": ["gset@1.0.0"]},
    "skills-version": {"skills": [{"name": "hindsight", "version": "v1.2.3"}]},
    "skills-registry": {"skills": [{"name": "hindsight", "registry": "https://example.com/r"}]},
}


# ===========================================================================
# E_MANIFEST_PARSE -- the file is not JSON
# ===========================================================================


@pytest.mark.parametrize("text", UNPARSEABLE.values(), ids=list(UNPARSEABLE))
def test_unparseable_json_raises_manifest_parse_error(tmp_path: Path, text: str) -> None:
    """The loader raises the SPECIFIC subclass, not the base class.

    Asserted with ``type(...) is``, not ``isinstance``: the base class would
    satisfy ``isinstance`` and the whole point of the subclass is that a caller
    can tell "your JSON is broken" from "your manifest says something impossible".
    """
    path = tmp_path / "skills.json"
    path.write_text(text, encoding="utf-8")

    with pytest.raises(ManifestParseError) as excinfo:
        load_skills_manifest(path)

    assert type(excinfo.value) is ManifestParseError
    # The underlying decoder error is preserved, so the message can name the
    # character offset without the loader re-deriving it.
    assert isinstance(excinfo.value.__cause__, json.JSONDecodeError)


def test_manifest_parse_error_is_a_manifest_error_subclass() -> None:
    """Every existing ``except ManifestError`` must still catch the new error.

    This is the compatibility guarantee the subclass was introduced for: adding a
    narrower error must not make an older handler stop firing. Both halves are
    asserted -- the static relationship AND a real ``except ManifestError`` block
    catching a real raise -- because ``issubclass`` alone would still pass if some
    future refactor made the loader raise something else entirely.
    """
    assert issubclass(ManifestParseError, ManifestError)

    caught: Exception | None = None
    try:
        raise ManifestParseError("broken")
    except ManifestError as e:  # deliberately the BASE class
        caught = e

    assert isinstance(caught, ManifestParseError)


@pytest.mark.parametrize("text", UNPARSEABLE.values(), ids=list(UNPARSEABLE))
def test_unparseable_json_is_e_manifest_parse_and_exits_2(
    sandbox: Sandbox, registry: Path, outside: Path, run_sync_json, text: str
) -> None:
    sandbox.write_global_manifest(text)

    code, payload = run_sync_json(cwd=outside)

    assert code == EXIT_CONFIG
    assert codes(payload) == [Code.E_MANIFEST_PARSE.value]
    assert not sandbox.global_root.exists()


# ===========================================================================
# E_MANIFEST_INVALID -- it parsed, and it says something impossible
# ===========================================================================


@pytest.mark.parametrize("text", IMPOSSIBLE.values(), ids=list(IMPOSSIBLE))
def test_well_formed_but_impossible_json_is_e_manifest_invalid(
    sandbox: Sandbox, registry: Path, outside: Path, run_sync_json, text: str
) -> None:
    """Not ``E_MANIFEST_PARSE``: the JSON is fine, so a syntax hunt is wasted time.

    ``json.loads`` is called first here to prove the premise -- if one of these
    ever stops being valid JSON the case is testing the wrong code path, and the
    failure should say so rather than passing for the wrong reason.
    """
    json.loads(text)  # premise: this IS valid JSON
    sandbox.write_global_manifest(text)

    code, payload = run_sync_json(cwd=outside)

    assert code == EXIT_CONFIG
    assert codes(payload) == [Code.E_MANIFEST_INVALID.value]
    assert not sandbox.global_root.exists()


@pytest.mark.parametrize(
    "text",
    [IMPOSSIBLE["skills-traversal-shorthand"], IMPOSSIBLE["skills-absolute-path"]],
    ids=["traversal", "absolute"],
)
def test_a_traversal_shorthand_is_invalid_rather_than_unsupported(
    sandbox: Sandbox, registry: Path, outside: Path, run_sync_json, text: str
) -> None:
    """``"../../etc"`` PARSES and is in the schema; it is simply impossible.

    The published schema puts no pattern on the ``skills[]`` string form, so this
    validates against the schema today and would otherwise be joined onto the
    registry root. It is not ``E_UNSUPPORTED_FIELD`` -- no field is being refused,
    a value is -- and it is not ``E_UNSAFE_PATH`` either, which is the resolver's
    code for a path that got past the loader.
    """
    sandbox.write_global_manifest(text)

    code, payload = run_sync_json(cwd=outside)

    assert code == EXIT_CONFIG
    assert codes(payload) == [Code.E_MANIFEST_INVALID.value]
    assert Code.E_UNSUPPORTED_FIELD.value not in codes(payload)
    assert Code.E_UNSAFE_PATH.value not in codes(payload)


# ===========================================================================
# E_UNSUPPORTED_FIELD -- in the schema, refused on purpose
# ===========================================================================


@pytest.mark.parametrize("manifest", UNSUPPORTED.values(), ids=list(UNSUPPORTED))
def test_a_schema_field_sync_refuses_is_e_unsupported_field(
    sandbox: Sandbox, registry: Path, outside: Path, run_sync_json, manifest: dict
) -> None:
    sandbox.write_global_manifest(manifest)

    code, payload = run_sync_json(cwd=outside)

    assert code == EXIT_CONFIG
    assert codes(payload) == [Code.E_UNSUPPORTED_FIELD.value]
    assert not sandbox.global_root.exists()


@pytest.mark.parametrize("manifest", UNSUPPORTED.values(), ids=list(UNSUPPORTED))
def test_a_refusal_explains_why_rather_than_only_refusing(
    sandbox: Sandbox, registry: Path, outside: Path, run_sync_json, manifest: dict
) -> None:
    """A refusal a reader cannot act on is a bug, not a diagnostic.

    Asserted structurally, never against the prose: the finding must carry a
    ``fix``, and the message must continue past the refusal marker with a real
    explanation rather than stopping at "not supported". The 40-character floor
    is arbitrary but effective -- it fails the moment someone replaces an authored
    rationale with a bare refusal.
    """
    sandbox.write_global_manifest(manifest)

    _, payload = run_sync_json(cwd=outside)

    finding = only_finding(payload)
    assert finding["code"] == Code.E_UNSUPPORTED_FIELD.value
    assert finding.get("fix")

    marker = "is not supported."
    assert marker in finding["message"]
    why = finding["message"].split(marker, 1)[1].strip()
    assert len(why) > 40, f"refusal carries no explanation: {finding['message']!r}"


# ===========================================================================
# all three: exit 2, and NOTHING moves
# ===========================================================================


ALL_BAD_MANIFESTS = {
    **{f"parse:{k}": v for k, v in UNPARSEABLE.items()},
    **{f"invalid:{k}": v for k, v in IMPOSSIBLE.items()},
    **{f"unsupported:{k}": v for k, v in UNSUPPORTED.items()},
}

CONFIG_CODES = {
    Code.E_MANIFEST_PARSE.value,
    Code.E_MANIFEST_INVALID.value,
    Code.E_UNSUPPORTED_FIELD.value,
}


@pytest.mark.parametrize("manifest", ALL_BAD_MANIFESTS.values(), ids=list(ALL_BAD_MANIFESTS))
def test_a_manifest_error_exits_2_and_mutates_nothing(
    sandbox: Sandbox,
    registry: Path,
    outside: Path,
    write_catalog,
    write_set,
    run_sync_json,
    snapshot,
    manifest,
) -> None:
    """The registry is fully stocked, so a successful run WOULD write links.

    Snapshotting the whole sandbox (inodes and link bodies, symlinks never
    followed) rather than asserting an empty plan: a plan that says "nothing to
    do" and an ``apply()`` that writes anyway are indistinguishable from the plan
    alone. Only the disk settles it.
    """
    write_catalog(registry, "hindsight", "pjangler")
    write_set(
        registry,
        "gset",
        [
            ("link", "hindsight", registry / "all-skills" / "hindsight"),
            ("link", "pjangler", registry / "all-skills" / "pjangler"),
        ],
    )
    sandbox.write_global_manifest(manifest)

    before = snapshot(sandbox.tmp)
    code, payload = run_sync_json(cwd=outside)
    after = snapshot(sandbox.tmp)

    assert code == EXIT_CONFIG
    assert set(codes(payload)) <= CONFIG_CODES, codes(payload)
    assert after == before
    assert not sandbox.global_root.exists()
    assert not sandbox.state_dir.exists()


def test_a_good_manifest_in_the_same_sandbox_does_write(
    sandbox: Sandbox,
    registry: Path,
    outside: Path,
    write_catalog,
    write_set,
    run_sync_json,
    snapshot,
) -> None:
    """The control for the test above.

    Without it, "nothing was mutated" would also pass if the fixture registry were
    empty, the CWD were wrong, or sync were broken in some way that writes nothing
    for every input. This proves the same setup DOES write when the manifest is
    readable, which is what makes the unchanged snapshots above mean something.
    """
    write_catalog(registry, "hindsight", "pjangler")
    write_set(
        registry,
        "gset",
        [
            ("link", "hindsight", registry / "all-skills" / "hindsight"),
            ("link", "pjangler", registry / "all-skills" / "pjangler"),
        ],
    )
    sandbox.write_global_manifest(sets=["gset"])

    before = snapshot(sandbox.tmp)
    code, payload = run_sync_json(cwd=outside)

    assert code == 0, codes(payload)
    assert snapshot(sandbox.tmp) != before
    assert sorted(p.name for p in sandbox.global_root.iterdir()) == ["hindsight", "pjangler"]


# ===========================================================================
# the vocabulary itself
# ===========================================================================


def test_e_strict_no_longer_exists() -> None:
    """``Finding.strict`` replaced it.

    ``--strict`` moves a warning's SEVERITY and leaves its CODE alone, because
    ``code`` is the published ``--json`` contract: a consumer's mapping must not
    depend on which flags the run happened to be given. A separate ``E_STRICT``
    code could only ever mean "some warning, promoted", which is strictly less
    information than the warning's own code plus a flag.
    """
    assert not hasattr(Code, "E_STRICT")
    assert "E_STRICT" not in {c.value for c in Code}


def test_every_code_member_is_emitted_somewhere_in_src(repo_root: Path) -> None:
    """The vocabulary must stay honest: no defined-but-unreachable diagnostic.

    Eight codes were defined and never emitted before this suite existed. Some
    were real gaps (a missing set reported as "no registry"), some were dead
    weight (``E_STRICT``). Either way the enum was documenting behavior the CLI
    did not have, and nothing failed.

    ``diagnostics.py`` is excluded because it necessarily names every member --
    the definition itself, plus ``STRICT_PROMOTES`` and ``_CONFIG_ERRORS`` -- so
    including it would make this test vacuous.
    """
    sources = {
        path: path.read_text(encoding="utf-8")
        for path in sorted((repo_root / "src").rglob("*.py"))
        if path.name != "diagnostics.py"
    }
    assert sources, "no sources found; the repo_root fixture is wrong"

    dead = [
        code.name
        for code in Code
        if not any(f"Code.{code.name}" in text for text in sources.values())
    ]

    assert not dead, (
        "these Code members are defined but never referenced outside "
        f"diagnostics.py: {dead}. Either wire them up or delete them -- a code "
        "no path can emit is a promise the CLI does not keep."
    )
