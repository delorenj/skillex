"""Tests for skillex.core.linter."""

from __future__ import annotations

from pathlib import Path

from skillex.core.linter import (
    LintIssue,
    RuleCode,
    Severity,
    has_errors,
    lint_pack,
    lint_packs,
)
from skillex.core.models import (
    Pack,
    PackManifest,
    Skill,
    SkillFrontmatter,
    SlotAssignment,
)


def _make_skill(
    name: str,
    *,
    slot_type: str | None = None,
    with_frontmatter: bool = True,
    tmp_path: Path,
) -> Skill:
    skill_dir = tmp_path / name
    skill_dir.mkdir(exist_ok=True)
    skill_md = skill_dir / "SKILL.md"
    skill_md.touch()
    fm = (
        SkillFrontmatter(
            name=name,
            description="x",
            slot_type=slot_type,
        )
        if with_frontmatter
        else SkillFrontmatter()
    )
    return Skill(name=name, path=skill_dir, skill_md_path=skill_md, frontmatter=fm)


def _make_pack(
    manifest: PackManifest,
    slot_skills: dict[str, Skill] | None = None,
    freeform_skills: list[Skill] | None = None,
    *,
    tmp_path: Path,
) -> Pack:
    return Pack(
        manifest=manifest,
        pack_path=tmp_path / "packs" / manifest.name,
        slot_skills=slot_skills or {},
        freeform_skills=freeform_skills or [],
    )


def _find(issues: list[LintIssue], rule: RuleCode) -> LintIssue | None:
    return next((i for i in issues if i.rule is rule), None)


class TestSlotTypeUnknown:
    def test_unknown_slot_type_flagged(self, tmp_path: Path) -> None:
        manifest = PackManifest(
            name="bad-pack",
            slots={
                "review": SlotAssignment(
                    slot_name="review",
                    slot_type="Review",  # not in canonical
                    required=False,
                    skill=None,
                )
            },
        )
        pack = _make_pack(manifest, tmp_path=tmp_path)
        issues = lint_pack(pack, {})
        issue = _find(issues, RuleCode.SLOT_TYPE_UNKNOWN)
        assert issue is not None
        assert issue.severity is Severity.ERROR

    def test_canonical_slot_type_ok(self, tmp_path: Path) -> None:
        manifest = PackManifest(
            name="good-pack",
            slots={
                "memory": SlotAssignment(
                    slot_name="memory",
                    slot_type="Memory",
                    required=False,
                    skill=None,
                )
            },
        )
        pack = _make_pack(manifest, tmp_path=tmp_path)
        issues = lint_pack(pack, {})
        assert _find(issues, RuleCode.SLOT_TYPE_UNKNOWN) is None


class TestRequiredSlotEmpty:
    def test_required_empty_errors(self, tmp_path: Path) -> None:
        manifest = PackManifest(
            name="pack",
            slots={
                "memory": SlotAssignment(
                    slot_name="memory",
                    slot_type="Memory",
                    required=True,
                    skill=None,
                )
            },
        )
        pack = _make_pack(manifest, tmp_path=tmp_path)
        issues = lint_pack(pack, {})
        assert _find(issues, RuleCode.REQUIRED_SLOT_EMPTY) is not None


class TestOrphanSlot:
    def test_optional_empty_warns(self, tmp_path: Path) -> None:
        manifest = PackManifest(
            name="pack",
            slots={
                "memory": SlotAssignment(
                    slot_name="memory",
                    slot_type="Memory",
                    required=False,
                    skill=None,
                )
            },
        )
        pack = _make_pack(manifest, tmp_path=tmp_path)
        issues = lint_pack(pack, {})
        issue = _find(issues, RuleCode.ORPHAN_SLOT)
        assert issue is not None
        assert issue.severity is Severity.WARN


class TestSlotTypeMismatch:
    def test_mismatch_errors(self, tmp_path: Path) -> None:
        skill = _make_skill("hindsight", slot_type="Memory", tmp_path=tmp_path)
        manifest = PackManifest(
            name="pack",
            slots={
                "workflow": SlotAssignment(
                    slot_name="workflow",
                    slot_type="Workflow",
                    required=True,
                    skill="hindsight",
                )
            },
        )
        pack = _make_pack(
            manifest, slot_skills={"workflow": skill}, tmp_path=tmp_path
        )
        issues = lint_pack(pack, {"hindsight": skill})
        issue = _find(issues, RuleCode.SLOT_TYPE_MISMATCH)
        assert issue is not None

    def test_match_ok(self, tmp_path: Path) -> None:
        skill = _make_skill("hindsight", slot_type="Memory", tmp_path=tmp_path)
        manifest = PackManifest(
            name="pack",
            slots={
                "memory": SlotAssignment(
                    slot_name="memory",
                    slot_type="Memory",
                    required=True,
                    skill="hindsight",
                )
            },
        )
        pack = _make_pack(
            manifest, slot_skills={"memory": skill}, tmp_path=tmp_path
        )
        issues = lint_pack(pack, {"hindsight": skill})
        assert _find(issues, RuleCode.SLOT_TYPE_MISMATCH) is None


