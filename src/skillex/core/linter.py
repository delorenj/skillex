"""Pack manifest linter.

Validates a resolved Pack against the 10 rules defined in the PRD. Returns
structured findings rather than raising so CLI callers can print a full
report. Rules that would fail at load time (SLOT_SKILL_MISSING,
NAME_COLLISION) are surfaced as errors by the loader before the linter
sees the pack.
"""

from __future__ import annotations

import stat
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import TYPE_CHECKING, Literal

from skillex.core.models import NAME_PATTERN, Pack, Skill, is_safe_component
from skillex.core.payload import (
    MANIFEST_FILENAME,
    SKILL_FILENAME,
    SUMS_FILENAME,
    PackPayload,
    PayloadError,
    load_sha256sums,
    payload_entries,
    sha256_file,
    symlinked_skill_candidates,
    unauthenticated_directories,
)
from skillex.core.registry import explain_invalid_slot_type, is_valid_slot_type

if TYPE_CHECKING:  # pragma: no cover - annotation only; see verify_pack for the rationale
    from skillex.core.loader import FlattenedInventory


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

    # --- packs contract (PACKS-CONTRACT.md) ---
    PACK_ROOT_INVALID = "PACK_ROOT_INVALID"
    PACK_NAME_MISMATCH = "PACK_NAME_MISMATCH"
    PACK_VERSION_MISMATCH = "PACK_VERSION_MISMATCH"
    PACK_NAME_NONCANONICAL = "PACK_NAME_NONCANONICAL"
    PACK_EMPTY = "PACK_EMPTY"
    SKILL_NAME_UNSAFE = "SKILL_NAME_UNSAFE"
    SKILL_DIR_MISSING = "SKILL_DIR_MISSING"
    SKILL_MD_MISSING = "SKILL_MD_MISSING"
    SKILL_DUPLICATE_DECLARATION = "SKILL_DUPLICATE_DECLARATION"
    SKILL_DIR_SYMLINK_SKIPPED = "SKILL_DIR_SYMLINK_SKIPPED"
    # --- flattened packs (contract section 3b) ---
    SKILL_CONTAINER_EMPTY = "SKILL_CONTAINER_EMPTY"
    SKILL_CONTAINER_UNREADABLE = "SKILL_CONTAINER_UNREADABLE"
    SKILL_LEAF_DUPLICATE = "SKILL_LEAF_DUPLICATE"
    SKILL_LEAF_NONCANONICAL = "SKILL_LEAF_NONCANONICAL"
    PAYLOAD_INVALID = "PAYLOAD_INVALID"
    PAYLOAD_COUNT_MISMATCH = "PAYLOAD_COUNT_MISMATCH"
    PAYLOAD_UNAUTHENTICATED_DIR = "PAYLOAD_UNAUTHENTICATED_DIR"
    SUMS_MISSING = "SUMS_MISSING"
    SUMS_MALFORMED = "SUMS_MALFORMED"
    SUMS_UNCOVERED_FILE = "SUMS_UNCOVERED_FILE"
    SUMS_ORPHAN_ENTRY = "SUMS_ORPHAN_ENTRY"
    SUMS_DIGEST_MISMATCH = "SUMS_DIGEST_MISMATCH"


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
                        message=(f"required slot {slot_name!r} has no skill assigned"),
                        pack=pack_name,
                        location=location,
                    )
                )
            else:
                issues.append(
                    LintIssue(
                        severity=Severity.WARN,
                        rule=RuleCode.ORPHAN_SLOT,
                        message=(f"optional slot {slot_name!r} has no skill assigned"),
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
                        message=(f"freeform skill {freeform_name!r} has no frontmatter"),
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
                        f"pack name {name!r} declared by {seen_names[name]} and {pack.pack_path}"
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


# ---------------------------------------------------------------------------
# Packs contract rules (PACKS-CONTRACT.md sections 3 and 4)
# ---------------------------------------------------------------------------


def _issue(severity: Severity, rule: RuleCode, message: str, pack: str, location: str) -> LintIssue:
    return LintIssue(severity=severity, rule=rule, message=message, pack=pack, location=location)


def _lint_identity(pack: Pack) -> list[LintIssue]:
    """pack.toml [pack].name/version must agree with the directory the pack lives in."""
    issues: list[LintIssue] = []
    name = pack.manifest.name
    manifest_label = MANIFEST_FILENAME if pack.has_manifest else "(synthesized)"

    if not pack.manifest.is_canonical_name:
        issues.append(
            _issue(
                Severity.WARN,
                RuleCode.PACK_NAME_NONCANONICAL,
                f"pack name {name!r} does not match the canonical contract shape "
                f"{NAME_PATTERN.pattern}; it resolves as a safe path component so the "
                "pack still loads, but new packs should use lowercase-and-dashes",
                name,
                f"{manifest_label}:[pack].name",
            )
        )

    if pack.has_manifest and pack.dir_name is not None and name != pack.dir_name:
        issues.append(
            _issue(
                Severity.ERROR,
                RuleCode.PACK_NAME_MISMATCH,
                f"[pack].name is {name!r} but the pack lives in directory {pack.dir_name!r}",
                name,
                f"{MANIFEST_FILENAME}:[pack].name",
            )
        )

    if pack.has_manifest and pack.version_dir is not None:
        if pack.manifest.version != pack.version_dir:
            issues.append(
                _issue(
                    Severity.ERROR,
                    RuleCode.PACK_VERSION_MISMATCH,
                    f"[pack].version is {pack.manifest.version!r} but the pack lives in "
                    f"version directory {pack.version_dir!r}",
                    name,
                    f"{MANIFEST_FILENAME}:[pack].version",
                )
            )
    return issues


def _lint_inventory(pack: Pack, flat: FlattenedInventory) -> list[LintIssue]:
    """Every declared skill must be a real dir holding a regular SKILL.md (section 3).

    When `flat.enabled` the pack is validated against the FLATTENED inventory
    (section 3b): a declared entry with no `SKILL.md` is a CONTAINER, which is
    correct for such a pack and must NOT raise `SKILL_MD_MISSING`. Every other
    declared-entry guard is unchanged, because sealing still enumerates the payload
    from the DECLARED entries.
    """
    issues: list[LintIssue] = []
    name = pack.manifest.name
    root = pack.pack_path
    location = "[freeform].skills" if pack.has_manifest else "(globbed)"

    skipped = symlinked_skill_candidates(root)
    if skipped:
        issues.append(
            _issue(
                Severity.WARN,
                RuleCode.SKILL_DIR_SYMLINK_SKIPPED,
                f"{len(skipped)} symlinked entr{'y' if len(skipped) == 1 else 'ies'} look like "
                f"skills but are excluded from the inventory and the payload "
                f"(symlinks are never pack content): {', '.join(skipped)}",
                name,
                str(root),
            )
        )

    inventory = pack.inventory
    projected = flat.names if flat.enabled else inventory
    if not projected:
        issues.append(
            _issue(
                Severity.WARN,
                RuleCode.PACK_EMPTY,
                (
                    "pack declares no skills"
                    if not flat.enabled
                    else f"pack declares {len(inventory)} entr"
                    f"{'y' if len(inventory) == 1 else 'ies'} but none expands to a skill"
                )
                + (" (every candidate directory is a symlink)" if skipped else ""),
                name,
                location,
            )
        )

    seen: set[str] = set()
    for skill in inventory:
        if skill in seen:
            issues.append(
                _issue(
                    Severity.ERROR,
                    RuleCode.SKILL_DUPLICATE_DECLARATION,
                    f"skill {skill!r} is declared more than once",
                    name,
                    location,
                )
            )
            continue
        seen.add(skill)

        if not is_safe_component(skill):
            issues.append(
                _issue(
                    Severity.ERROR,
                    RuleCode.SKILL_NAME_UNSAFE,
                    f"skill name {skill!r} is not a single safe path component",
                    name,
                    location,
                )
            )
            continue

        skill_dir = root / skill
        try:
            mode = skill_dir.lstat().st_mode
        except OSError:
            issues.append(
                _issue(
                    Severity.ERROR,
                    RuleCode.SKILL_DIR_MISSING,
                    f"declared skill {skill!r} has no directory at {skill_dir}",
                    name,
                    f"{location}[{skill}]",
                )
            )
            continue
        if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
            issues.append(
                _issue(
                    Severity.ERROR,
                    RuleCode.SKILL_DIR_MISSING,
                    f"declared skill {skill!r} must be a real directory, not a symlink "
                    f"or file: {skill_dir}",
                    name,
                    f"{location}[{skill}]",
                )
            )
            continue

        if flat.enabled:
            # Section 3b: a declared entry with no SKILL.md is a CONTAINER, not a
            # broken skill. Its expansion is validated below instead.
            continue

        skill_md = skill_dir / SKILL_FILENAME
        try:
            md_mode = skill_md.lstat().st_mode
        except OSError:
            issues.append(
                _issue(
                    Severity.ERROR,
                    RuleCode.SKILL_MD_MISSING,
                    f"declared skill {skill!r} has no {SKILL_FILENAME}",
                    name,
                    f"{location}[{skill}]",
                )
            )
            continue
        if not stat.S_ISREG(md_mode):
            issues.append(
                _issue(
                    Severity.ERROR,
                    RuleCode.SKILL_MD_MISSING,
                    f"declared skill {skill!r} has a {SKILL_FILENAME} that is not a "
                    "regular file (symlinks are rejected)",
                    name,
                    f"{location}[{skill}]",
                )
            )

    if flat.enabled:
        issues.extend(_lint_flattened(pack, flat, location))
    return issues


def _lint_flattened(pack: Pack, flat: FlattenedInventory, location: str) -> list[LintIssue]:
    """Rules that only exist for a flattened pack (contract section 3b)."""
    issues: list[LintIssue] = []
    name = pack.manifest.name

    for rel in flat.unreadable:
        issues.append(
            _issue(
                Severity.ERROR,
                RuleCode.SKILL_CONTAINER_UNREADABLE,
                f"container {rel!r} could not be listed, so its skills cannot be projected",
                name,
                f"{rel}/",
            )
        )

    for rel in flat.skipped_symlinks:
        issues.append(
            _issue(
                Severity.WARN,
                RuleCode.SKILL_DIR_SYMLINK_SKIPPED,
                f"symlinked entry {rel!r} inside a container is skipped, never followed "
                "(symlinks are never pack content)",
                name,
                rel,
            )
        )

    # Contract 3b: flatten is the ONLY place a projected skill name is lifted straight
    # off the filesystem. `is_safe_component` alone admits `-rf`, `--help`, `*` and
    # names carrying newlines or tabs, which every consumer would turn into an argv-
    # and glob-hostile symlink name inside six CLI skill directories. WARN, not ERROR:
    # the leaf is already dropped from the projection, and one odd upstream directory
    # must not brick a whole pack.
    for rel in flat.noncanonical:
        issues.append(
            _issue(
                Severity.WARN,
                RuleCode.SKILL_LEAF_NONCANONICAL,
                f"leaf {rel.rsplit('/', 1)[-1]!r} at {rel!r} is not a canonical skill name "
                f"({NAME_PATTERN.pattern}); it is skipped, never projected",
                name,
                rel,
            )
        )

    # "A container that contributes nothing must be reported, never silently dropped."
    for rel in flat.empty_containers:
        issues.append(
            _issue(
                Severity.WARN,
                RuleCode.SKILL_CONTAINER_EMPTY,
                f"container {rel!r} holds no {SKILL_FILENAME} and no child directory that "
                "does, so it projects no skill",
                name,
                f"{location}[{rel.split('/', 1)[0]}]" if "/" not in rel else f"{rel}/",
            )
        )

    # Duplicate leaf basenames make the pack ambiguous: the projected name would
    # resolve to two different directories inside ONE pack, which no precedence
    # rule can arbitrate (section 5 only orders ACROSS packs).
    for dup_name, paths in sorted(flat.duplicates().items()):
        issues.append(
            _issue(
                Severity.ERROR,
                RuleCode.SKILL_LEAF_DUPLICATE,
                f"flattened skill name {dup_name!r} is claimed by {len(paths)} directories "
                f"in this pack: {', '.join(paths)}",
                name,
                location,
            )
        )

    return issues


def _lint_payload(pack: Pack, payload: list[str] | None) -> list[LintIssue]:
    """[source].payload_files must equal the real count (excluding pack.toml)."""
    declared = pack.manifest.source.payload_files
    if declared is None or payload is None:
        return []
    actual = len([p for p in payload if p != MANIFEST_FILENAME])
    if actual == declared:
        return []
    return [
        _issue(
            Severity.ERROR,
            RuleCode.PAYLOAD_COUNT_MISMATCH,
            f"[source].payload_files declares {declared} but the pack holds {actual} "
            f"payload files (excluding {MANIFEST_FILENAME})",
            pack.manifest.name,
            f"{MANIFEST_FILENAME}:[source].payload_files",
        )
    ]


def _lint_seal(pack: Pack, payload: PackPayload) -> list[LintIssue]:
    """Contract section 4: SHA256SUMS must cover the payload exactly and match on disk."""
    issues: list[LintIssue] = []
    name = pack.manifest.name
    root = pack.pack_path

    try:
        recorded = load_sha256sums(root)
    except PayloadError as e:
        rule = (
            RuleCode.SUMS_MISSING
            if "not found" in str(e) or "regular file" in str(e)
            else RuleCode.SUMS_MALFORMED
        )
        return [_issue(Severity.ERROR, rule, str(e), name, SUMS_FILENAME)]

    payload_set = set(payload.files)

    # Rule 2: every payload file appears in SHA256SUMS with a matching sha256.
    for rel in payload.files:
        if rel not in recorded:
            issues.append(
                _issue(
                    Severity.ERROR,
                    RuleCode.SUMS_UNCOVERED_FILE,
                    f"payload file {rel!r} is not listed in {SUMS_FILENAME}",
                    name,
                    f"{SUMS_FILENAME}:{rel}",
                )
            )

    # Rule 3: every SHA256SUMS entry exists on disk with a matching sha256.
    # Extra non-payload entries (e.g. README.md) are legal but still verified.
    for rel, expected in recorded.items():
        target = root / rel
        try:
            actual = sha256_file(target)
        except (OSError, PayloadError) as e:
            issues.append(
                _issue(
                    Severity.ERROR,
                    RuleCode.SUMS_ORPHAN_ENTRY,
                    f"{SUMS_FILENAME} lists {rel!r} but it cannot be verified: {e}",
                    name,
                    f"{SUMS_FILENAME}:{rel}",
                )
            )
            continue
        if actual != expected:
            issues.append(
                _issue(
                    Severity.ERROR,
                    RuleCode.SUMS_DIGEST_MISMATCH,
                    f"{rel!r} hashes to {actual} but {SUMS_FILENAME} records {expected}"
                    + (" (payload)" if rel in payload_set else " (extra file)"),
                    name,
                    f"{SUMS_FILENAME}:{rel}",
                )
            )

    # Rules 2 + 4: a checksum can only authenticate a file, so a payload directory
    # holding no payload file at any depth is authenticated by nothing at all and
    # could have been planted after sealing without disturbing a single digest.
    for rel in unauthenticated_directories(payload.files, payload.directories):
        issues.append(
            _issue(
                Severity.ERROR,
                RuleCode.PAYLOAD_UNAUTHENTICATED_DIR,
                f"directory {rel!r} contains no payload file, so no {SUMS_FILENAME} entry "
                "authenticates it; a sealed pack may not contain unauthenticated "
                "(empty) directories",
                name,
                f"{rel}/",
            )
        )
    return issues


def lint_pack_contract(
    pack: Pack, *, sealed: bool | None = None, flatten: bool | None = None
) -> list[LintIssue]:
    """Validate a self-contained pack against PACKS-CONTRACT.md.

    `pack` must come from :func:`skillex.core.loader.load_pack_standalone`.

    `sealed` and `flatten` are the manifest-entry overrides. Both may only TIGHTEN:
    passing False against a pack.toml that declares `[policy] sealed = true` does
    NOT unseal it, and likewise for `[policy] flatten = true`.

    Unsealed packs get structural validation only. Sealed packs additionally get
    the full section 4 checksum verification - which is computed from the DECLARED
    inventory and is therefore identical whether or not the pack flattens.
    """
    # Imported lazily for the same reason as in verify_pack: the linter is the
    # semantic layer and must stay importable without dragging in the loader.
    from skillex.core.loader import resolve_inventory

    issues: list[LintIssue] = []
    name = pack.manifest.name

    flat = resolve_inventory(pack, flatten=flatten)

    issues.extend(_lint_identity(pack))
    issues.extend(_lint_inventory(pack, flat))

    payload: PackPayload | None
    try:
        payload = payload_entries(pack.pack_path, pack.inventory)
    except PayloadError as e:
        issues.append(
            _issue(Severity.ERROR, RuleCode.PAYLOAD_INVALID, str(e), name, str(pack.pack_path))
        )
        payload = None

    issues.extend(_lint_payload(pack, None if payload is None else list(payload.files)))

    if is_sealed(pack, sealed):
        if payload is None:
            issues.append(
                _issue(
                    Severity.ERROR,
                    RuleCode.SUMS_MISSING,
                    "pack is sealed but its payload could not be enumerated, so "
                    "checksums cannot be verified",
                    name,
                    SUMS_FILENAME,
                )
            )
        else:
            issues.extend(_lint_seal(pack, payload))

    return issues


def is_sealed(pack: Pack, override: bool | None = None) -> bool:
    """Effective sealed state: pack.toml `[policy] sealed` OR the manifest override.

    `[policy] immutable = true` alone does NOT imply sealed.
    """
    return pack.manifest.policy.sealed or bool(override)


def is_flattened(pack: Pack, override: bool | None = None) -> bool:
    """Effective flatten state: pack.toml `[policy] flatten` OR the manifest override.

    Thin re-export of :func:`skillex.core.loader.pack_flatten_enabled` so the command
    layer can ask the linter, exactly as it does for :func:`is_sealed`.
    """
    from skillex.core.loader import pack_flatten_enabled

    return pack_flatten_enabled(pack, override)


def verify_pack(
    pack_root: Path, *, sealed: bool | None = None, flatten: bool | None = None
) -> list[LintIssue]:
    """Load a pack from disk and lint it against the packs contract.

    Convenience wrapper so callers do not need to import the loader. Loader
    failures (unreadable / symlinked pack root) surface as a PACK_ROOT_INVALID
    issue rather than an exception.
    """
    # Imported lazily: the linter is the semantic layer and must stay importable
    # without dragging in the loader, so the dependency only ever points one way.
    from skillex.core.loader import PackError, load_pack_standalone

    try:
        pack = load_pack_standalone(pack_root)
    except PackError as e:
        return [
            _issue(
                Severity.ERROR,
                RuleCode.PACK_ROOT_INVALID,
                str(e),
                pack_root.name,
                str(pack_root),
            )
        ]
    return lint_pack_contract(pack, sealed=sealed, flatten=flatten)


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
    "is_flattened",
    "is_sealed",
    "lint_pack",
    "lint_pack_contract",
    "lint_packs",
    "verify_pack",
]

_ = Literal  # appease "imported but unused" if type-only
