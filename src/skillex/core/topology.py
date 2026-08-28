"""Validate the Skillex single-source topology.

This module checks the repository-level ownership contract.  It is deliberately
separate from pack resolution: a resolver answers "what would activate?", while
this checker answers "where are the writable bytes?".

The accepted topology is:

    all-skills/ -> reference-only compositions -> .agents/skills -> CLI aliases

Only ``all-skills/`` may contain real skill definitions.  Skill sets and packs
may own metadata and pack-level support assets, but their skill members must be
references to canonical entries.
"""

from __future__ import annotations

import os
import re
import tomllib
from dataclasses import asdict, dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any

SKILL_FILENAME = "SKILL.md"
PACK_MANIFEST = "pack.toml"
SAFE_NAME = re.compile(r"^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$")


class TopologySeverity(StrEnum):
    """Severity of a topology finding."""

    ERROR = "error"
    WARN = "warn"


class TopologyCode(StrEnum):
    """Stable machine-readable topology rule identifiers."""

    ROOT_MISSING = "ROOT_MISSING"
    CATALOG_DANGLING_LINK = "CATALOG_DANGLING_LINK"
    CATALOG_LINKED_DEFINITION = "CATALOG_LINKED_DEFINITION"
    CATALOG_NAME_UNSAFE = "CATALOG_NAME_UNSAFE"
    COMPOSITION_EMBEDDED_SKILL = "COMPOSITION_EMBEDDED_SKILL"
    COMPOSITION_DANGLING_LINK = "COMPOSITION_DANGLING_LINK"
    COMPOSITION_LINK_OUTSIDE_CATALOG = "COMPOSITION_LINK_OUTSIDE_CATALOG"
    PACK_MANIFEST_INVALID = "PACK_MANIFEST_INVALID"
    PACK_REFERENCE_INVALID = "PACK_REFERENCE_INVALID"
    PACK_REFERENCE_MISSING = "PACK_REFERENCE_MISSING"
    PACK_REFERENCE_LINKED_DEFINITION = "PACK_REFERENCE_LINKED_DEFINITION"
    ACTIVATION_ROOT_MISSING = "ACTIVATION_ROOT_MISSING"
    ACTIVATION_ENTRY_NOT_REFERENCE = "ACTIVATION_ENTRY_NOT_REFERENCE"
    ACTIVATION_LINK_OUTSIDE_CATALOG = "ACTIVATION_LINK_OUTSIDE_CATALOG"
    CLI_ROOT_NOT_ALIAS = "CLI_ROOT_NOT_ALIAS"
    CLI_ROOT_WRONG_TARGET = "CLI_ROOT_WRONG_TARGET"


@dataclass(frozen=True)
class TopologyFinding:
    """One actionable topology violation."""

    severity: TopologySeverity
    code: TopologyCode
    path: str
    message: str

    def to_dict(self) -> dict[str, str]:
        """Return a JSON-serializable representation."""
        result = asdict(self)
        result["severity"] = self.severity.value
        result["code"] = self.code.value
        return result