class TestUnslottedInSlot:
    def test_unslotted_skill_in_typed_slot_errors(self, tmp_path: Path) -> None:
        skill = _make_skill("mermaid", slot_type=None, tmp_path=tmp_path)
        manifest = PackManifest(
            name="pack",
            slots={
                "memory": SlotAssignment(
                    slot_name="memory",
                    slot_type="Memory",
                    required=True,
                    skill="mermaid",
                )
            },
        )
        pack = _make_pack(
            manifest, slot_skills={"memory": skill}, tmp_path=tmp_path
        )
        issues = lint_pack(pack, {"mermaid": skill})
        assert _find(issues, RuleCode.UNSLOTTED_IN_SLOT) is not None


class TestDuplicateSkill:
    def test_same_skill_in_two_slots(self, tmp_path: Path) -> None:
        skill = _make_skill("hindsight", slot_type="Memory", tmp_path=tmp_path)
        skill2 = _make_skill("n8n-bridge", slot_type="Workflow", tmp_path=tmp_path)
        manifest = PackManifest(
            name="pack",
            slots={
                "memory": SlotAssignment(
                    slot_name="memory",
                    slot_type="Memory",
                    required=True,
                    skill="hindsight",
                ),
                "workflow": SlotAssignment(
                    slot_name="workflow",
                    slot_type="Workflow",
                    required=False,
                    skill="hindsight",  # duplicate
                ),
            },
        )
        pack = _make_pack(
            manifest,
            slot_skills={"memory": skill, "workflow": skill2},
            tmp_path=tmp_path,
        )
        issues = lint_pack(pack, {"hindsight": skill, "n8n-bridge": skill2})
        assert _find(issues, RuleCode.DUPLICATE_SKILL) is not None

    def test_same_skill_in_slot_and_freeform(self, tmp_path: Path) -> None:
        skill = _make_skill("hindsight", slot_type="Memory", tmp_path=tmp_path)
        manifest = PackManifest(
            name="pack",
            slots={
                "memory": SlotAssignment(
                    slot_name="memory",
                    slot_type="Memory",
                    required=True,
                    skill="hindsight",
                ),
            },
            freeform_skills=["hindsight"],
        )
        pack = _make_pack(
            manifest,
            slot_skills={"memory": skill},
            freeform_skills=[skill],
            tmp_path=tmp_path,
        )
        issues = lint_pack(pack, {"hindsight": skill})
        assert _find(issues, RuleCode.DUPLICATE_SKILL) is not None


class TestMissingFrontmatter:
    def test_freeform_unslotted_without_frontmatter_warns(
        self, tmp_path: Path
    ) -> None:
        skill = _make_skill("barebones", with_frontmatter=False, tmp_path=tmp_path)
        manifest = PackManifest(
            name="pack",
            freeform_skills=["barebones"],
        )
        pack = _make_pack(
            manifest, freeform_skills=[skill], tmp_path=tmp_path
        )
        issues = lint_pack(pack, {"barebones": skill})
        issue = _find(issues, RuleCode.MISSING_FRONTMATTER)
        assert issue is not None
        assert issue.severity is Severity.WARN


class TestPackNameConflict:
    def test_two_packs_same_name(self, tmp_path: Path) -> None:
        pack_a = _make_pack(PackManifest(name="shared"), tmp_path=tmp_path / "a")
        pack_b = _make_pack(PackManifest(name="shared"), tmp_path=tmp_path / "b")
        issues = lint_packs([pack_a, pack_b], {})
        assert _find(issues, RuleCode.PACK_NAME_CONFLICT) is not None


class TestHasErrors:
    def test_errors_detected(self, tmp_path: Path) -> None:
        manifest = PackManifest(
            name="pack",
            slots={
                "memory": SlotAssignment(
                    slot_name="memory",
                    slot_type="Memory",
                    required=True,
                    skill=None,
                )
            },
        )
        pack = _make_pack(manifest, tmp_path=tmp_path)
        issues = lint_pack(pack, {})
        assert has_errors(issues) is True

    def test_only_warnings_not_errors(self, tmp_path: Path) -> None:
        manifest = PackManifest(
            name="pack",
            slots={
                "memory": SlotAssignment(
                    slot_name="memory",
                    slot_type="Memory",
                    required=False,
                    skill=None,
                )
            },
        )
        pack = _make_pack(manifest, tmp_path=tmp_path)
        issues = lint_pack(pack, {})
        assert has_errors(issues) is False
        assert any(i.severity is Severity.WARN for i in issues)


class TestCleanPack:
    def test_clean_pack_has_no_issues(self, tmp_path: Path) -> None:
        skill = _make_skill("hindsight", slot_type="Memory", tmp_path=tmp_path)
        manifest = PackManifest(
            name="pack",
            slots={
                "memory": SlotAssignment(
                    slot_name="memory",
                    slot_type="Memory",
                    required=True,
                    skill="hindsight",
                )
            },
        )
        pack = _make_pack(
            manifest, slot_skills={"memory": skill}, tmp_path=tmp_path
        )
        issues = lint_pack(pack, {"hindsight": skill})
        assert issues == []
