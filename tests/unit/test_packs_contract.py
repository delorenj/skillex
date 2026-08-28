"""Tests for PACKS-CONTRACT.md: version dirs, inventory, sealing, render/verify.

Section references are to PACKS-CONTRACT.md.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import tomllib
from pathlib import Path

import pytest

from skillex.core.linter import RuleCode, Severity, has_errors, is_sealed, lint_pack_contract
from skillex.core.loader import (
    ManifestError,
    PackError,
    flatten_inventory,
    load_pack_standalone,
    load_skills_manifest,
    resolve_inventory,
    resolve_pack_dir,
    select_pack_version,
    version_sort_key,
)
from skillex.core.models import PackEntry, is_safe_component, is_safe_relpath
from skillex.core.payload import (
    PayloadError,
    parse_sha256sums,
    payload_entries,
    payload_paths,
    render_sha256sums,
    unauthenticated_directories,
)
from skillex.core.renderer import RenderError, apply_render, plan_render
from skillex.paths import registry_root_candidates, sanitize_registry_url


def make_pack(root: Path, skills: dict[str, dict[str, str]] | None = None) -> Path:
    """Create a pack root with the given `{skill: {relpath: content}}` layout."""
    root.mkdir(parents=True, exist_ok=True)
    layout = skills if skills is not None else {"alpha": {"SKILL.md": "---\nname: alpha\n---\n"}}
    for skill, files in layout.items():
        (root / skill).mkdir(parents=True, exist_ok=True)
        for rel, content in files.items():
            target = root / skill / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
    return root


def rules(issues: list) -> set[str]:
    return {i.rule.value for i in issues}


class TestSafeComponents:
    @pytest.mark.parametrize("value", ["a", "bmad", "6.10.1-next.31", "Kurzgesagt", "a_b"])
    def test_accepts(self, value: str) -> None:
        assert is_safe_component(value)

    @pytest.mark.parametrize("value", ["", ".", "..", "a/b", "a\\b", " a", "a ", "a\x00b"])
    def test_rejects(self, value: str) -> None:
        assert not is_safe_component(value)

    @pytest.mark.parametrize("value", ["a.md", "a/b/c.md", "s/SKILL.md"])
    def test_relpath_accepts(self, value: str) -> None:
        assert is_safe_relpath(value)

    @pytest.mark.parametrize("value", ["/etc/passwd", "../x", "a/../b", "a//b", "./x", "a\\b", ""])
    def test_relpath_rejects(self, value: str) -> None:
        assert not is_safe_relpath(value)


class TestVersionOrdering:
    def test_prerelease_sorts_below_its_release(self) -> None:
        assert version_sort_key("6.10.1-next.31") < version_sort_key("6.10.1")

    def test_numeric_segments_compare_numerically(self) -> None:
        assert version_sort_key("6.9.9") < version_sort_key("6.10.2")

    def test_highest_wins(self) -> None:
        versions = ["6.10.1-next.31", "6.10.1", "6.9.9", "6.10.2"]
        assert max(versions, key=version_sort_key) == "6.10.2"


class TestResolvePackDir:
    def test_explicit_version(self, tmp_path: Path) -> None:
        make_pack(tmp_path / "packs" / "p" / "1.2.3")
        assert resolve_pack_dir(tmp_path / "packs", "p", "1.2.3").name == "1.2.3"

    def test_autoselects_highest_version(self, tmp_path: Path) -> None:
        packs = tmp_path / "packs"
        for v in ("6.10.1-next.31", "6.10.1", "6.10.2"):
            make_pack(packs / "p" / v)
        assert resolve_pack_dir(packs, "p").name == "6.10.2"

    def test_flat_pack_with_manifest_is_not_descended(self, tmp_path: Path) -> None:
        packs = tmp_path / "packs"
        root = make_pack(packs / "p")
        (root / "pack.toml").write_text('[pack]\nname = "p"\n', encoding="utf-8")
        make_pack(packs / "p" / "9.9.9")
        assert resolve_pack_dir(packs, "p") == packs / "p"

    def test_manifestless_skill_dirs_are_not_versions(self, tmp_path: Path) -> None:
        """`packs/<name>/{alpha,beta}/SKILL.md` is a flat pack, not two versions.

        "Only subdirectories" is necessary but not sufficient; a child holding a
        regular SKILL.md is a skill, so the parent is flat. Descending into one of
        them would silently yield an EMPTY inventory.
        """
        packs = tmp_path / "packs"
        make_pack(packs / "p", {"alpha": {"SKILL.md": "a\n"}, "beta": {"SKILL.md": "b\n"}})
        assert select_pack_version(packs / "p") is None
        assert resolve_pack_dir(packs, "p") == packs / "p"
        assert load_pack_standalone(packs / "p").inventory == ["alpha", "beta"]

    def test_symlinked_child_is_not_a_version_layout(self, tmp_path: Path) -> None:
        """packs/Kurzgesagt is twelve symlinks; a symlinked child means flat."""
        packs = tmp_path / "packs"
        make_pack(packs / "p" / "6.10.2")
        target = make_pack(tmp_path / "elsewhere" / "linked")
        (packs / "p" / "linked").symlink_to(target)
        assert select_pack_version(packs / "p") is None
        assert resolve_pack_dir(packs, "p") == packs / "p"

    def test_loose_file_is_not_a_version_layout(self, tmp_path: Path) -> None:
        packs = tmp_path / "packs"
        make_pack(packs / "p" / "6.10.2")
        (packs / "p" / "README.md").write_text("stray\n", encoding="utf-8")
        assert select_pack_version(packs / "p") is None
        assert resolve_pack_dir(packs, "p") == packs / "p"

    def test_escaping_name_rejected(self, tmp_path: Path) -> None:
        with pytest.raises(PackError):
            resolve_pack_dir(tmp_path / "packs", "../escape")

    def test_symlinked_pack_root_rejected(self, tmp_path: Path) -> None:
        packs = tmp_path / "packs"
        real = make_pack(tmp_path / "elsewhere" / "p")
        packs.mkdir(parents=True)
        (packs / "p").symlink_to(real)
        with pytest.raises(PackError, match="must not be a symlink"):
            resolve_pack_dir(packs, "p")


class TestStandaloneLoader:
    def test_globs_skill_dirs_without_manifest(self, tmp_path: Path) -> None:
        root = make_pack(
            tmp_path / "packs" / "kur",
            {
                "beta": {"SKILL.md": "b\n"},
                "alpha": {"SKILL.md": "a\n"},
                ".hidden": {"SKILL.md": "h\n"},
                "_private": {"SKILL.md": "p\n"},
                "nodocs": {"README.md": "no skill md\n"},
            },
        )
        pack = load_pack_standalone(root)
        assert pack.inventory == ["alpha", "beta"]
        assert not pack.has_manifest

    def test_symlinked_skill_dir_is_never_inventory(self, tmp_path: Path) -> None:
        outside = make_pack(tmp_path / "outside" / "x", {"real": {"SKILL.md": "r\n"}})
        root = tmp_path / "packs" / "p"
        root.mkdir(parents=True)
        (root / "linked").symlink_to(outside / "real")
        pack = load_pack_standalone(root)
        assert pack.inventory == []
        assert RuleCode.SKILL_DIR_SYMLINK_SKIPPED.value in rules(lint_pack_contract(pack))

    def test_uppercase_pack_name_loads_but_warns(self, tmp_path: Path) -> None:
        root = make_pack(tmp_path / "packs" / "Kurzgesagt", {"alpha": {"SKILL.md": "a\n"}})
        pack = load_pack_standalone(root)
        assert pack.manifest.name == "Kurzgesagt"
        issues = lint_pack_contract(pack)
        assert RuleCode.PACK_NAME_NONCANONICAL.value in rules(issues)
        assert not has_errors(issues)

    def test_reads_source_and_policy(self, tmp_path: Path) -> None:
        root = make_pack(tmp_path / "packs" / "p" / "1.0.0", {"alpha": {"SKILL.md": "a\n"}})
        (root / "pack.toml").write_text(
            '[pack]\nname = "p"\nversion = "1.0.0"\n\n'
            '[source]\nupstream = "up"\nupstream_version = "1.0.0"\n'
            'rendered_from = ".agent/skills"\npayload_files = 1\nextra_key = "kept"\n\n'
            '[freeform]\nskills = ["alpha"]\n\n'
            "[policy]\nimmutable = true\nsealed = true\n"
            'project_projection = "symlink"\noverlay_wins = true\n',
            encoding="utf-8",
        )
        pack = load_pack_standalone(root)
        assert pack.manifest.source.upstream == "up"
        assert pack.manifest.source.payload_files == 1
        assert pack.manifest.policy.immutable and pack.manifest.policy.sealed
        assert pack.manifest.policy.project_projection == "symlink"
        assert pack.version_dir == "1.0.0" and pack.dir_name == "p"
        # extra keys survive the round-trip rather than being dropped
        assert pack.manifest.source.model_dump()["extra_key"] == "kept"
        assert pack.manifest.policy.model_dump()["overlay_wins"] is True

    def test_symlinked_root_rejected(self, tmp_path: Path) -> None:
        real = make_pack(tmp_path / "real")
        link = tmp_path / "link"
        link.symlink_to(real)
        with pytest.raises(PackError, match="must not be a symlink"):
            load_pack_standalone(link)


class TestContractLinter:
    def _sealed_pack(self, tmp_path: Path) -> Path:
        root = make_pack(
            tmp_path / "packs" / "p" / "1.0.0",
            {"alpha": {"SKILL.md": "a\n", "ref/notes.md": "n\n"}},
        )
        apply_render(plan_render(root, "p", "1.0.0"))
        return root

    def test_sealed_pack_verifies(self, tmp_path: Path) -> None:
        root = self._sealed_pack(tmp_path)
        pack = load_pack_standalone(root)
        assert is_sealed(pack)
        assert lint_pack_contract(pack) == []

    def test_name_mismatch_is_an_error(self, tmp_path: Path) -> None:
        root = make_pack(tmp_path / "packs" / "p", {"alpha": {"SKILL.md": "a\n"}})
        (root / "pack.toml").write_text(
            '[pack]\nname = "other"\n\n[freeform]\nskills = ["alpha"]\n', encoding="utf-8"
        )
        assert RuleCode.PACK_NAME_MISMATCH.value in rules(
            lint_pack_contract(load_pack_standalone(root))
        )

    def test_version_mismatch_is_an_error(self, tmp_path: Path) -> None:
        root = make_pack(tmp_path / "packs" / "p" / "1.0.0", {"alpha": {"SKILL.md": "a\n"}})
        (root / "pack.toml").write_text(
            '[pack]\nname = "p"\nversion = "2.0.0"\n\n[freeform]\nskills = ["alpha"]\n',
            encoding="utf-8",
        )
        assert RuleCode.PACK_VERSION_MISMATCH.value in rules(
            lint_pack_contract(load_pack_standalone(root))
        )

    def test_declared_skill_without_directory(self, tmp_path: Path) -> None:
        root = make_pack(tmp_path / "packs" / "p", {"alpha": {"SKILL.md": "a\n"}})
        (root / "pack.toml").write_text(
            '[pack]\nname = "p"\n\n[freeform]\nskills = ["alpha", "ghost"]\n', encoding="utf-8"
        )
        assert RuleCode.SKILL_DIR_MISSING.value in rules(
            lint_pack_contract(load_pack_standalone(root))
        )

    def test_declared_skill_without_skill_md(self, tmp_path: Path) -> None:
        root = make_pack(tmp_path / "packs" / "p", {"alpha": {"SKILL.md": "a\n"}})
        (root / "category").mkdir()
        (root / "category" / "DESCRIPTION.md").write_text("d\n", encoding="utf-8")
        (root / "pack.toml").write_text(
            '[pack]\nname = "p"\n\n[freeform]\nskills = ["alpha", "category"]\n', encoding="utf-8"
        )
        assert RuleCode.SKILL_MD_MISSING.value in rules(
            lint_pack_contract(load_pack_standalone(root))
        )

    def test_symlinked_skill_md_is_rejected(self, tmp_path: Path) -> None:
        root = make_pack(tmp_path / "packs" / "p", {"alpha": {}})
        real = tmp_path / "real.md"
        real.write_text("a\n", encoding="utf-8")
        (root / "alpha" / "SKILL.md").symlink_to(real)
        (root / "pack.toml").write_text(
            '[pack]\nname = "p"\n\n[freeform]\nskills = ["alpha"]\n', encoding="utf-8"
        )
        assert RuleCode.SKILL_MD_MISSING.value in rules(
            lint_pack_contract(load_pack_standalone(root))
        )

    def test_payload_count_mismatch(self, tmp_path: Path) -> None:
        root = self._sealed_pack(tmp_path)
        text = (root / "pack.toml").read_text(encoding="utf-8")
        (root / "pack.toml").write_text(
            text.replace("payload_files = 2", "payload_files = 99"), encoding="utf-8"
        )
        assert RuleCode.PAYLOAD_COUNT_MISMATCH.value in rules(
            lint_pack_contract(load_pack_standalone(root))
        )

    def test_tampered_payload_fails_the_seal(self, tmp_path: Path) -> None:
        root = self._sealed_pack(tmp_path)
        (root / "alpha" / "SKILL.md").write_text("tampered\n", encoding="utf-8")
        assert RuleCode.SUMS_DIGEST_MISMATCH.value in rules(
            lint_pack_contract(load_pack_standalone(root))
        )

    def test_new_payload_file_not_covered_by_sums(self, tmp_path: Path) -> None:
        root = self._sealed_pack(tmp_path)
        (root / "alpha" / "sneaked.md").write_text("s\n", encoding="utf-8")
        assert RuleCode.SUMS_UNCOVERED_FILE.value in rules(
            lint_pack_contract(load_pack_standalone(root))
        )

    def test_planted_empty_directory_fails_the_seal(self, tmp_path: Path) -> None:
        """An empty dir is covered by no checksum, so it can be planted undetected.

        Parity: `sync-skills.py` and `src/parity/pack.ts` both reject this
        ("unauthenticated empty directories"); skillex must too, or a tampered
        sealed pack passes here and fails there.
        """
        root = self._sealed_pack(tmp_path)
        assert lint_pack_contract(load_pack_standalone(root)) == []

        (root / "alpha" / "emptydir").mkdir()
        issues = lint_pack_contract(load_pack_standalone(root))
        assert RuleCode.PAYLOAD_UNAUTHENTICATED_DIR.value in rules(issues)
        assert has_errors(issues)
        assert any("alpha/emptydir" in i.message for i in issues)

        # Nothing else changed, so removing it restores a clean verify.
        (root / "alpha" / "emptydir").rmdir()
        assert lint_pack_contract(load_pack_standalone(root)) == []

    def test_planted_directory_of_empty_directories_fails_the_seal(self, tmp_path: Path) -> None:
        """Only the deepest unauthenticated dir is not enough: report every one."""
        root = self._sealed_pack(tmp_path)
        (root / "alpha" / "outer" / "inner").mkdir(parents=True)
        issues = lint_pack_contract(load_pack_standalone(root))
        reported = {i.message for i in issues if i.rule is RuleCode.PAYLOAD_UNAUTHENTICATED_DIR}
        assert len(reported) == 2
        assert any("alpha/outer'" in m for m in reported)
        assert any("alpha/outer/inner'" in m for m in reported)

    def test_directory_holding_a_payload_file_is_authenticated(self, tmp_path: Path) -> None:
        """`alpha/ref/` holds `notes.md`, so it is authenticated transitively."""
        root = self._sealed_pack(tmp_path)
        payload = payload_entries(root, ["alpha"])
        assert "alpha/ref" in payload.directories
        assert unauthenticated_directories(payload.files, payload.directories) == []

    def test_empty_directory_outside_the_payload_is_ignored(self, tmp_path: Path) -> None:
        """Contract section 4 rule 6: non-payload paths are ignored, empty or not.

        `packs/bmad/6.10.2` really does carry an empty `_bmad-output/` at its root.
        """
        root = self._sealed_pack(tmp_path)
        (root / "_bmad-output").mkdir()
        (root / ".claude").mkdir()
        assert lint_pack_contract(load_pack_standalone(root)) == []

    def test_render_refuses_to_seal_a_tree_with_an_empty_directory(self, tmp_path: Path) -> None:
        """Rendering it would emit a pack that fails verification immediately."""
        root = make_pack(tmp_path / "packs" / "p" / "1.0.0", {"alpha": {"SKILL.md": "a\n"}})
        (root / "alpha" / "hollow").mkdir()
        with pytest.raises(RenderError, match="contain no file"):
            plan_render(root, "p", "1.0.0")
        assert not (root / "pack.toml").exists(), "a refused render must not mutate"
        assert not (root / "SHA256SUMS").exists()

        # Unsealed renders are unaffected: the seal rule is what needs the directory.
        plan_render(root, "p", "1.0.0", sealed=False)

    def test_unsealed_pack_tolerates_empty_directories(self, tmp_path: Path) -> None:
        """Unsealed packs get structural validation only (contract section 4)."""
        root = make_pack(tmp_path / "packs" / "p", {"alpha": {"SKILL.md": "a\n"}})
        (root / "alpha" / "emptydir").mkdir()
        (root / "pack.toml").write_text(
            '[pack]\nname = "p"\n\n[freeform]\nskills = ["alpha"]\n', encoding="utf-8"
        )
        pack = load_pack_standalone(root)
        assert not is_sealed(pack)
        assert lint_pack_contract(pack) == []

    def test_sums_entry_for_a_missing_file(self, tmp_path: Path) -> None:
        root = self._sealed_pack(tmp_path)
        sums = root / "SHA256SUMS"
        sums.write_text(
            sums.read_text(encoding="utf-8") + f"{'0' * 64}  gone.md\n", encoding="utf-8"
        )
        assert RuleCode.SUMS_ORPHAN_ENTRY.value in rules(
            lint_pack_contract(load_pack_standalone(root))
        )

    def test_extra_non_payload_file_is_legal_but_verified(self, tmp_path: Path) -> None:
        """Contract section 4 rule 3: SHA256SUMS may cover README.md; it is still checked."""
        root = self._sealed_pack(tmp_path)
        readme = root / "README.md"
        readme.write_text("hello\n", encoding="utf-8")
        digest = hashlib.sha256(b"hello\n").hexdigest()
        sums = root / "SHA256SUMS"
        sums.write_text(
            f"{digest}  README.md\n" + sums.read_text(encoding="utf-8"), encoding="utf-8"
        )
        assert lint_pack_contract(load_pack_standalone(root)) == []

        readme.write_text("changed\n", encoding="utf-8")
        assert RuleCode.SUMS_DIGEST_MISMATCH.value in rules(
            lint_pack_contract(load_pack_standalone(root))
        )

    def test_unlisted_non_payload_file_is_ignored(self, tmp_path: Path) -> None:
        """Contract section 4 rule 6: `.claude/`, `mise.toml` etc. are simply ignored."""
        root = self._sealed_pack(tmp_path)
        (root / ".claude").mkdir()
        (root / ".claude" / "settings.json").write_text("{}\n", encoding="utf-8")
        (root / "mise.toml").write_text("[tasks]\n", encoding="utf-8")
        assert lint_pack_contract(load_pack_standalone(root)) == []

    def test_sealed_pack_without_sums(self, tmp_path: Path) -> None:
        root = self._sealed_pack(tmp_path)
        (root / "SHA256SUMS").unlink()
        assert RuleCode.SUMS_MISSING.value in rules(lint_pack_contract(load_pack_standalone(root)))

    def test_unsealed_pack_needs_no_sums(self, tmp_path: Path) -> None:
        root = make_pack(tmp_path / "packs" / "p", {"alpha": {"SKILL.md": "a\n"}})
        (root / "pack.toml").write_text(
            '[pack]\nname = "p"\n\n[freeform]\nskills = ["alpha"]\n\n[policy]\nimmutable = true\n',
            encoding="utf-8",
        )
        pack = load_pack_standalone(root)
        assert not is_sealed(pack), "immutable alone must NOT imply sealed"
        assert lint_pack_contract(pack) == []

    def test_manifest_sealed_override_tightens(self, tmp_path: Path) -> None:
        root = make_pack(tmp_path / "packs" / "p", {"alpha": {"SKILL.md": "a\n"}})
        (root / "pack.toml").write_text(
            '[pack]\nname = "p"\n\n[freeform]\nskills = ["alpha"]\n', encoding="utf-8"
        )
        pack = load_pack_standalone(root)
        assert lint_pack_contract(pack, sealed=False) == []
        assert RuleCode.SUMS_MISSING.value in rules(lint_pack_contract(pack, sealed=True))

    def test_manifest_sealed_false_cannot_unseal(self, tmp_path: Path) -> None:
        root = self._sealed_pack(tmp_path)
        (root / "SHA256SUMS").unlink()
        pack = load_pack_standalone(root)
        assert is_sealed(pack, False), "sealed:false must not disable [policy] sealed = true"
        assert RuleCode.SUMS_MISSING.value in rules(lint_pack_contract(pack, sealed=False))


def make_flat_pack(root: Path, *, flatten: bool, declared: list[str]) -> Path:
    """Write a pack.toml declaring `declared`, with `[policy] flatten` set or absent."""
    policy = "\n[policy]\nflatten = true\n" if flatten else ""
    skills = ", ".join(f'"{name}"' for name in declared)
    (root / "pack.toml").write_text(
        f'[pack]\nname = "{root.name}"\n\n[freeform]\nskills = [{skills}]\n{policy}',
        encoding="utf-8",
    )
    return root


class TestFlattenedPacks:
    """Contract section 3b: two-level (container/leaf) upstream layouts."""

    def _two_level(self, tmp_path: Path, *, flatten: bool) -> Path:
        root = make_pack(
            tmp_path / "packs" / "p",
            {
                "solo": {"SKILL.md": "s\n"},
                "group": {
                    "DESCRIPTION.md": "d\n",
                    "one/SKILL.md": "1\n",
                    "two/SKILL.md": "2\n",
                },
            },
        )
        return make_flat_pack(root, flatten=flatten, declared=["group", "solo"])

    def test_flatten_is_off_by_default(self, tmp_path: Path) -> None:
        """Every pre-3b pack must behave EXACTLY as before: a container is an error."""
        root = self._two_level(tmp_path, flatten=False)
        pack = load_pack_standalone(root)
        assert resolve_inventory(pack).enabled is False
        assert resolve_inventory(pack).names == ["group", "solo"]
        assert RuleCode.SKILL_MD_MISSING.value in rules(lint_pack_contract(pack))

    def test_declared_container_is_correct_when_flattened(self, tmp_path: Path) -> None:
        root = self._two_level(tmp_path, flatten=True)
        pack = load_pack_standalone(root)
        issues = lint_pack_contract(pack)
        assert issues == [], [(i.rule.value, i.message) for i in issues]
        assert RuleCode.SKILL_MD_MISSING.value not in rules(issues)

    def test_leaves_are_projected_by_basename(self, tmp_path: Path) -> None:
        root = self._two_level(tmp_path, flatten=True)
        flat = resolve_inventory(load_pack_standalone(root))
        assert flat.enabled is True
        assert sorted(flat.names) == ["one", "solo", "two"]
        assert flat.by_name["one"].relpath == "group/one"
        assert flat.by_name["one"].declared == "group"
        assert flat.by_name["solo"].relpath == "solo"

    def test_entry_with_its_own_skill_md_is_taken_as_is(self, tmp_path: Path) -> None:
        """A declared entry holding a SKILL.md IS the skill; it is never descended into."""
        root = make_pack(
            tmp_path / "packs" / "p",
            {"solo": {"SKILL.md": "s\n", "references/inner/SKILL.md": "archived\n"}},
        )
        make_flat_pack(root, flatten=True, declared=["solo"])
        flat = resolve_inventory(load_pack_standalone(root))
        assert flat.names == ["solo"]

    def test_manifest_entry_can_turn_flattening_on(self, tmp_path: Path) -> None:
        root = self._two_level(tmp_path, flatten=False)
        pack = load_pack_standalone(root)
        assert resolve_inventory(pack, flatten=True).names == ["one", "two", "solo"]
        assert lint_pack_contract(pack, flatten=True) == []

    def test_manifest_flatten_false_cannot_unflatten(self, tmp_path: Path) -> None:
        root = self._two_level(tmp_path, flatten=True)
        pack = load_pack_standalone(root)
        assert resolve_inventory(pack, flatten=False).enabled is True
        assert lint_pack_contract(pack, flatten=False) == []

    def test_container_expanding_to_nothing_warns(self, tmp_path: Path) -> None:
        root = make_pack(tmp_path / "packs" / "p", {"solo": {"SKILL.md": "s\n"}})
        (root / "hollow").mkdir()
        (root / "hollow" / "DESCRIPTION.md").write_text("d\n", encoding="utf-8")
        make_flat_pack(root, flatten=True, declared=["hollow", "solo"])
        issues = lint_pack_contract(load_pack_standalone(root))
        empty = [i for i in issues if i.rule is RuleCode.SKILL_CONTAINER_EMPTY]
        assert [i.severity for i in empty] == [Severity.WARN]
        assert "hollow" in empty[0].message
        assert not has_errors(issues), "an empty container is a warning, never an error"

    def test_hostile_leaf_basenames_are_skipped_not_projected(self, tmp_path: Path) -> None:
        """Contract 3b: a flattened LEAF name is lifted straight off the filesystem.

        Without flatten a pack.toml pack projects exactly the strings its author typed
        into `[freeform].skills`. Flatten is the one place an upstream directory name
        becomes a symlink name in six CLI skill directories, where `-rf`, `--help`,
        `*` and embedded control characters are argv- and glob-hostile. Skipped with a
        WARN, never an error: one odd upstream directory must not brick a whole pack.
        """
        hostile = ["*", "--help", "-rf", "a\nb", "con:", "tab\there", "SKILL.md-ish", "Upper"]
        root = make_pack(
            tmp_path / "packs" / "p",
            {"grp": {"DESCRIPTION.md": "d\n", "good-leaf/SKILL.md": "g\n"}},
        )
        for name in hostile:
            leaf = root / "grp" / name
            leaf.mkdir(parents=True)
            (leaf / "SKILL.md").write_text("h\n", encoding="utf-8")
        make_flat_pack(root, flatten=True, declared=["grp"])

        pack = load_pack_standalone(root)
        flat = resolve_inventory(pack)
        assert flat.names == ["good-leaf"], "only canonically-named leaves are projected"
        assert set(flat.noncanonical) == {f"grp/{name}" for name in hostile}

        issues = lint_pack_contract(pack)
        skipped = [i for i in issues if i.rule is RuleCode.SKILL_LEAF_NONCANONICAL]
        assert len(skipped) == len(hostile)
        assert {i.severity for i in skipped} == {Severity.WARN}
        assert not has_errors(issues), "a hostile leaf name is a warning, never an error"

    def test_container_of_only_hostile_leaves_reports_empty(self, tmp_path: Path) -> None:
        """Rejecting every leaf must not silently empty a container (contract 3b)."""
        root = make_pack(tmp_path / "packs" / "p", {"solo": {"SKILL.md": "s\n"}})
        for name in ("-rf", "*"):
            leaf = root / "allbad" / name
            leaf.mkdir(parents=True)
            (leaf / "SKILL.md").write_text("h\n", encoding="utf-8")
        make_flat_pack(root, flatten=True, declared=["allbad", "solo"])

        pack = load_pack_standalone(root)
        assert resolve_inventory(pack).names == ["solo"]
        issues = lint_pack_contract(pack)
        assert RuleCode.SKILL_LEAF_NONCANONICAL.value in rules(issues)
        empty = [i for i in issues if i.rule is RuleCode.SKILL_CONTAINER_EMPTY]
        assert [i.severity for i in empty] == [Severity.WARN]
        assert "allbad" in empty[0].message
        assert not has_errors(issues)

    def test_declared_leaf_keeps_its_author_declared_name(self, tmp_path: Path) -> None:
        """The gate applies to EXPANSION only, never to a name the author typed.

        `packs/Kurzgesagt` is why: names that predate the convention must stay
        resolvable, and flatten must not start dropping members that section 3
        already projects verbatim.
        """
        root = make_pack(tmp_path / "packs" / "p", {"Legacy_Skill": {"SKILL.md": "s\n"}})
        make_flat_pack(root, flatten=True, declared=["Legacy_Skill"])
        pack = load_pack_standalone(root)
        flat = resolve_inventory(pack)
        assert flat.names == ["Legacy_Skill"]
        assert flat.noncanonical == ()
        assert RuleCode.SKILL_LEAF_NONCANONICAL.value not in rules(lint_pack_contract(pack))

    def test_duplicate_leaf_basenames_are_an_error(self, tmp_path: Path) -> None:
        root = make_pack(
            tmp_path / "packs" / "p",
            {"a": {"dup/SKILL.md": "1\n"}, "b": {"dup/SKILL.md": "2\n"}},
        )
        make_flat_pack(root, flatten=True, declared=["a", "b"])
        pack = load_pack_standalone(root)
        assert resolve_inventory(pack).duplicates() == {"dup": ["a/dup", "b/dup"]}
        issues = lint_pack_contract(pack)
        dupes = [i for i in issues if i.rule is RuleCode.SKILL_LEAF_DUPLICATE]
        assert [i.severity for i in dupes] == [Severity.ERROR]
        assert has_errors(issues)

    def test_symlinked_leaf_is_skipped_not_followed(self, tmp_path: Path) -> None:
        """Expansion skips it and says so; the payload guard independently rejects it.

        A symlink inside a DECLARED entry is payload, and section 4 rule 4 forbids
        symlinks anywhere in the payload. Flattening does not relax that: the walk
        reports the skip (so it is never silently dropped) while `payload_entries`
        still raises, which is what keeps "one unsafe symlink produces zero
        mutation" true for flattened packs too.
        """
        target = make_pack(tmp_path / "elsewhere" / "linked", {"x": {"SKILL.md": "x\n"}})
        root = make_pack(tmp_path / "packs" / "p", {"group": {"one/SKILL.md": "1\n"}})
        (root / "group" / "linked").symlink_to(target)
        make_flat_pack(root, flatten=True, declared=["group"])
        pack = load_pack_standalone(root)
        flat = resolve_inventory(pack)
        assert flat.names == ["one"], "a symlink is never pack content"
        assert flat.skipped_symlinks == ("group/linked",)
        issues = lint_pack_contract(pack)
        assert RuleCode.SKILL_DIR_SYMLINK_SKIPPED.value in rules(issues)
        assert RuleCode.PAYLOAD_INVALID.value in rules(issues)
        with pytest.raises(PayloadError, match="symlinks"):
            payload_paths(root, pack.inventory)

    @pytest.mark.parametrize("hidden", [".git", "_scratch"])
    def test_dot_and_underscore_children_are_skipped(self, tmp_path: Path, hidden: str) -> None:
        root = make_pack(tmp_path / "packs" / "p", {"group": {"one/SKILL.md": "1\n"}})
        (root / "group" / hidden).mkdir()
        (root / "group" / hidden / "SKILL.md").write_text("hidden\n", encoding="utf-8")
        make_flat_pack(root, flatten=True, declared=["group"])
        assert resolve_inventory(load_pack_standalone(root)).names == ["one"]

    def test_empty_flattened_pack_warns_pack_empty(self, tmp_path: Path) -> None:
        root = tmp_path / "packs" / "p"
        (root / "hollow").mkdir(parents=True)
        make_flat_pack(root, flatten=True, declared=["hollow"])
        issues = lint_pack_contract(load_pack_standalone(root))
        assert RuleCode.PACK_EMPTY.value in rules(issues)
        assert not has_errors(issues)

    def test_max_depth_bounds_the_walk(self, tmp_path: Path) -> None:
        """`max_depth=1` reproduces a strict single-level expansion."""
        root = make_pack(
            tmp_path / "packs" / "p",
            {"group": {"flat/SKILL.md": "f\n", "sub/deep/SKILL.md": "d\n"}},
        )
        assert sorted(flatten_inventory(root, ["group"]).names) == ["deep", "flat"]
        assert flatten_inventory(root, ["group"], max_depth=1).names == ["flat"]

    def test_deep_nesting_does_not_blow_the_stack(self, tmp_path: Path) -> None:
        """Nesting depth is just how deep a directory tree goes; it must not crash.

        Built and torn down one `os.mkdir`/`os.rmdir` at a time: `os.makedirs` and
        `shutil.rmtree` are themselves recursive, so a tree this deep has to be
        handled iteratively on both ends - which is exactly the point being made
        about the container walk.
        """
        root = tmp_path / "packs" / "p"
        container = root / "group"
        container.mkdir(parents=True)
        make_flat_pack(root, flatten=True, declared=["group"])

        deepest = str(container)
        for _ in range(sys.getrecursionlimit() + 50):
            deepest += "/n"
            os.mkdir(deepest)
        try:
            with open(f"{deepest}/SKILL.md", "w", encoding="utf-8") as handle:
                handle.write("deep\n")
            assert flatten_inventory(root, ["group"]).names == ["n"]
        finally:
            os.remove(f"{deepest}/SKILL.md")
            while deepest != str(container):
                os.rmdir(deepest)
                deepest = os.path.dirname(deepest)

    def test_unreadable_container_is_an_error_not_an_empty_warning(self, tmp_path: Path) -> None:
        if os.geteuid() == 0:
            pytest.skip("root ignores directory permissions")
        root = make_pack(tmp_path / "packs" / "p", {"group": {"one/SKILL.md": "1\n"}})
        make_flat_pack(root, flatten=True, declared=["group"])
        (root / "group").chmod(0o000)
        try:
            flat = resolve_inventory(load_pack_standalone(root))
            assert flat.unreadable == ("group",)
            assert flat.empty_containers == (), "unreadable is a different finding"
            issues = lint_pack_contract(load_pack_standalone(root))
            assert RuleCode.SKILL_CONTAINER_UNREADABLE.value in rules(issues)
            assert RuleCode.SKILL_CONTAINER_EMPTY.value not in rules(issues)
        finally:
            (root / "group").chmod(0o755)

    def test_sealing_is_computed_from_the_declared_entries(self, tmp_path: Path) -> None:
        """Section 4 is untouched: declaring a container already covers its leaves."""
        root = make_pack(
            tmp_path / "packs" / "p" / "1.0.0",
            {"group": {"DESCRIPTION.md": "d\n", "one/SKILL.md": "1\n"}},
        )
        (root / "pack.toml").write_text(
            '[pack]\nname = "p"\nversion = "1.0.0"\n\n[freeform]\nskills = ["group"]\n'
            "\n[policy]\nflatten = true\nsealed = true\n",
            encoding="utf-8",
        )
        payload = payload_paths(root, load_pack_standalone(root).inventory)
        assert payload == [
            "group/DESCRIPTION.md",
            "group/one/SKILL.md",
            "pack.toml",
        ]
        (root / "SHA256SUMS").write_text(
            render_sha256sums(root, payload),
            encoding="utf-8",
        )
        pack = load_pack_standalone(root)
        assert is_sealed(pack) and resolve_inventory(pack).enabled
        assert lint_pack_contract(pack) == []


class TestPayloadEnumeration:
    def test_directories_are_the_skill_dirs_and_their_descendants(self, tmp_path: Path) -> None:
        root = make_pack(
            tmp_path / "p",
            {"alpha": {"SKILL.md": "a\n", "ref/deep/x.md": "x\n"}, "beta": {"SKILL.md": "b\n"}},
        )
        (root / "alpha" / "hollow").mkdir()
        (root / ".claude").mkdir()  # not payload: never walked, never reported
        payload = payload_entries(root, ["alpha", "beta"])
        assert payload.directories == (
            "alpha",
            "alpha/hollow",
            "alpha/ref",
            "alpha/ref/deep",
            "beta",
        )
        assert unauthenticated_directories(payload.files, payload.directories) == ["alpha/hollow"]

    def test_payload_is_pack_toml_plus_skill_trees(self, tmp_path: Path) -> None:
        root = make_pack(
            tmp_path / "p",
            {"alpha": {"SKILL.md": "a\n", "ref/x.md": "x\n"}, "beta": {"SKILL.md": "b\n"}},
        )
        (root / "pack.toml").write_text("[pack]\n", encoding="utf-8")
        (root / "README.md").write_text("r\n", encoding="utf-8")
        (root / ".claude").mkdir()
        (root / ".claude" / "x.json").write_text("{}\n", encoding="utf-8")
        assert payload_paths(root, ["alpha", "beta"]) == [
            "alpha/SKILL.md",
            "alpha/ref/x.md",
            "beta/SKILL.md",
            "pack.toml",
        ]

    @pytest.mark.parametrize("target", ["/etc/passwd", "nowhere-at-all"])
    def test_symlink_in_payload_raises(self, tmp_path: Path, target: str) -> None:
        root = make_pack(tmp_path / "p", {"alpha": {"SKILL.md": "a\n"}})
        (root / "alpha" / "link").symlink_to(target)
        with pytest.raises(PayloadError, match="may not contain symlinks"):
            payload_paths(root, ["alpha"])

    def test_symlinked_subdirectory_in_payload_raises(self, tmp_path: Path) -> None:
        root = make_pack(tmp_path / "p", {"alpha": {"SKILL.md": "a\n"}})
        other = tmp_path / "other"
        other.mkdir()
        (root / "alpha" / "sub").symlink_to(other)
        with pytest.raises(PayloadError, match="may not contain symlinks"):
            payload_paths(root, ["alpha"])

    @pytest.mark.parametrize("name", ["../escape", "a/b", "..", ".", "", "a\\b"])
    def test_unsafe_skill_names_raise(self, tmp_path: Path, name: str) -> None:
        root = make_pack(tmp_path / "p", {"alpha": {"SKILL.md": "a\n"}})
        with pytest.raises(PayloadError, match="safe path component"):
            payload_paths(root, [name])


class TestSums:
    @pytest.mark.parametrize("path", ["/etc/passwd", "../x", "a/../b", "a//b", "./x", "a\\b"])
    def test_unsafe_paths_rejected(self, path: str) -> None:
        with pytest.raises(PayloadError, match="unsafe path"):
            parse_sha256sums(f"{'0' * 64}  {path}")

    def test_duplicates_rejected(self) -> None:
        with pytest.raises(PayloadError, match="duplicate"):
            parse_sha256sums(f"{'0' * 64}  a.md\n{'1' * 64}  a.md\n")

    def test_malformed_rejected(self) -> None:
        with pytest.raises(PayloadError, match="malformed"):
            parse_sha256sums("deadbeef  a.md")

    def test_round_trip(self) -> None:
        text = f"{'a' * 64}  one.md\n{'b' * 64}  two/three.md\n"
        assert parse_sha256sums(text) == {"one.md": "a" * 64, "two/three.md": "b" * 64}


class TestRender:
    def test_render_then_verify(self, tmp_path: Path) -> None:
        root = make_pack(
            tmp_path / "packs" / "p" / "1.0.0",
            {"alpha": {"SKILL.md": "a\n", "ref/x.md": "x\n"}, "beta": {"SKILL.md": "b\n"}},
        )
        plan = plan_render(root, "p", "1.0.0", upstream="up", rendered_from=".agent/skills")
        assert plan.declared_payload_files == 3
        assert plan.skills == ("alpha", "beta")
        apply_render(plan)
        assert lint_pack_contract(load_pack_standalone(root)) == []

    def test_render_is_deterministic(self, tmp_path: Path) -> None:
        root = make_pack(tmp_path / "packs" / "p" / "1.0.0", {"alpha": {"SKILL.md": "a\n"}})
        first = plan_render(root, "p", "1.0.0")
        second = plan_render(root, "p", "1.0.0")
        assert first.manifest_text == second.manifest_text
        assert first.sums_text == second.sums_text

    def test_sums_covers_the_bytes_actually_written(self, tmp_path: Path) -> None:
        """pack.toml is hashed from the bytes about to be written, never re-walked."""
        root = make_pack(tmp_path / "packs" / "p" / "1.0.0", {"alpha": {"SKILL.md": "a\n"}})
        plan = plan_render(root, "p", "1.0.0")
        apply_render(plan)
        recorded = parse_sha256sums((root / "SHA256SUMS").read_text(encoding="utf-8"))
        on_disk = hashlib.sha256((root / "pack.toml").read_bytes()).hexdigest()
        assert recorded["pack.toml"] == on_disk

    def test_one_bad_symlink_produces_zero_mutation(self, tmp_path: Path) -> None:
        root = make_pack(tmp_path / "packs" / "p" / "1.0.0", {"alpha": {"SKILL.md": "a\n"}})
        (root / "alpha" / "dangling").symlink_to("nowhere-at-all")
        with pytest.raises(PayloadError):
            plan_render(root, "p", "1.0.0")
        assert not (root / "pack.toml").exists()
        assert not (root / "SHA256SUMS").exists()

    def test_symlinked_root_rejected_before_resolution(self, tmp_path: Path) -> None:
        """`Path.resolve()` follows a final-component symlink; validation must precede it."""
        real = make_pack(tmp_path / "real", {"alpha": {"SKILL.md": "a\n"}})
        link = tmp_path / "link"
        link.symlink_to(real)
        with pytest.raises(PayloadError, match="must not be a symlink"):
            plan_render(link, "p", "1.0.0")
        assert not (real / "pack.toml").exists()

    def test_empty_pack_refused(self, tmp_path: Path) -> None:
        root = tmp_path / "packs" / "p"
        root.mkdir(parents=True)
        with pytest.raises(RenderError, match="no skill directories"):
            plan_render(root, "p", "1.0.0")

    def test_immutable_pack_needs_force(self, tmp_path: Path) -> None:
        root = make_pack(tmp_path / "packs" / "p" / "1.0.0", {"alpha": {"SKILL.md": "a\n"}})
        apply_render(plan_render(root, "p", "1.0.0"))
        with pytest.raises(RenderError, match="immutable"):
            apply_render(plan_render(root, "p", "1.0.0"))
        apply_render(plan_render(root, "p", "1.0.0"), force=True)

    def test_refuses_to_write_through_a_symlink(self, tmp_path: Path) -> None:
        root = make_pack(tmp_path / "packs" / "p" / "1.0.0", {"alpha": {"SKILL.md": "a\n"}})
        plan = plan_render(root, "p", "1.0.0")
        (root / "pack.toml").symlink_to(tmp_path / "elsewhere.toml")
        with pytest.raises(RenderError, match="write through a symlink"):
            apply_render(plan)

    def test_root_swapped_between_plan_and_apply(self, tmp_path: Path) -> None:
        root = make_pack(tmp_path / "packs" / "p" / "1.0.0", {"alpha": {"SKILL.md": "a\n"}})
        plan = plan_render(root, "p", "1.0.0")
        root.rename(tmp_path / "moved")
        root.symlink_to(tmp_path / "moved")
        with pytest.raises(PayloadError, match="must not be a symlink"):
            apply_render(plan)

    def test_injection_into_pack_toml_refused(self, tmp_path: Path) -> None:
        root = make_pack(tmp_path / "packs" / "p" / "1.0.0", {"alpha": {"SKILL.md": "a\n"}})
        with pytest.raises(RenderError, match="cannot be embedded"):
            plan_render(root, "p", "1.0.0", description='evil"\nsealed = false')


class TestRenderDoesNotDestroyAnExistingPack:
    """Re-rendering must never quietly shrink a pack and then seal the remains.

    Regression cover for the flattened-pack render defect: `pack render` used
    single-level discovery and rewrote `[policy]` wholesale, so one un-forced run
    against a section 3b pack dropped every container from `[freeform].skills`,
    erased `flatten`/`base_readonly`, and sealed the truncated payload.
    """

    def _flattened(self, tmp_path: Path, *, policy: str) -> Path:
        root = make_pack(
            tmp_path / "packs" / "renderpack" / "1.0.0",
            {
                "flat": {"SKILL.md": "flat\n"},
                "grp": {
                    "DESCRIPTION.md": "container\n",
                    "one/SKILL.md": "one\n",
                    "two/SKILL.md": "two\n",
                },
            },
        )
        (root / "pack.toml").write_text(
            '[pack]\nname = "renderpack"\nversion = "1.0.0"\ndescription = "fixture"\n\n'
            '[freeform]\nskills = ["grp", "flat"]\n\n'
            f"[policy]\n{policy}",
            encoding="utf-8",
        )
        return root

    def test_flattened_pack_keeps_its_containers(self, tmp_path: Path) -> None:
        """The core defect: containers have no SKILL.md, so flat discovery lost them."""
        root = self._flattened(tmp_path, policy="flatten = true\n")
        plan = plan_render(root, "renderpack", "1.0.0", description="fixture")
        assert plan.flatten is True
        assert plan.skills == ("flat", "grp"), "the container must stay a declared entry"
        assert sorted(plan.leaves) == ["flat", "one", "two"]
        # The payload still covers the container's own files and both leaves.
        assert set(plan.payload) == {
            "pack.toml",
            "flat/SKILL.md",
            "grp/DESCRIPTION.md",
            "grp/one/SKILL.md",
            "grp/two/SKILL.md",
        }

    def test_flatten_is_never_inferred_for_a_plain_pack(self, tmp_path: Path) -> None:
        """Off by default: a pack that does not declare flatten renders as before."""
        root = self._flattened(tmp_path, policy="immutable = false\n")
        plan = plan_render(root, "renderpack", "1.0.0")
        assert plan.flatten is False
        assert plan.skills == ("flat",)
        assert "flatten" not in plan.manifest_text

    def test_cli_flag_may_only_turn_flattening_on(self, tmp_path: Path) -> None:
        root = self._flattened(tmp_path, policy="flatten = true\n")
        assert plan_render(root, "renderpack", "1.0.0", flatten=False).flatten is True
        plain = self._flattened(tmp_path / "b", policy="immutable = false\n")
        assert plan_render(plain, "renderpack", "1.0.0", flatten=True).skills == ("flat", "grp")

    def test_unrecognised_policy_keys_survive(self, tmp_path: Path) -> None:
        root = self._flattened(
            tmp_path, policy="flatten = true\noverlay_wins = true\nbase_readonly = true\n"
        )
        plan = plan_render(root, "renderpack", "1.0.0", description="fixture")
        policy = tomllib.loads(plan.manifest_text)["policy"]
        assert policy["flatten"] is True
        assert policy["overlay_wins"] is True
        assert policy["base_readonly"] is True
        assert plan.dropped_keys == ()

    def test_base_readonly_needs_force(self, tmp_path: Path) -> None:
        """`base_readonly` protects a pack even though it does not imply `immutable`."""
        root = self._flattened(tmp_path, policy="flatten = true\nbase_readonly = true\n")
        plan = plan_render(root, "renderpack", "1.0.0", description="fixture")
        before = (root / "pack.toml").read_bytes()
        with pytest.raises(RenderError, match="base_readonly"):
            apply_render(plan)
        assert (root / "pack.toml").read_bytes() == before
        assert not (root / "SHA256SUMS").exists()
        apply_render(plan, force=True)
        assert lint_pack_contract(load_pack_standalone(root)) == []

    def test_a_render_that_would_drop_a_declaration_needs_force(self, tmp_path: Path) -> None:
        """Generic loss guard: not just [policy], and not just the keys we thought of."""
        root = make_pack(tmp_path / "packs" / "p" / "1.0.0", {"alpha": {"SKILL.md": "a\n"}})
        (root / "pack.toml").write_text(
            '[pack]\nname = "p"\nversion = "1.0.0"\n\n'
            '[source]\nupstream_git = "e5afc0d93"\n\n'
            '[promote_candidates]\nskills = ["later"]\n\n'
            '[freeform]\nskills = ["alpha"]\n',
            encoding="utf-8",
        )
        plan = plan_render(root, "p", "1.0.0")
        assert plan.dropped_keys == ("promote_candidates", "source.upstream_git")
        with pytest.raises(RenderError, match="would drop"):
            apply_render(plan)
        assert not (root / "SHA256SUMS").exists()
        apply_render(plan, force=True)

    def test_unparseable_manifest_is_not_treated_as_absent(self, tmp_path: Path) -> None:
        """Fail closed: a corrupt pack.toml must not launder away its own policy."""
        root = make_pack(tmp_path / "packs" / "p" / "1.0.0", {"alpha": {"SKILL.md": "a\n"}})
        (root / "pack.toml").write_text("[pack\nname = broken", encoding="utf-8")
        plan = plan_render(root, "p", "1.0.0")
        assert plan.unparseable_manifest is True
        with pytest.raises(RenderError, match="does not parse"):
            apply_render(plan)
        apply_render(plan, force=True)

    def test_unrenderable_policy_value_raises_instead_of_dropping(self, tmp_path: Path) -> None:
        root = make_pack(tmp_path / "packs" / "p" / "1.0.0", {"alpha": {"SKILL.md": "a\n"}})
        (root / "pack.toml").write_text(
            '[pack]\nname = "p"\nversion = "1.0.0"\n\n'
            '[freeform]\nskills = ["alpha"]\n\n'
            "[policy.nested]\nkey = 1\n",
            encoding="utf-8",
        )
        with pytest.raises(RenderError, match="unsupported TOML value"):
            plan_render(root, "p", "1.0.0")

    def test_a_fresh_pack_is_unaffected(self, tmp_path: Path) -> None:
        """No existing pack.toml: nothing to preserve, nothing to guard, no force."""
        root = make_pack(tmp_path / "packs" / "p" / "1.0.0", {"alpha": {"SKILL.md": "a\n"}})
        plan = plan_render(root, "p", "1.0.0")
        assert plan.dropped_keys == () and plan.flatten is False
        apply_render(plan)
        assert lint_pack_contract(load_pack_standalone(root)) == []


class TestPackEntry:
    def test_string_shorthand(self) -> None:
        assert PackEntry.from_spec("bmad") == PackEntry(name="bmad")
        assert PackEntry.from_spec("bmad@6.10.2") == PackEntry(name="bmad", version="6.10.2")

    def test_object_form(self) -> None:
        entry = PackEntry.from_spec({"name": "bmad", "version": "6.10.2", "sealed": True})
        assert entry.version == "6.10.2" and entry.sealed is True

    def test_include_then_exclude(self) -> None:
        entry = PackEntry(name="p", include=("a", "b", "c"), exclude=("b",))
        assert entry.filter_inventory(["a", "b", "c", "d"]) == ["a", "c"]

    def test_sealed_may_only_tighten(self) -> None:
        assert PackEntry(name="p", sealed=False).is_sealed(True) is True
        assert PackEntry(name="p", sealed=True).is_sealed(False) is True
        assert PackEntry(name="p").is_sealed(False) is False

    def test_flatten_may_only_tighten(self) -> None:
        assert PackEntry(name="p", flatten=False).is_flattened(True) is True
        assert PackEntry(name="p", flatten=True).is_flattened(False) is True
        assert PackEntry(name="p").is_flattened(False) is False

    def test_flatten_is_read_from_the_object_form(self) -> None:
        assert PackEntry.from_spec({"name": "p", "flatten": True}).flatten is True
        assert PackEntry.from_spec("p").flatten is None

    def test_source_and_registry_path_are_exclusive(self) -> None:
        with pytest.raises(ValueError, match="both"):
            PackEntry(name="p", source="file:///x", registry_path="packs/p")

    @pytest.mark.parametrize("bad", ["../escape", "a/b", "", ".."])
    def test_unsafe_names_rejected(self, bad: str) -> None:
        with pytest.raises(ValueError):
            PackEntry(name=bad)

    @pytest.mark.parametrize("bad", ["/abs/path", "../escape", "a/../b"])
    def test_unsafe_registry_path_rejected(self, bad: str) -> None:
        with pytest.raises(ValueError, match="registry_path"):
            PackEntry(name="p", registry_path=bad)


class TestSkillsManifest:
    def test_reads_packs_array(self, tmp_path: Path) -> None:
        path = tmp_path / "skills.json"
        path.write_text(
            '{"$schema": "https://raw.githubusercontent.com/delorenj/skillex/main/'
            'skills.schema.json", "scope": "project", "inherit_global": true, '
            '"registry": "https://github.com/delorenj/skillex.git", '
            '"packs": ["hermes-base", "bmad@6.10.2", {"name": "kur", "optional": true}], '
            '"skills": [{"name": "foo", "source": "file:///x"}]}',
            encoding="utf-8",
        )
        manifest = load_skills_manifest(path)
        assert [(p.name, p.version) for p in manifest.packs] == [
            ("hermes-base", None),
            ("bmad", "6.10.2"),
            ("kur", None),
        ]
        assert manifest.packs[2].optional is True
        assert manifest.registry == "https://github.com/delorenj/skillex.git"

    def test_missing_packs_is_fine(self, tmp_path: Path) -> None:
        path = tmp_path / "skills.json"
        path.write_text('{"skills": []}', encoding="utf-8")
        assert load_skills_manifest(path).packs == ()

    def test_malformed_json_raises(self, tmp_path: Path) -> None:
        path = tmp_path / "skills.json"
        path.write_text("{not json", encoding="utf-8")
        with pytest.raises(ManifestError, match="failed to parse"):
            load_skills_manifest(path)

    def test_bad_pack_entry_raises(self, tmp_path: Path) -> None:
        path = tmp_path / "skills.json"
        path.write_text('{"packs": [{"name": "../escape"}]}', encoding="utf-8")
        with pytest.raises(ManifestError, match="packs\\[0\\]"):
            load_skills_manifest(path)


REPO_ROOT = Path(__file__).resolve().parents[2]
REGISTRY_PACKS = REPO_ROOT / "packs"
CANONICAL_SCHEMA_URL = "https://raw.githubusercontent.com/delorenj/skillex/main/skills.schema.json"


class TestCanonicalSchemaIsPublished:
    """Contract section 7: the $schema URL that migrate/init write must resolve.

    `raw.githubusercontent.com/delorenj/skillex/main/skills.schema.json` serves
    exactly this repo's root `skills.schema.json`. If the file is absent from the
    repo root, every manifest we emit points at a 404 -- which is the bug this
    guards against. The file must therefore be a real, tracked file here.
    """

    @property
    def schema_path(self) -> Path:
        return REPO_ROOT / "skills.schema.json"

    def test_schema_exists_at_repo_root(self) -> None:
        assert self.schema_path.is_file(), (
            f"{self.schema_path} is missing: the canonical $schema URL "
            f"{CANONICAL_SCHEMA_URL} would 404"
        )

    def test_schema_is_a_regular_file_not_a_symlink(self) -> None:
        # raw.githubusercontent serves blob content; a symlink would be served as
        # its target *path string*, not the schema.
        assert not self.schema_path.is_symlink()

    def test_schema_is_parseable_and_self_identifies(self) -> None:
        doc = json.loads(self.schema_path.read_text(encoding="utf-8"))
        assert doc["$id"] == CANONICAL_SCHEMA_URL
        assert doc["$schema"] == "http://json-schema.org/draft-07/schema#"

    def test_schema_declares_packs_and_skills(self) -> None:
        doc = json.loads(self.schema_path.read_text(encoding="utf-8"))
        props = doc["properties"]
        assert props["packs"]["type"] == "array"
        assert props["skills"]["type"] == "array"
        # Section 1: a manifest is valid with any ONE of the three arrays alone.
        # `sets` is load-bearing here, not cosmetic: the live global manifest
        # declares only `sets`, and before it was added that manifest validated
        # solely because of a vestigial `"skills": []`.
        assert doc["anyOf"] == [
            {"required": ["skills"]},
            {"required": ["sets"]},
            {"required": ["packs"]},
        ]

    def test_schema_declares_sets(self) -> None:
        doc = json.loads(self.schema_path.read_text(encoding="utf-8"))
        assert doc["properties"]["sets"]["type"] == "array"
        # A pack replaces the whole root, so at most one may ever be declared.
        assert doc["properties"]["packs"]["maxItems"] == 1


@pytest.mark.integration
class TestRealRegistryPacks:
    """The live registry checkout must keep verifying under the generic rules."""

    @pytest.mark.parametrize("version", ["6.10.1-next.31", "6.10.2"])
    def test_bmad_packs_verify_sealed(self, version: str) -> None:
        root = REGISTRY_PACKS / "bmad" / version
        if not root.is_dir():
            pytest.skip(f"{root} not present")
        pack = load_pack_standalone(root)
        issues = lint_pack_contract(pack, sealed=True)
        assert issues == [], [(i.rule.value, i.message) for i in issues]

    @pytest.mark.parametrize("version", ["6.10.1-next.31", "6.10.2"])
    def test_bmad_packs_do_not_flatten(self, version: str) -> None:
        """Section 3b must be inert for every pack that does not opt in."""
        root = REGISTRY_PACKS / "bmad" / version
        if not root.is_dir():
            pytest.skip(f"{root} not present")
        pack = load_pack_standalone(root)
        flat = resolve_inventory(pack)
        assert flat.enabled is False
        assert flat.names == pack.inventory

    def test_hermes_base_flattens_to_its_leaf_skills(self) -> None:
        """The section 3b reference pack: 18 declared entries, descended to its leaves.

        The expected leaf COUNT is deliberately not written here. It is read from
        the golden projection in tests/fixtures/, which pjangler's regression suite
        reads too. Two suites holding two private copies of this number is exactly
        how 67 (pjangler) and 73 (here) stayed green side by side while describing
        the same pack; tests/unit/test_flatten_cross_engine.py runs every engine
        against that one file and requires them to agree.
        """
        root = REGISTRY_PACKS / "hermes-base" / "0.18.2"
        if not root.is_dir():
            pytest.skip(f"{root} not present")
        golden_path = REPO_ROOT / "tests" / "fixtures" / "flatten-reference-hermes-base-0.18.2.json"
        if not golden_path.is_file():
            pytest.skip(f"{golden_path} not present")
        golden = json.loads(golden_path.read_text(encoding="utf-8"))

        pack = load_pack_standalone(root)
        assert pack.manifest.policy.flatten is True
        assert len(pack.inventory) == golden["declared"]

        flat = resolve_inventory(pack)
        assert flat.enabled is True
        assert len(flat.skills) == len(golden["skills"])
        # Not just the count: an equal number of leaves reached by different paths
        # is still a divergence, and only the pairs catch it.
        assert sorted((s.name, s.relpath) for s in flat.skills) == sorted(
            (s["name"], s["relpath"]) for s in golden["skills"]
        )
        assert flat.duplicates() == {}, "the pack would be ambiguous"

        # The 4 entries that carry their own SKILL.md are taken as-is; the other
        # 14 are containers whose leaves carry the pack's DESCRIPTION.md nesting.
        as_is = sorted(s.name for s in flat.skills if s.depth == 0)
        assert as_is == ["computer-use", "dogfood", "hermes-desktop-plugins", "yuanbao"]

        # Every projected leaf must really hold a regular SKILL.md.
        for skill in flat.skills:
            assert (root / skill.relpath / "SKILL.md").is_file(), skill.relpath

    def test_hermes_base_verifies_unsealed(self) -> None:
        root = REGISTRY_PACKS / "hermes-base" / "0.18.2"
        if not root.is_dir():
            pytest.skip(f"{root} not present")
        pack = load_pack_standalone(root)
        assert not is_sealed(pack)
        issues = lint_pack_contract(pack)
        assert issues == [], [(i.rule.value, i.message) for i in issues]

    def test_bmad_renders_byte_identically(self, tmp_path: Path) -> None:
        """Re-rendering 6.10.2 must reproduce the committed pack.toml and SHA256SUMS."""
        root = REGISTRY_PACKS / "bmad" / "6.10.2"
        if not root.is_dir():
            pytest.skip(f"{root} not present")
        plan = plan_render(
            root,
            "bmad",
            "6.10.2",
            description=("Immutable BMAD agent-skill payload, shared through symlink projections."),
            upstream="bmad-method",
            rendered_from=".agent/skills",
        )
        assert plan.manifest_text == (root / "pack.toml").read_text(encoding="utf-8")
        assert plan.sums_text == (root / "SHA256SUMS").read_text(encoding="utf-8")

    def test_every_pack_loads_without_raising(self) -> None:
        """Heterogeneous layouts must all LOAD; verification verdicts vary."""
        if not REGISTRY_PACKS.is_dir():
            pytest.skip("registry packs/ not present")
        loaded = 0
        for pack_dir in sorted(REGISTRY_PACKS.iterdir()):
            if not pack_dir.is_dir() or pack_dir.is_symlink():
                continue
            if (pack_dir / "pack.toml").is_file():
                roots = [pack_dir]
            else:
                # Version dirs only: symlinked children are pack content, not pack roots.
                children = [
                    c
                    for c in sorted(pack_dir.iterdir())
                    if c.is_dir() and not c.is_symlink() and (c / "pack.toml").is_file()
                ]
                roots = children or [pack_dir]
            for root in roots:
                pack = load_pack_standalone(root)
                assert pack.manifest.name
                lint_pack_contract(pack)  # must not raise
                loaded += 1
        assert loaded > 0

    def test_severity_enum_round_trip(self) -> None:
        assert Severity.ERROR.value == "error"


# ---------------------------------------------------------------------------
# Contract section 2 step 3: the registry-cache directory NAME is a wire format.
#
# `~/.agents/.cache/registries/<sanitized-url>` is addressed by three
# independent surfaces on the same machine. When they disagree they read two
# different checkouts, and the same manifest gets verified against SHA256SUMS by
# one surface and with zero integrity checking by another. That actually
# happened: skillex produced `https-github.com-delorenj-skillex.git` while both
# engines produced `https___github_com_delorenj_skillex_git`, so skillex fell
# through to ~/code/skillex (sealed) while sync-skills.py read a stale unsealed
# clone out of the cache.
# ---------------------------------------------------------------------------

CANONICAL_REGISTRY_URL = "https://github.com/delorenj/skillex.git"
CANONICAL_REGISTRY_CACHE_DIR = "https___github_com_delorenj_skillex_git"

#: Byte-for-byte what `sync-skills.py:registry_cache_dir` and pjangler's
#: `registryCacheDirName` do. Written out literally, not imported, so this test
#: fails if `sanitize_registry_url` is "improved" in isolation.
ENGINE_SANITIZER = re.compile(r"[^a-zA-Z0-9]")

REGISTRY_URLS = [
    CANONICAL_REGISTRY_URL,
    "https://github.com/delorenj/skillex",
    "git@github.com:delorenj/skillex.git",
    "ssh://git@github.com:22/delorenj/skillex.git",
    "https://example.com/a/b/../c.git",
    "file:///home/delorenj/code/skillex",
    "https://user:tok@example.com/x.git?ref=main#frag",
    "HTTPS://GitHub.com/DeLorenJ/Skillex.GIT",
    "../../../etc/passwd",
]


class TestRegistryCacheDirNameIsSharedAcrossSurfaces:
    """One sanitizer, three surfaces. Diverge and packs resolve two ways."""

    def test_canonical_url_maps_to_the_directory_that_exists_on_disk(self) -> None:
        assert sanitize_registry_url(CANONICAL_REGISTRY_URL) == CANONICAL_REGISTRY_CACHE_DIR

    @pytest.mark.parametrize("url", REGISTRY_URLS)
    def test_matches_the_engine_sanitizer(self, url: str) -> None:
        assert sanitize_registry_url(url) == ENGINE_SANITIZER.sub("_", url)

    @pytest.mark.parametrize("url", REGISTRY_URLS)
    def test_result_is_exactly_one_safe_path_component(self, url: str) -> None:
        name = sanitize_registry_url(url)
        assert is_safe_component(name)
        assert Path(name).name == name
        assert not Path(name).is_absolute()

    def test_candidate_ladder_uses_the_shared_name(self, monkeypatch) -> None:
        monkeypatch.delenv("PJ_SKILLS_REGISTRY_ROOT", raising=False)
        candidates = registry_root_candidates(CANONICAL_REGISTRY_URL)
        cache = Path.home() / ".agents" / ".cache" / "registries" / CANONICAL_REGISTRY_CACHE_DIR
        assert cache in candidates
        # Contract order (section 2 step 3): cache, then ~/code/skillex.
        assert candidates[-1] == Path("~/code/skillex").expanduser()
        assert candidates.index(cache) < len(candidates) - 1

    def test_env_override_still_wins_over_the_cache(self, monkeypatch) -> None:
        monkeypatch.setenv("PJ_SKILLS_REGISTRY_ROOT", "/tmp/explicit-registry")
        assert registry_root_candidates(CANONICAL_REGISTRY_URL)[0] == Path("/tmp/explicit-registry")

    def test_blank_registry_url_never_yields_the_cache_parent(self, monkeypatch) -> None:
        """An empty name would hand back `registries/` itself as a "checkout"."""
        monkeypatch.delenv("PJ_SKILLS_REGISTRY_ROOT", raising=False)
        assert sanitize_registry_url("") == ""
        candidates = registry_root_candidates("")
        registries = Path.home() / ".agents" / ".cache" / "registries"
        assert registries not in candidates


@pytest.mark.integration
class TestEngineSourcesStillAgree:
    """Execute/read the OTHER two surfaces where they are checked out.

    Skips rather than fails when a sibling checkout is absent - but when one is
    present it is the real thing, not a restatement of skillex's own regex.
    """

    @staticmethod
    def _first_existing(paths: list[Path]) -> Path | None:
        return next((p for p in paths if p.exists()), None)

    def test_sync_skills_py_computes_the_same_name(self) -> None:
        import subprocess

        script = self._first_existing(
            [
                Path.home()
                / "code/33GOD/pjangler/templates/commonproject/template"
                / ".mise/scripts/sync-skills.py",
                Path.home() / "code/CommonProject/template/.mise/scripts/sync-skills.py",
            ]
        )
        if script is None:
            pytest.skip("no sync-skills.py checkout available")
        code = (
            "import importlib.util,sys;"
            f"spec=importlib.util.spec_from_file_location('s',{str(script)!r});"
            "m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);"
            f"print(m.registry_cache_dir({CANONICAL_REGISTRY_URL!r}).name)"
        )
        out = subprocess.run(
            [sys.executable, "-c", code], capture_output=True, text=True, check=True
        )
        assert out.stdout.strip() == sanitize_registry_url(CANONICAL_REGISTRY_URL)

    def test_pjangler_ts_declares_the_same_normalization(self) -> None:
        source = self._first_existing([Path.home() / "code/33GOD/pjangler/src/parity/rules.ts"])
        if source is None:
            pytest.skip("no pjangler checkout available")
        text = source.read_text(encoding="utf-8")
        assert 'registryUrl.replace(/[^a-zA-Z0-9]/g, "_")' in text, (
            "pjangler's registryCacheDirName no longer matches sanitize_registry_url"
        )
        # Exactly one definition: a second copy is how the surfaces drifted apart
        # the first time (two inline `.replace(/[^a-zA-Z0-9]/g, "_")` call sites).
        assert text.count('.replace(/[^a-zA-Z0-9]/g, "_")') == 1
        # ...and every registries/ path is built from that one name.
        registries_lines = [line for line in text.splitlines() if '".cache", "registries"' in line]
        assert registries_lines
        for line in registries_lines:
            assert "cacheName" in line, line
