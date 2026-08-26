"""Contract section 2 step 3: the registry checkout ladder.

    PJ_SKILLS_REGISTRY_ROOT | ~/.agents/.cache/registries/<sanitized-url> | ~/code/skillex

The regression these tests pin: resolution used to stop at the first candidate
DIRECTORY that existed and hard-bind to it. `sync-skills.py` always creates the
cache clone, so every lower rung became dead code - and that clone is a clone of
what has been *pushed*, so it routinely carries a `packs/<name>/<version>/`
directory that predates the RENDERING of that pack.

The failure was silent: the same `name@version` resolved to an unsealed copy
(no pack.toml, inventory globbed off directory names) while the attested
`[policy] sealed = true` copy sat one rung down. Checksum verification was
skipped entirely and nothing said so.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest
from pydantic import ValidationError

from skillex.commands.pack import _resolve_entry_root, _resolve_entry_root_across
from skillex.core.loader import PackError
from skillex.core.models import PackEntry
from skillex.paths import registry_root_candidates

PACK = "demo"
VERSION = "2.0.0"
SKILL = "alpha"


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def write_pack(registry_root: Path, kind: str, version: str = VERSION) -> Path:
    """`kind` is one of ``sealed``, ``plain``, ``unattested`` (no pack.toml)."""
    pack_root = registry_root / "packs" / PACK / version
    (pack_root / SKILL).mkdir(parents=True)
    skill_body = f"# {SKILL} ({kind})\n"
    (pack_root / SKILL / "SKILL.md").write_text(skill_body)
    if kind == "unattested":
        return pack_root

    toml = f'[pack]\nname = "{PACK}"\nversion = "{version}"\n\n[freeform]\nskills = ["{SKILL}"]\n'
    if kind == "sealed":
        toml += "\n[policy]\nsealed = true\n"
    (pack_root / "pack.toml").write_text(toml)

    if kind == "sealed":
        lines = sorted(
            [f"{_sha256(toml)}  pack.toml", f"{_sha256(skill_body)}  {SKILL}/SKILL.md"],
            key=lambda line: line[66:],
        )
        (pack_root / "SHA256SUMS").write_text("\n".join(lines) + "\n")
    return pack_root


@pytest.fixture()
def ladder(tmp_path: Path) -> tuple[Path, Path]:
    """A two-rung ladder: (higher-priority cache, lower-priority checkout)."""
    cache = tmp_path / "cache"
    fallback = tmp_path / "code-skillex"
    (cache / "packs").mkdir(parents=True)
    (fallback / "packs").mkdir(parents=True)
    return cache, fallback


def entry(version: str | None = VERSION) -> PackEntry:
    return PackEntry(name=PACK, version=version)


class TestLadderRanking:
    def test_unattested_copy_does_not_shadow_the_attested_one(self, ladder) -> None:
        """THE regression: a stale clone must not hide the rendered, sealed pack."""
        cache, fallback = ladder
        shadowing = write_pack(cache, "unattested")
        sealed = write_pack(fallback, "sealed")

        # What the old single-root resolution did, spelled out: bind to the first
        # existing checkout and never look further. Both copies claim the same
        # name@version, and only one of them is actually the pack.
        assert _resolve_entry_root(cache / "packs", entry()) == shadowing

        assert _resolve_entry_root_across([cache, fallback], entry()) == sealed

    def test_contract_order_breaks_ties_between_attested_roots(self, ladder) -> None:
        cache, fallback = ladder
        cached = write_pack(cache, "sealed")
        write_pack(fallback, "sealed")
        assert _resolve_entry_root_across([cache, fallback], entry()) == cached

    def test_promotion_can_never_downgrade_a_sealed_pack(self, ladder) -> None:
        """Attestation ranks; sealing is never traded away for it."""
        cache, fallback = ladder
        cached = write_pack(cache, "sealed")
        write_pack(fallback, "plain")
        assert _resolve_entry_root_across([cache, fallback], entry()) == cached

    def test_ladder_walks_past_a_checkout_missing_the_pinned_version(self, ladder) -> None:
        cache, fallback = ladder
        write_pack(cache, "sealed", version="1.0.0")
        sealed = write_pack(fallback, "sealed", version=VERSION)
        assert _resolve_entry_root_across([cache, fallback], entry()) == sealed

    def test_absent_everywhere_is_an_error_naming_every_root(self, ladder) -> None:
        cache, fallback = ladder
        with pytest.raises(PackError) as excinfo:
            _resolve_entry_root_across([cache, fallback], entry())
        assert str(cache) in str(excinfo.value)
        assert str(fallback) in str(excinfo.value)

    def test_version_mismatch_in_pack_toml_is_not_attestation(self, ladder) -> None:
        """`[pack].version` must match the PIN, not merely exist."""
        cache, fallback = ladder
        # Same directory name, pack.toml claiming a different version.
        pack_root = cache / "packs" / PACK / VERSION
        (pack_root / SKILL).mkdir(parents=True)
        (pack_root / SKILL / "SKILL.md").write_text("# alpha\n")
        (pack_root / "pack.toml").write_text(
            f'[pack]\nname = "{PACK}"\nversion = "9.9.9"\n\n[freeform]\nskills = ["{SKILL}"]\n'
        )
        sealed = write_pack(fallback, "sealed")
        assert _resolve_entry_root_across([cache, fallback], entry()) == sealed


class TestLadderWalksPastAbsenceOnly:
    """A candidate that is present-but-hostile must RAISE, never be bypassed."""

    def test_symlinked_pack_family_hard_fails(self, ladder) -> None:
        cache, fallback = ladder
        write_pack(fallback, "sealed")
        (cache / "packs" / PACK).symlink_to(fallback / "packs" / PACK)
        with pytest.raises(PackError):
            _resolve_entry_root_across([cache, fallback], entry())

    def test_symlinked_pack_root_hard_fails(self, ladder) -> None:
        cache, fallback = ladder
        sealed = write_pack(fallback, "sealed")
        (cache / "packs" / PACK).mkdir(parents=True)
        (cache / "packs" / PACK / VERSION).symlink_to(sealed)
        with pytest.raises(PackError):
            _resolve_entry_root_across([cache, fallback], entry())

    def test_dot_dot_in_registry_path_never_even_constructs(self) -> None:
        """The outer guard: `..` is rejected by the model, before any resolution."""
        with pytest.raises(ValidationError):
            PackEntry(name=PACK, registry_path="../../../etc")

    def test_symlink_escape_is_reported_not_softened_into_absence(self, ladder) -> None:
        """The reachable escape: a legal `registry_path` that traverses a symlink.

        `..` cannot survive `PackEntry`, so the only way out of the registry root
        is a symlinked component. That must RAISE - never be quietly downgraded
        into "this checkout just doesn't have it" and walked past.
        """
        cache, fallback = ladder
        write_pack(fallback, "sealed")
        (cache / "packs" / "evil").symlink_to(Path("/etc"))
        escaping = PackEntry(name=PACK, registry_path="packs/evil")
        with pytest.raises(PackError, match="escapes the registry root"):
            _resolve_entry_root_across([cache, fallback], escaping)


class TestEnvOverrideIsExclusive:
    """`PJ_SKILLS_REGISTRY_ROOT` is EXCLUSIVE, not merely first.

    Pinning it is a deliberate act - a suite points it at a fixture, an operator
    points it at a vetted checkout. If the ladder could fall through it, a pack
    missing from the pinned root would be served silently from the developer's
    real `~/code/skillex`. pjangler's `packRegistryRoots` behaves the same way and
    the two surfaces must not diverge.
    """

    def test_env_override_replaces_the_whole_ladder(self, monkeypatch) -> None:
        monkeypatch.setenv("PJ_SKILLS_REGISTRY_ROOT", "/tmp/explicit-registry")
        candidates = registry_root_candidates("https://github.com/delorenj/skillex.git")
        assert candidates == [Path("/tmp/explicit-registry")]

    def test_without_the_env_the_full_ladder_is_offered(self, monkeypatch) -> None:
        monkeypatch.delenv("PJ_SKILLS_REGISTRY_ROOT", raising=False)
        candidates = registry_root_candidates("https://github.com/delorenj/skillex.git")
        assert len(candidates) == 2
        assert candidates[-1] == Path("~/code/skillex").expanduser()