@dataclass(frozen=True)
class TopologyReport:
    """Result of checking one Skillex repository."""

    root: Path
    canonical_skills: int
    pack_manifests: int
    findings: tuple[TopologyFinding, ...]

    @property
    def error_count(self) -> int:
        """Number of contract-breaking findings."""
        return sum(f.severity is TopologySeverity.ERROR for f in self.findings)

    @property
    def warning_count(self) -> int:
        """Number of advisory findings."""
        return sum(f.severity is TopologySeverity.WARN for f in self.findings)

    @property
    def ok(self) -> bool:
        """Whether the checked topology satisfies the contract."""
        return self.error_count == 0

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable report."""
        return {
            "root": str(self.root),
            "ok": self.ok,
            "canonical_skills": self.canonical_skills,
            "pack_manifests": self.pack_manifests,
            "errors": self.error_count,
            "warnings": self.warning_count,
            "findings": [finding.to_dict() for finding in self.findings],
        }


@dataclass(frozen=True)
class _CatalogEntry:
    path: Path
    is_real_definition: bool


def _display(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return str(path)


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def _scan_catalog(
    root: Path, catalog_root: Path, findings: list[TopologyFinding]
) -> dict[str, _CatalogEntry]:
    catalog: dict[str, _CatalogEntry] = {}
    if not catalog_root.is_dir():
        findings.append(
            TopologyFinding(
                TopologySeverity.ERROR,
                TopologyCode.ROOT_MISSING,
                _display(catalog_root, root),
                "canonical all-skills/ root is missing",
            )
        )
        return catalog

    for child in sorted(catalog_root.iterdir(), key=lambda path: path.name):
        if child.name == ".git":
            continue
        if child.is_symlink() and not child.exists():
            findings.append(
                TopologyFinding(
                    TopologySeverity.ERROR,
                    TopologyCode.CATALOG_DANGLING_LINK,
                    _display(child, root),
                    f"canonical catalog entry is dangling: {os.readlink(child)}",
                )
            )
            continue
        if not child.is_dir() or not (child / SKILL_FILENAME).is_file():
            continue

        is_real = not child.is_symlink()
        catalog[child.name] = _CatalogEntry(path=child, is_real_definition=is_real)
        if not SAFE_NAME.fullmatch(child.name):
            findings.append(
                TopologyFinding(
                    TopologySeverity.ERROR,
                    TopologyCode.CATALOG_NAME_UNSAFE,
                    _display(child, root),
                    f"canonical skill name {child.name!r} is not a safe flat component",
                )
            )
        if not is_real:
            findings.append(
                TopologyFinding(
                    TopologySeverity.ERROR,
                    TopologyCode.CATALOG_LINKED_DEFINITION,
                    _display(child, root),
                    "all-skills/ must own the definition bytes; import this linked skill "
                    "instead of federating its authoring location",
                )
            )
    return catalog


def _walk_real_directories(root: Path) -> list[Path]:
    """Return real directories without traversing symlinked directories."""
    directories: list[Path] = []
    if not root.is_dir():
        return directories
    for dirpath, dirnames, _filenames in os.walk(root, followlinks=False):
        current = Path(dirpath)
        directories.append(current)
        dirnames[:] = [
            name for name in dirnames if name != ".git" and not (current / name).is_symlink()
        ]
    return directories


def _walk_symlinks(root: Path) -> list[Path]:
    """Return symlinks below root without following any of them."""
    links: list[Path] = []
    if not root.is_dir():
        return links
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        current = Path(dirpath)
        for name in [*dirnames, *filenames]:
            candidate = current / name
            if candidate.is_symlink():
                links.append(candidate)
        dirnames[:] = [
            name for name in dirnames if name != ".git" and not (current / name).is_symlink()
        ]
    return sorted(set(links))


def _scan_composition_root(
    root: Path,
    composition_root: Path,
    catalog_root: Path,
    findings: list[TopologyFinding],
) -> None:
    if not composition_root.is_dir():
        findings.append(
            TopologyFinding(
                TopologySeverity.ERROR,
                TopologyCode.ROOT_MISSING,
                _display(composition_root, root),
                f"composition root {composition_root.name}/ is missing",
            )
        )
        return

    for directory in _walk_real_directories(composition_root):
        if (directory / SKILL_FILENAME).is_file():
            findings.append(
                TopologyFinding(
                    TopologySeverity.ERROR,
                    TopologyCode.COMPOSITION_EMBEDDED_SKILL,
                    _display(directory, root),
                    f"real {SKILL_FILENAME} found in reference-only "
                    f"{composition_root.name}/ composition",
                )
            )

    resolved_catalog = catalog_root.resolve()
    for link in _walk_symlinks(composition_root):
        if not link.exists():
            findings.append(
                TopologyFinding(
                    TopologySeverity.ERROR,
                    TopologyCode.COMPOSITION_DANGLING_LINK,
                    _display(link, root),
                    f"composition reference is dangling: {os.readlink(link)}",
                )
            )
            continue
        resolved = link.resolve()
        if resolved.is_dir() and (resolved / SKILL_FILENAME).is_file():
            if not _is_within(resolved, resolved_catalog):
                findings.append(
                    TopologyFinding(
                        TopologySeverity.ERROR,
                        TopologyCode.COMPOSITION_LINK_OUTSIDE_CATALOG,
                        _display(link, root),
                        f"skill reference resolves outside all-skills/: {resolved}",
                    )
                )


def _manifest_skill_names(raw: dict[str, Any]) -> list[str]:
    names: list[str] = []
    freeform = raw.get("freeform", {})
    if isinstance(freeform, dict):
        listed = freeform.get("skills", [])
        if isinstance(listed, list):
            names.extend(name for name in listed if isinstance(name, str))

    slots = raw.get("slots", {})
    if isinstance(slots, dict):
        for slot in slots.values():
            if isinstance(slot, dict) and isinstance(slot.get("skill"), str):
                names.append(slot["skill"])
    return names


def _scan_pack_manifests(
    root: Path,
    packs_root: Path,
    catalog: dict[str, _CatalogEntry],
    findings: list[TopologyFinding],
) -> int:
    count = 0
    for manifest in sorted(packs_root.rglob(PACK_MANIFEST)):
        if any(part == ".git" for part in manifest.parts):
            continue
        count += 1
        try:
            raw = tomllib.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, tomllib.TOMLDecodeError) as exc:
            findings.append(
                TopologyFinding(
                    TopologySeverity.ERROR,
                    TopologyCode.PACK_MANIFEST_INVALID,
                    _display(manifest, root),
                    f"cannot parse pack manifest: {exc}",
                )
            )
            continue

        for name in _manifest_skill_names(raw):
            if not SAFE_NAME.fullmatch(name):
                findings.append(
                    TopologyFinding(
                        TopologySeverity.ERROR,
                        TopologyCode.PACK_REFERENCE_INVALID,
                        _display(manifest, root),
                        f"pack skill reference {name!r} is not a canonical flat name",
                    )
                )
                continue
            entry = catalog.get(name)
            if entry is None:
                findings.append(
                    TopologyFinding(
                        TopologySeverity.ERROR,
                        TopologyCode.PACK_REFERENCE_MISSING,
                        _display(manifest, root),
                        f"pack references {name!r}, but all-skills/{name}/ is absent",
                    )
                )
            elif not entry.is_real_definition:
                findings.append(
                    TopologyFinding(
                        TopologySeverity.ERROR,
                        TopologyCode.PACK_REFERENCE_LINKED_DEFINITION,
                        _display(manifest, root),
                        f"pack references {name!r}, whose all-skills/ entry is itself a link",
                    )
                )
    return count


PROJECT_CLI_ROOTS = (
    Path(".claude/skills"),
    Path(".codex/skills"),
    Path(".gemini/skills"),
    Path(".copilot/skills"),
    Path(".opencode/skills"),
    Path(".kimi-code/skills"),
)


def _scan_activation(root: Path, catalog_root: Path, findings: list[TopologyFinding]) -> None:
    activation = root / ".agents" / "skills"
    if not activation.exists():
        findings.append(
            TopologyFinding(
                TopologySeverity.WARN,
                TopologyCode.ACTIVATION_ROOT_MISSING,
                _display(activation, root),
                "project has no canonical activation root",
            )
        )
        return

    resolved_catalog = catalog_root.resolve()
    if not activation.is_symlink():
        for child in sorted(activation.iterdir(), key=lambda path: path.name):
            if not child.is_symlink():
                findings.append(
                    TopologyFinding(
                        TopologySeverity.ERROR,
                        TopologyCode.ACTIVATION_ENTRY_NOT_REFERENCE,
                        _display(child, root),
                        "generated activation entries must be symlinks",
                    )
                )
                continue
            if not child.exists():
                findings.append(
                    TopologyFinding(
                        TopologySeverity.ERROR,
                        TopologyCode.COMPOSITION_DANGLING_LINK,
                        _display(child, root),
                        f"activation reference is dangling: {os.readlink(child)}",
                    )
                )
                continue
            resolved = child.resolve()
            if not _is_within(resolved, resolved_catalog):
                findings.append(
                    TopologyFinding(
                        TopologySeverity.ERROR,
                        TopologyCode.ACTIVATION_LINK_OUTSIDE_CATALOG,
                        _display(child, root),
                        f"activation reference resolves outside all-skills/: {resolved}",
                    )
                )

    activation_target = activation.resolve()
    for relative in PROJECT_CLI_ROOTS:
        cli_root = root / relative
        if not cli_root.exists() and not cli_root.is_symlink():
            continue
        if not cli_root.is_symlink():
            findings.append(
                TopologyFinding(
                    TopologySeverity.ERROR,
                    TopologyCode.CLI_ROOT_NOT_ALIAS,
                    _display(cli_root, root),
                    "CLI skill root must be a directory-level alias to .agents/skills",
                )
            )
            continue
        if not cli_root.exists() or cli_root.resolve() != activation_target:
            target = os.readlink(cli_root)
            findings.append(
                TopologyFinding(
                    TopologySeverity.ERROR,
                    TopologyCode.CLI_ROOT_WRONG_TARGET,
                    _display(cli_root, root),
                    f"CLI skill root points to {target!r}, not .agents/skills",
                )
            )


def check_topology(repo_root: Path, *, include_activation: bool = True) -> TopologyReport:
    """Check the strict single-source topology rooted at ``repo_root``."""
    root = repo_root.resolve()
    catalog_root = root / "all-skills"
    packs_root = root / "packs"
    sets_root = root / "sets"
    findings: list[TopologyFinding] = []

    catalog = _scan_catalog(root, catalog_root, findings)
    _scan_composition_root(root, sets_root, catalog_root, findings)
    _scan_composition_root(root, packs_root, catalog_root, findings)
    manifests = _scan_pack_manifests(root, packs_root, catalog, findings)
    if include_activation:
        _scan_activation(root, catalog_root, findings)

    findings.sort(key=lambda finding: (finding.code.value, finding.path, finding.message))
    canonical_count = sum(entry.is_real_definition for entry in catalog.values())
    return TopologyReport(
        root=root,
        canonical_skills=canonical_count,
        pack_manifests=manifests,
        findings=tuple(findings),
    )


__all__ = [
    "TopologyCode",
    "TopologyFinding",
    "TopologyReport",
    "TopologySeverity",
    "check_topology",
]
