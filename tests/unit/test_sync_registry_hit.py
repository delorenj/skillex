"""``paths.RegistryHit`` and the missing/stale split it made expressible.

Two things are under test here and they are the same thing seen from both ends.

**The ladder must not lie about which rung answered.** ``find_in_roots`` walks
``PJ_SKILLS_REGISTRY_ROOT | ~/.agents/.cache/registries/<sanitized-url> |
~/code/skillex`` and stops at the first rung that actually CARRIES the requested
path. Returning only the winner throws away the fact that it walked past a
checkout the operator believes is authoritative -- which is the normal case on
this machine, not a corner: the cache rung exists, still carries the retired
``skill-sets/``, and has no ``sets/`` at all, so every set resolves one rung
further down, silently. ``RegistryHit.skipped`` is what makes that sayable and
``W_STALE_REGISTRY_CANDIDATE`` is what says it.

**"I could not find it" must name which kind of wrong it is.** ``E_NO_REGISTRY``
now means only "there is no checkout at all" (fix your environment);
``E_SET_MISSING`` / ``E_SKILL_MISSING`` / ``E_PACK_MISSING`` mean the checkouts
are fine and the *name* is wrong (fix your manifest). All four are configuration
errors and all four still exit 2 -- the exit code is deliberately not the
carrier of that distinction, the code is.

Everything is asserted on :class:`~skillex.core.diagnostics.Code` members and on
paths, never on message prose. Fixtures are built programmatically; no symlink
is ever committed.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping, Sequence
from pathlib import Path
from typing import Any

import pytest

from skillex.core.diagnostics import EXIT_CONFIG, Code, RefusalError, Reporter
from skillex.core.loader import load_skills_manifest
from skillex.core.resolver import Desired, _report_skipped, compose
from skillex.core.scope import global_scope
from skillex.paths import RegistryHit, find_in_roots
from tests.conftest import (
    Sandbox,
    make_registry,
    write_catalog,
    write_pack,
    write_set,
    write_skill,
)

SET = "demo"
SKILL = "alpha"
PACK = "demo-pack"


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def outside(sandbox: Sandbox) -> Path:
    """A CWD inside no project, so a CLI run reconciles the global scope only."""
    path = sandbox.tmp / "elsewhere"
    path.mkdir(exist_ok=True)
    return path


def compose_global(
    sandbox: Sandbox, roots: Sequence[Path], **keys: Any
) -> tuple[Desired, Reporter]:
    """Compile ``$HOME/.agents/skills.json`` against an EXPLICIT ladder.

    Passing the ladder in is the point: ``registry_roots()`` filters to existing
    rungs and the sandbox pins ``PJ_SKILLS_REGISTRY_ROOT`` to exactly one of them,
    so a multi-rung ladder is not otherwise reachable without unpinning the very
    isolation that keeps this suite off the real machine.
    """
    path = sandbox.write_global_manifest(**keys)
    reporter = Reporter()
    desired = compose(load_skills_manifest(path), global_scope(), list(roots), reporter)
    return desired, reporter


def codes(reporter: Reporter) -> list[Code]:
    return [f.code for f in reporter.findings]


def only(reporter: Reporter, code: Code):
    matches = [f for f in reporter.findings if f.code is code]
    assert len(matches) == 1, f"expected exactly one {code.value}, got {codes(reporter)}"
    return matches[0]


def json_codes(payload: Mapping[str, Any]) -> list[str]:
    return [f["code"] for f in payload["findings"]]


def json_detail(payload: Mapping[str, Any], code: Code) -> list[str]:
    """Every ``detail`` line of every finding carrying ``code``."""
    return [
        line
        for finding in payload["findings"]
        if finding["code"] == code.value
        for line in finding.get("detail", [])
    ]


@pytest.fixture
def repin(sandbox: Sandbox) -> Iterator[Callable[[Path | None], None]]:
    """Re-point (or unset) ``PJ_SKILLS_REGISTRY_ROOT`` for one test, safely.

    Depends on ``sandbox`` ON PURPOSE. This owns a PRIVATE ``MonkeyPatch`` whose
    teardown must run BEFORE the sandbox's, or the restore would put the sandbox's
    tmp path back into the real environment for the rest of the session. Fixture
    finalization is the reverse of setup, and the only way to pin that order is to
    depend on the fixture that must outlive this one.
    """
    mp = pytest.MonkeyPatch()
    try:

        def _repin(root: Path | None) -> None:
            if root is None:
                mp.delenv("PJ_SKILLS_REGISTRY_ROOT", raising=False)
            else:
                mp.setenv("PJ_SKILLS_REGISTRY_ROOT", str(root))

        yield _repin
    finally:
        mp.undo()


@pytest.fixture
def stale_ladder(tmp_path: Path) -> tuple[Path, Path]:
    """The live shape, reproduced: (stale cache rung, real checkout).

    Rung 1 EXISTS and is not empty -- it even carries ``all-skills/`` and the
    retired ``skill-sets/`` -- but it has no ``sets/``, no ``packs/`` and none of
    the catalog entries asked for below. That is exactly why it is dangerous: it
    passes every "is there a registry here?" test and answers no actual question.
    """
    cache = tmp_path / "cache-clone"
    (cache / "all-skills").mkdir(parents=True)
    write_skill(cache / "all-skills", "unrelated")
    (cache / "skill-sets" / "min-global").mkdir(parents=True)

    checkout = make_registry(tmp_path / "checkout")
    catalog = write_catalog(checkout, SKILL)
    write_set(checkout, SET, [("link", SKILL, catalog[SKILL])])
    write_pack(checkout, PACK, skills=[SKILL])
    return cache, checkout


# ===========================================================================
# RegistryHit itself
# ===========================================================================


class TestRegistryHit:
    """What ``find_in_roots`` reports, and what it must never round off."""

    def test_the_hit_carries_root_path_and_every_existing_rung_passed_over(
        self, tmp_path: Path
    ) -> None:
        first = make_registry(tmp_path / "first")
        second = make_registry(tmp_path / "second")
        third = make_registry(tmp_path / "third")
        write_set(third, SET)

        hit = find_in_roots([first, second, third], f"sets/{SET}")

        assert hit is not None
        assert isinstance(hit, RegistryHit)
        assert hit.root == third
        assert hit.path == third / "sets" / SET
        # Ladder order, not sorted, not a set: "which rungs did I walk past, in
        # the order I walked past them" is the only useful reading.
        assert hit.skipped == (first, second)

    def test_skipped_is_empty_when_the_first_rung_carries_it(self, tmp_path: Path) -> None:
        first = make_registry(tmp_path / "first")
        second = make_registry(tmp_path / "second")
        write_set(first, SET)
        write_set(second, SET)

        hit = find_in_roots([first, second], f"sets/{SET}")

        assert hit is not None
        assert hit.root == first
        # Empty, so `_report_skipped` stays silent. A warning that fires on the
        # healthy case trains the eye to skip the one that matters.
        assert hit.skipped == ()

    def test_a_rung_that_does_not_exist_is_never_reported_as_skipped(self, tmp_path: Path) -> None:
        """``skipped`` means "EXISTS but does not carry it" -- its whole point.

        A rung that is simply absent is not a stale checkout an operator should go
        refresh; it is a path that was never there. Recording it would make
        ``W_STALE_REGISTRY_CANDIDATE`` say "skipped <p> (exists, but has no X)"
        about a directory that does not exist, and send the reader to look at
        nothing.
        """
        absent = tmp_path / "never-cloned"
        present_but_empty = make_registry(tmp_path / "present")
        winner = make_registry(tmp_path / "winner")
        write_set(winner, SET)

        hit = find_in_roots([absent, present_but_empty, winner], f"sets/{SET}")

        assert hit is not None
        assert hit.root == winner
        assert hit.skipped == (present_but_empty,)
        assert absent not in hit.skipped

    def test_absent_from_every_rung_is_none_not_an_empty_hit(self, tmp_path: Path) -> None:
        first = make_registry(tmp_path / "first")
        second = make_registry(tmp_path / "second")

        assert find_in_roots([first, second], f"sets/{SET}") is None
        assert find_in_roots([], f"sets/{SET}") is None

    def test_it_still_unpacks_and_indexes_as_the_old_two_tuple(self, tmp_path: Path) -> None:
        """Backward compatibility is a contract, not a courtesy.

        ``find_in_roots`` used to return ``(root, path)`` and call sites unpacked
        it positionally. The dataclass replaced that shape in place, so both forms
        must keep working or the change is a silent break at every unmigrated site.
        """
        first = make_registry(tmp_path / "first")
        second = make_registry(tmp_path / "second")
        write_set(second, SET)

        hit = find_in_roots([first, second], f"sets/{SET}")
        assert hit is not None

        root, path = hit
        assert root == second
        assert path == second / "sets" / SET
        assert hit[0] == root
        assert hit[1] == path
        assert list(hit) == [root, path]


class TestDanglingLinkStillCountsAsFound:
    """THE one that matters: existence is LEXICAL, so a dangle does not fall through.

    If the check followed the link, a broken ``sets/demo`` symlink in the cache
    rung would look like "this rung doesn't have it" and resolution would bind
    ``sets/demo`` from a DIFFERENT checkout -- a different set, silently, with no
    diagnostic. Reporting the dangle at the rung that owns it is the only honest
    outcome.
    """

    def test_a_dangling_link_at_the_requested_path_stops_the_walk(self, tmp_path: Path) -> None:
        first = make_registry(tmp_path / "first")
        second = make_registry(tmp_path / "second")
        # sets/demo -> a path that does not exist, at the FIRST rung.
        (first / "sets" / SET).symlink_to(first / "sets" / "gone")
        write_set(second, SET, [("realdir", SKILL)])

        hit = find_in_roots([first, second], f"sets/{SET}")

        assert hit is not None
        assert hit.root == first
        assert hit.skipped == ()
        # Proof the check is lexical and not accidentally satisfied by something
        # resolvable: the winning path resolves to nothing at all.
        assert hit.path.is_symlink()
        assert not hit.path.exists()

    def test_a_dangling_link_deeper_in_the_ladder_still_wins_its_rung(self, tmp_path: Path) -> None:
        first = make_registry(tmp_path / "first")
        second = make_registry(tmp_path / "second")
        third = make_registry(tmp_path / "third")
        (second / "all-skills" / SKILL).symlink_to(tmp_path / "nowhere")
        write_catalog(third, SKILL)

        hit = find_in_roots([first, second, third], f"all-skills/{SKILL}")

        assert hit is not None
        assert hit.root == second
        assert hit.skipped == (first,)


# ===========================================================================
# W_STALE_REGISTRY_CANDIDATE -- the live stale-clone shape
# ===========================================================================


class TestStaleRegistryCandidate:
    def test_a_set_resolves_past_the_stale_clone_and_says_so(
        self, sandbox: Sandbox, stale_ladder: tuple[Path, Path]
    ) -> None:
        """Rung 1 exists and even has ``all-skills/``, but no ``sets/`` at all."""
        cache, checkout = stale_ladder
        assert (cache / "all-skills").is_dir()
        assert not (cache / "sets").exists()

        desired, reporter = compose_global(sandbox, [cache, checkout], sets=[SET])

        assert desired.bindings[SKILL].target == checkout / "all-skills" / SKILL
        warning = only(reporter, Code.W_STALE_REGISTRY_CANDIDATE)
        # The winner is named as the finding's path; the loser is named in detail.
        assert warning.path == checkout
        assert any(str(cache) in line for line in warning.detail)
        assert reporter.errors() == []

    def test_a_skills_entry_resolves_past_the_stale_clone_and_says_so(
        self, sandbox: Sandbox, stale_ladder: tuple[Path, Path]
    ) -> None:
        cache, checkout = stale_ladder
        # The cache rung HAS all-skills/ -- just not this skill. Existence of the
        # parent directory is exactly what makes the stale rung plausible.
        assert not (cache / "all-skills" / SKILL).exists()

        desired, reporter = compose_global(sandbox, [cache, checkout], skills=[SKILL])

        assert desired.bindings[SKILL].target == checkout / "all-skills" / SKILL
        assert only(reporter, Code.W_STALE_REGISTRY_CANDIDATE).path == checkout

    def test_a_pack_resolves_past_the_stale_clone_and_says_so(
        self, sandbox: Sandbox, stale_ladder: tuple[Path, Path]
    ) -> None:
        cache, checkout = stale_ladder
        assert not (cache / "packs").exists()

        _, reporter = compose_global(sandbox, [cache, checkout], packs=[PACK])

        assert only(reporter, Code.W_STALE_REGISTRY_CANDIDATE).path == checkout

    def test_nothing_skipped_means_the_warning_never_fires(
        self, sandbox: Sandbox, stale_ladder: tuple[Path, Path]
    ) -> None:
        """The healthy ladder must be SILENT, including a one-rung ladder."""
        _, checkout = stale_ladder

        _, single = compose_global(sandbox, [checkout], sets=[SET])
        assert Code.W_STALE_REGISTRY_CANDIDATE not in codes(single)

        _, first_rung_wins = compose_global(sandbox, [checkout, checkout], sets=[SET])
        assert Code.W_STALE_REGISTRY_CANDIDATE not in codes(first_rung_wins)

    def test_an_absent_rung_below_the_winner_is_not_a_stale_candidate(
        self, sandbox: Sandbox, stale_ladder: tuple[Path, Path], tmp_path: Path
    ) -> None:
        """A ladder rung that was never cloned is not a checkout to go refresh."""
        _, checkout = stale_ladder

        _, reporter = compose_global(sandbox, [tmp_path / "never-cloned", checkout], sets=[SET])

        assert Code.W_STALE_REGISTRY_CANDIDATE not in codes(reporter)


# ===========================================================================
# the code split -- four distinct codes, one exit status
# ===========================================================================


class TestMissingNameIsNotMissingRegistry:
    """Each of these used to be ``E_NO_REGISTRY``, which sent you to the wrong place."""

    def test_an_unknown_set_is_e_set_missing(self, sandbox: Sandbox, registry: Path) -> None:
        with pytest.raises(RefusalError) as excinfo:
            compose_global(sandbox, [registry], sets=[SET])
        finding = excinfo.value.finding
        assert finding.code is Code.E_SET_MISSING
        assert finding.name == SET

    def test_an_unknown_skill_is_e_skill_missing(self, sandbox: Sandbox, registry: Path) -> None:
        with pytest.raises(RefusalError) as excinfo:
            compose_global(sandbox, [registry], skills=[SKILL])
        finding = excinfo.value.finding
        assert finding.code is Code.E_SKILL_MISSING
        assert finding.name == SKILL

    def test_an_unknown_pack_is_e_pack_missing(self, sandbox: Sandbox, registry: Path) -> None:
        with pytest.raises(RefusalError) as excinfo:
            compose_global(sandbox, [registry], packs=[PACK])
        finding = excinfo.value.finding
        assert finding.code is Code.E_PACK_MISSING
        assert finding.name == PACK

    def test_no_existing_rung_at_all_is_e_no_registry(self, sandbox: Sandbox) -> None:
        """The one case that really IS "fix your environment"."""
        with pytest.raises(RefusalError) as excinfo:
            compose_global(sandbox, [], sets=[SET])
        assert excinfo.value.finding.code is Code.E_NO_REGISTRY

    def test_the_registry_is_checked_before_any_name_is(self, sandbox: Sandbox) -> None:
        """With no ladder, a bad name must not be blamed for a missing checkout."""
        with pytest.raises(RefusalError) as excinfo:
            compose_global(sandbox, [], skills=[SKILL], packs=[PACK])
        assert excinfo.value.finding.code is Code.E_NO_REGISTRY

    @pytest.mark.parametrize(
        ("manifest", "code"),
        [
            ({"sets": [SET]}, Code.E_SET_MISSING),
            ({"skills": [SKILL]}, Code.E_SKILL_MISSING),
            ({"packs": [PACK]}, Code.E_PACK_MISSING),
        ],
        ids=["set", "skill", "pack"],
    )
    def test_every_missing_name_code_still_exits_2(
        self,
        sandbox: Sandbox,
        manifest: dict[str, Any],
        code: Code,
        run_sync_json: Any,
    ) -> None:
        """Distinct codes, one exit status. The CODE carries the distinction.

        A script keys off the exit status to decide whether to retry; splitting
        these into different statuses would have broken every such caller, and the
        split is about *where to look*, not about what to do next.
        """
        sandbox.write_global_manifest(**manifest)

        exit_code, payload = run_sync_json(cwd=outside(sandbox))

        assert exit_code == EXIT_CONFIG
        assert code.value in json_codes(payload)
        assert Code.E_NO_REGISTRY.value not in json_codes(payload)

    def test_an_empty_ladder_exits_2_as_e_no_registry(
        self,
        sandbox: Sandbox,
        repin: Callable[[Path | None], None],
        tmp_path: Path,
        run_sync_json: Any,
    ) -> None:
        repin(tmp_path / "no-such-registry")
        sandbox.write_global_manifest(sets=[SET])

        exit_code, payload = run_sync_json(cwd=outside(sandbox))

        assert exit_code == EXIT_CONFIG
        assert Code.E_NO_REGISTRY.value in json_codes(payload)
        assert Code.E_SET_MISSING.value not in json_codes(payload)


class TestDetailDistinguishesStaleFromAbsent:
    """ "I looked here and here" is only actionable if it says what it found there.

    ``--registry-root`` is the one surface that hands resolution a root without
    filtering for existence, so it is where both branches of the detail line are
    reachable from the CLI.
    """

    def test_a_root_that_exists_but_lacks_the_set_says_so(
        self, sandbox: Sandbox, registry: Path, run_sync_json: Any
    ) -> None:
        sandbox.write_global_manifest(sets=[SET])

        exit_code, payload = run_sync_json("--registry-root", str(registry), cwd=outside(sandbox))

        assert exit_code == EXIT_CONFIG
        detail = json_detail(payload, Code.E_SET_MISSING)
        assert any(str(registry) in line and "exists, but has no" in line for line in detail)
        assert not any("does not exist" in line for line in detail)

    def test_a_root_that_is_not_there_at_all_says_that_instead(
        self, sandbox: Sandbox, tmp_path: Path, run_sync_json: Any
    ) -> None:
        absent = tmp_path / "never-cloned"
        sandbox.write_global_manifest(sets=[SET])

        exit_code, payload = run_sync_json("--registry-root", str(absent), cwd=outside(sandbox))

        assert exit_code == EXIT_CONFIG
        detail = json_detail(payload, Code.E_SET_MISSING)
        assert any(str(absent) in line and "does not exist" in line for line in detail)
        assert not any("exists, but has no" in line for line in detail)


class TestPinnedRootStaysExclusive:
    """``PJ_SKILLS_REGISTRY_ROOT`` replaces the ladder; it is not merely its first rung.

    If it could fall through, a set missing from the pinned root would be served
    silently from the developer's real ``~/code/skillex`` -- neither hermetic nor
    what was asked for. pjangler's ``packRegistryRoots`` behaves the same way and
    the two surfaces must not diverge.
    """

    def test_a_set_missing_from_the_pinned_root_does_not_fall_through(
        self, sandbox: Sandbox, registry: Path, run_sync_json: Any
    ) -> None:
        # A second, fully populated checkout at the ladder's LAST rung
        # (``~/code/skillex``, resolved against the sandbox HOME). If exclusivity
        # ever regressed, this is the checkout that would answer.
        fallback = make_registry(sandbox.home / "code" / "skillex")
        catalog = write_catalog(fallback, SKILL)
        write_set(fallback, SET, [("link", SKILL, catalog[SKILL])])
        assert (fallback / "sets" / SET).is_dir()

        sandbox.write_global_manifest(sets=[SET])

        exit_code, payload = run_sync_json(cwd=outside(sandbox))

        assert exit_code == EXIT_CONFIG
        assert Code.E_SET_MISSING.value in json_codes(payload)
        detail = json_detail(payload, Code.E_SET_MISSING)
        # It looked in exactly one place, and said which.
        assert detail == [f"{registry}  exists, but has no sets/{SET}"]
        assert not any(str(fallback) in line for line in detail)
        # And nothing was projected from it.
        assert not (sandbox.global_root / SKILL).exists()

    def test_unpinning_it_lets_the_lower_rung_answer(
        self,
        sandbox: Sandbox,
        repin: Callable[[Path | None], None],
        run_sync_json: Any,
    ) -> None:
        """The control for the test above: same tree, ladder restored, it resolves.

        Without this, "E_SET_MISSING" above would also be satisfied by a fallback
        checkout that was never reachable in the first place.
        """
        fallback = make_registry(sandbox.home / "code" / "skillex")
        catalog = write_catalog(fallback, SKILL)
        write_set(fallback, SET, [("link", SKILL, catalog[SKILL])])
        sandbox.write_global_manifest(sets=[SET])
        repin(None)

        exit_code, payload = run_sync_json(cwd=outside(sandbox))

        assert Code.E_SET_MISSING.value not in json_codes(payload), payload
        assert exit_code == 0, payload
        assert (sandbox.global_root / SKILL).is_symlink()


# ===========================================================================
# The reported label must be the path that was actually SEARCHED FOR
# ===========================================================================


class TestRegistryPathIsReportedNotTheDefault:
    """``registry_path`` overrides WHERE resolution looks; the diagnostics must agree.

    ``sets[]``/``packs[]`` accept a ``registry_path`` that replaces the default
    ``sets/<name>`` / ``packs/<name>`` lookup. The lookup honored it while both the
    stale-candidate warning and the missing-name error were hard-coded to the
    DEFAULT label, so every message named a path resolution never asked about.

    That is not cosmetic. A rung that genuinely carries ``sets/<name>`` but not the
    override was reported as ``exists, but has no sets/<name>`` -- a statement the
    reader can disprove with one ``ls``, about the one rung that is not the problem.
    Once a diagnostic is caught lying, the next true one gets ignored too.
    """

    def test_the_stale_warning_names_the_overridden_path(self, tmp_path: Path) -> None:
        """The rung being skipped HAS ``sets/demo``. It is missing ``vendor/demo``."""
        first = make_registry(tmp_path / "first")
        second = make_registry(tmp_path / "second")
        # The trap: rung 1 carries the DEFAULT path, so naming the default is
        # not merely imprecise -- it is false.
        write_set(first, SET, [("realdir", SKILL)])
        catalog = write_catalog(second, SKILL)
        vendor = second / "vendor" / SET
        vendor.mkdir(parents=True)
        (vendor / SKILL).symlink_to(catalog[SKILL])

        reporter = Reporter()
        hit = find_in_roots([first, second], "vendor/demo")
        assert hit is not None and hit.root == second
        _report_skipped(reporter, hit, "vendor/demo")

        warning = only(reporter, Code.W_STALE_REGISTRY_CANDIDATE)
        assert warning.detail == (f"skipped {first} (exists, but has no vendor/demo)",)
        # The premise the message would otherwise contradict.
        assert (first / "sets" / SET).is_dir()

    def test_a_set_with_registry_path_reports_the_override_end_to_end(
        self, sandbox: Sandbox, tmp_path: Path
    ) -> None:
        first = make_registry(tmp_path / "first")
        second = make_registry(tmp_path / "second")
        write_set(first, SET, [("realdir", SKILL)])
        catalog = write_catalog(second, SKILL)
        vendor = second / "vendor" / SET
        vendor.mkdir(parents=True)
        (vendor / SKILL).symlink_to(catalog[SKILL])

        desired, reporter = compose_global(
            sandbox,
            [first, second],
            sets=[{"name": SET, "registry_path": f"vendor/{SET}"}],
        )

        assert desired.bindings[SKILL].target == catalog[SKILL]
        warning = only(reporter, Code.W_STALE_REGISTRY_CANDIDATE)
        assert f"vendor/{SET}" in warning.message
        assert warning.detail == (f"skipped {first} (exists, but has no vendor/{SET})",)
        assert f"sets/{SET}" not in "".join(warning.detail)

    def test_a_missing_set_names_the_override_it_looked_for(
        self, sandbox: Sandbox, tmp_path: Path
    ) -> None:
        """E_SET_MISSING must not claim it looked for ``sets/demo``. It did not."""
        only_rung = make_registry(tmp_path / "only")
        write_set(only_rung, SET, [("realdir", SKILL)])
        write_catalog(only_rung, SKILL)

        with pytest.raises(RefusalError) as excinfo:
            compose_global(
                sandbox,
                [only_rung],
                sets=[{"name": SET, "registry_path": f"vendor/{SET}"}],
            )

        finding = excinfo.value.finding
        assert finding.code is Code.E_SET_MISSING
        assert f"vendor/{SET}" in finding.message
        assert finding.detail == (f"{only_rung}  exists, but has no vendor/{SET}",)

    def test_a_missing_pack_names_the_override_it_looked_for(
        self, sandbox: Sandbox, tmp_path: Path
    ) -> None:
        only_rung = make_registry(tmp_path / "only")
        write_pack(only_rung, PACK, skills=[SKILL])

        with pytest.raises(RefusalError) as excinfo:
            compose_global(
                sandbox,
                [only_rung],
                packs=[{"name": PACK, "registry_path": f"vendor/{PACK}"}],
            )

        finding = excinfo.value.finding
        assert finding.code is Code.E_PACK_MISSING
        assert f"vendor/{PACK}" in finding.message
        assert finding.detail == (f"{only_rung}  exists, but has no vendor/{PACK}",)

    def test_the_default_label_is_unchanged_when_no_override_is_given(
        self, sandbox: Sandbox, tmp_path: Path
    ) -> None:
        """The control: without ``registry_path`` the wording must not have moved."""
        only_rung = make_registry(tmp_path / "only")

        with pytest.raises(RefusalError) as excinfo:
            compose_global(sandbox, [only_rung], sets=[SET])

        finding = excinfo.value.finding
        assert finding.code is Code.E_SET_MISSING
        assert finding.detail == (f"{only_rung}  exists, but has no sets/{SET}",)


# ===========================================================================
# The pack-member lookup: the one find_in_roots call site that used to be mute
# ===========================================================================


class TestManifestOnlyPackMembersReportTheStaleRung:
    """``expand_pack`` resolves each manifest-only member with its own
    ``find_in_roots(roots, f"all-skills/{name}")``, and that call site alone never
    reported what it walked past. A pack whose members all resolve one rung down
    from the checkout the operator believes is authoritative was silent.

    Wiring it naively is the reason it stayed unwired: :class:`Reporter` does not
    deduplicate (once per offending name is correct everywhere else), and this
    runs once per MEMBER -- ``packs/hermes-base`` expands to 73 -- so the honest
    fix has to report the ladder fact once, not once per member.
    """

    MEMBERS = ("m-one", "m-two", "m-three")

    @staticmethod
    def _ladder(tmp_path: Path) -> tuple[Path, Path]:
        """Rung 1 exists and carries an ``all-skills/`` -- just not these members."""
        cache = tmp_path / "cache-clone"
        (cache / "all-skills").mkdir(parents=True)
        write_skill(cache / "all-skills", "something-else")

        checkout = make_registry(tmp_path / "checkout")
        write_catalog(checkout, *TestManifestOnlyPackMembersReportTheStaleRung.MEMBERS)
        # `declared` with no matching directories IS the manifest-only pack: every
        # member has to come from all-skills/.
        write_pack(
            checkout, PACK, declared=list(TestManifestOnlyPackMembersReportTheStaleRung.MEMBERS)
        )
        return cache, checkout

    def _member_findings(self, reporter: Reporter) -> list[Any]:
        """Stale-rung findings raised by the MEMBER lookup, not the pack lookup.

        The `packs[]` lookup skips the same rung and legitimately reports it too;
        that one names ``packs/<name>``, these name ``all-skills/<member>``.
        """
        return [
            f
            for f in reporter.findings
            if f.code is Code.W_STALE_REGISTRY_CANDIDATE and "all-skills/" in " ".join(f.detail)
        ]

    def test_a_member_resolving_past_a_stale_rung_is_reported_at_all(
        self, sandbox: Sandbox, tmp_path: Path
    ) -> None:
        """Fails before the fix: this call site emitted nothing, ever."""
        cache, checkout = self._ladder(tmp_path)

        desired, reporter = compose_global(sandbox, [cache, checkout], packs=[PACK])

        assert set(desired.bindings) == set(self.MEMBERS)
        found = self._member_findings(reporter)
        assert found, (
            "a manifest-only pack member walked past an existing checkout and "
            f"said nothing; got {codes(reporter)}"
        )
        assert found[0].path == checkout
        assert any(str(cache) in line for line in found[0].detail)

    def test_it_states_the_ladder_fact_once_not_once_per_member(
        self, sandbox: Sandbox, tmp_path: Path
    ) -> None:
        """Fails if the call site is wired WITHOUT the suppression set.

        Three members here; hermes-base has 73. One repeated fact about the ladder
        must not bury the run.
        """
        cache, checkout = self._ladder(tmp_path)

        _, reporter = compose_global(sandbox, [cache, checkout], packs=[PACK])

        assert len(self._member_findings(reporter)) == 1, (
            "the ladder fact was reported once per member: "
            f"{[f.message for f in self._member_findings(reporter)]}"
        )

    def test_a_one_rung_ladder_stays_silent(self, sandbox: Sandbox, tmp_path: Path) -> None:
        """The control. Nothing was walked past, so there is nothing to say --
        without this, an unconditional emit would satisfy the two tests above.
        """
        _, checkout = self._ladder(tmp_path)

        _, reporter = compose_global(sandbox, [checkout], packs=[PACK])

        assert Code.W_STALE_REGISTRY_CANDIDATE not in codes(reporter)


class TestExplicitRegistryRootOutranksTheManifest:
    """``--registry-root`` is documented as "Override the registry ladder."

    It used to lose to a ``registry`` key in the manifest: ``sync.py`` computed
    ``registry_roots(manifest.registry) if manifest.registry else roots``, so for
    any manifest that declared a registry the flag was discarded outright and the
    run resolved against the cache ladder the key implies. The one surface a user
    reaches for to FORCE a ladder was the one surface that could not, and it
    failed silently -- no finding, no note, just resolution somewhere else.

    A per-invocation flag is both more specific and more deliberate than a
    committed config file, so it wins.
    """

    def test_the_flag_wins_over_a_registry_key_and_the_set_resolves(
        self, sandbox: Sandbox, tmp_path: Path, run_sync_json: Any
    ) -> None:
        """Fails before the fix: the manifest's ladder answers and the set is missing."""
        checkout = make_registry(tmp_path / "explicit")
        catalog = write_catalog(checkout, SKILL)
        write_set(checkout, SET, [("link", SKILL, catalog[SKILL])])
        # A registry key whose cache rung does not exist and never carried this set.
        sandbox.write_global_manifest(
            sets=[SET], registry="https://github.com/example/not-cloned.git"
        )

        exit_code, payload = run_sync_json(
            "--registry-root", str(checkout), "--dry-run", cwd=outside(sandbox)
        )

        assert exit_code == 0, json_codes(payload)
        assert Code.E_SET_MISSING.value not in json_codes(payload)
        assert Code.E_NO_REGISTRY.value not in json_codes(payload)

    def test_without_the_flag_the_registry_key_still_builds_the_ladder(
        self, sandbox: Sandbox, run_sync_json: Any
    ) -> None:
        """The control: the fix must not stop a declared ``registry`` from working.

        Same manifest, no flag. The declared registry's ladder has no checkout
        behind it, so this run cannot resolve -- which is the proof that the run
        above resolved because of the FLAG and not because the key was ignored.
        """
        sandbox.write_global_manifest(
            sets=[SET], registry="https://github.com/example/not-cloned.git"
        )

        exit_code, payload = run_sync_json("--dry-run", cwd=outside(sandbox))

        assert exit_code == EXIT_CONFIG
        assert {Code.E_SET_MISSING.value, Code.E_NO_REGISTRY.value} & set(json_codes(payload))
