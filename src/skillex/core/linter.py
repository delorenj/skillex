"""Pack manifest linter.

Validates a resolved Pack against the 10 rules defined in the PRD. Returns
structured findings rather than raising so CLI callers can print a full
report. Rules that would fail at load time (SLOT_SKILL_MISSING,
NAME_COLLISION) are surfaced as errors by the loader before the linter
sees the pack.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Literal

from skillex.core.models import Pack, Skill
from skillex.core.registry import explain_invalid_slot_type, is_valid_slot_type


class Severity(StrEnum):
    ERROR = "error"
    WARN = "warn"


class RuleCode(StrEnum):
    SLOT_TYPE_MISMATCH = "SLOT_TYPE_MISMATCH"
    SLOT_TYPE_UNKNOWN = "SLOT_TYPE_UNKNOWN"
    REQUIRED_SLOT_EMPTY = "REQUIRED_SLOT_EMPTY"
    DUPLICATE_SKILL = "DUPLICATE_SKILL"
    UNSLOTTED_IN_SLOT = "UNSLOTTED_IN_SLOT"
    PACK_NAME_CONFLICT = "PACK_NAME_CONFLICT"
    MISSING_FRONTMATTER = "MISSING_FRONTMATTER"
    ORPHAN_SLOT = "ORPHAN_SLOT"


@dataclass(frozen=True)
class LintIssue:
    severity: Severity
    rule: RuleCode
    message: str
    pack: str
    location: str


def lint_pack(pack: Pack, skills_index: dict[str, Skill]) -> list[LintIssue]:
    """Return all lint issues for a resolved pack."""
    issues: list[LintIssue] = []
    pack_name = pack.manifest.name

    seen_skill_names: dict[str, str] = {}  # skill name -> location where first seen

    for slot_name, assignment in pack.manifest.slots.items():
        location = f"slots.{slot_name}"

        if not is_valid_slot_type(assignment.slot_type):
            issues.append(
                LintIssue(
                    severity=Severity.ERROR,
                    rule=RuleCode.SLOT_TYPE_UNKNOWN,
                    message=explain_invalid_slot_type(assignment.slot_type),
                    pack=pack_name,
                    location=location,
                )
            )
            continue

        if assignment.skill is None:
            if assignment.required:
                issues.append(
                    LintIssue(
                        severity=Severity.ERROR,
                        rule=RuleCode.REQUIRED_SLOT_EMPTY,
                        message=(
                            f"required slot {slot_name!r} has no skill assigned"
                        ),
                        pack=pack_name,
                        location=location,
                    )
                )
            else:
                issues.append(
                    LintIssue(
                        severity=Severity.WARN,
                        rule=RuleCode.ORPHAN_SLOT,
                        message=(
                            f"optional slot {slot_name!r} has no skill assigned"
                        ),
                        pack=pack_name,
                        location=location,
                    )
                )
            continue

        skill = pack.slot_skills.get(slot_name)
        if skill is None:
            # Loader would have raised; defensive skip for linter.
            continue

        if assignment.skill in seen_skill_names:
            issues.append(
                LintIssue(
                    severity=Severity.ERROR,
                    rule=RuleCode.DUPLICATE_SKILL,
                    message=(
                        f"skill {assignment.skill!r} appears in both "
                        f"{seen_skill_names[assignment.skill]} and {location}"
                    ),
                    pack=pack_name,
                    location=location,
                )
            )
        else:
            seen_skill_names[assignment.skill] = location

        if skill.frontmatter.slot_type is None:
            issues.append(
                LintIssue(
                    severity=Severity.ERROR,
                    rule=RuleCode.UNSLOTTED_IN_SLOT,
                    message=(
                        f"skill {skill.name!r} has no slotType frontmatter and cannot "
                        f"fill typed slot {slot_name!r}"
                    ),
                    pack=pack_name,
                    location=location,
                )
            )
        elif skill.frontmatter.slot_type != assignment.slot_type:
            issues.append(
                LintIssue(
                    severity=Severity.ERROR,
                    rule=RuleCode.SLOT_TYPE_MISMATCH,
                    message=(
                        f"skill {skill.name!r} declares slotType "
                        f"{skill.frontmatter.slot_type!r} but slot {slot_name!r} "
                        f"requires {assignment.slot_type!r}"
                    ),
                    pack=pack_name,
                    location=location,
                )
            )

    for freeform_name in pack.manifest.freeform_skills:
        location = "freeform.skills"
        if freeform_name in seen_skill_names:
            issues.append(
                LintIssue(
                    severity=Severity.ERROR,
                    rule=RuleCode.DUPLICATE_SKILL,
                    message=(
                        f"skill {freeform_name!r} appears in both "
                        f"{seen_skill_names[freeform_name]} and {location}"
                    ),
                    pack=pack_name,
                    location=location,
                )
            )
        else:
            seen_skill_names[freeform_name] = location
            skill = skills_index.get(freeform_name)
            if skill is not None and not _has_any_frontmatter(skill):
                issues.append(
                    LintIssue(
                        severity=Severity.WARN,
                        rule=RuleCode.MISSING_FRONTMATTER,
                        message=(
                            f"freeform skill {freeform_name!r} has no frontmatter"
                        ),
                        pack=pack_name,
                        location=location,
                    )
                )

    return issues


def lint_packs(packs: list[Pack], skills_index: dict[str, Skill]) -> list[LintIssue]:
    """Lint multiple packs together, catching cross-pack conflicts."""
    issues: list[LintIssue] = []
    seen_names: dict[str, str] = {}
    for pack in packs:
        name = pack.manifest.name
        if name in seen_names:
            issues.append(
                LintIssue(
                    severity=Severity.ERROR,
                    rule=RuleCode.PACK_NAME_CONFLICT,
                    message=(
                        f"pack name {name!r} declared by {seen_names[name]} and "
                        f"{pack.pack_path}"
                    ),
                    pack=name,
                    location="[pack].name",
                )
            )
        else:
            seen_names[name] = str(pack.pack_path)
        issues.extend(lint_pack(pack, skills_index))
    return issues


def has_errors(issues: list[LintIssue]) -> bool:
    return any(i.severity is Severity.ERROR for i in issues)


def _has_any_frontmatter(skill: Skill) -> bool:
    fm = skill.frontmatter
    return any(
        [
            fm.name,
            fm.description,
            fm.version,
            fm.slot_type,
            fm.tags,
        ]
    )


# Re-exports for command layer convenience
__all__ = [
    "LintIssue",
    "RuleCode",
    "Severity",
    "has_errors",
    "lint_pack",
    "lint_packs",
]

_ = Literal  # appease "imported but unused" if type-only
