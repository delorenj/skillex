"""Pydantic models used across skillex.

Keep validation that needs cross-module knowledge (slot registry membership,
filesystem existence) in the registry and loader modules. This file defines
shape and trivial constraints only.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$")
"""Canonical pack and skill names: lowercase alphanumerics and dashes, no leading/trailing dash.

This is the name shape the packs contract (section 1) mandates for *new* names and
the shape `skills[]` entries must use.
"""

PACK_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
"""Accepted pack directory/manifest names.

Deliberately wider than :data:`NAME_PATTERN`: the live registry ships
``packs/Kurzgesagt``, and rejecting it outright would silently drop a real pack.
Names that parse here but do not match :data:`NAME_PATTERN` are still flagged by
the linter (``PACK_NAME_NONCANONICAL``, warn) so the drift stays visible.

Still constrained to exactly ONE safe path component - see :func:`is_safe_component`.
"""

VERSION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")
"""Accepted pack version / version-directory names, e.g. ``6.10.2``, ``6.10.1-next.31``."""

PROJECTION_NAME_PATTERN = re.compile(r"^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$")
"""The name shape a skill may be PROJECTED under into an activation root.

Deliberately the published schema's ``skillName`` shape (and ``topology.SAFE_NAME``),
which permits ``.`` and ``_``, and NOT :data:`NAME_PATTERN`, which forbids both.

Three "safe name" regexes exist in this codebase and they disagree. The rule that
resolves the disagreement: **a name that validates in a manifest must project.**
:data:`NAME_PATTERN` is the stricter shape the packs contract mandates for *new*
canonical names, and it keeps gating :class:`Skill.name`; using it as a projection
filter instead silently drops real, already-published skills on the floor."""

_UNSAFE_COMPONENTS = frozenset({"", ".", ".."})


def is_safe_component(value: str) -> bool:
    """True when `value` is exactly one path component that cannot escape its parent.

    Rejects empty strings, ``.``/``..``, anything containing a path separator
    (forward or backslash), NUL bytes, and leading/trailing whitespace. This is the
    single gate every pack name, version directory and skill name passes through
    before it is ever joined onto a filesystem path.
    """
    if value in _UNSAFE_COMPONENTS:
        return False
    if value != value.strip():
        return False
    if "/" in value or "\\" in value or "\x00" in value:
        return False
    return Path(value).name == value


def is_safe_relpath(value: str) -> bool:
    """True when `value` is a relative, `/`-separated path with only safe components.

    Used for `SHA256SUMS` entries and `registry_path` overrides. Rejects absolute
    paths, backslashes, and any ``.``/``..``/empty segment (contract section 4 rule 5).
    """
    if not value or "\\" in value or "\x00" in value:
        return False
    if value.startswith("/"):
        return False
    return all(is_safe_component(part) for part in value.split("/"))


class SkillFrontmatter(BaseModel):
    """Parsed YAML frontmatter from a SKILL.md file.

    All fields are optional because many legacy skills lack frontmatter. Skills
    without a slotType can still be used in freeform pack entries but are not
    eligible for typed slot placement.
    """

    model_config = ConfigDict(extra="allow", frozen=True, populate_by_name=True)

    name: str | None = None
    description: str | None = None
    version: str | None = None
    slot_type: str | None = Field(default=None, alias="slotType")
    tags: list[str] = Field(default_factory=list)


class Skill(BaseModel):
    """A skill residing in all-skills/<name>/.

    path is the absolute path to the skill directory. skill_md_path is the
    absolute path to the SKILL.md file inside that directory.
    """

    model_config = ConfigDict(frozen=True)

    name: str
    path: Path
    skill_md_path: Path
    frontmatter: SkillFrontmatter

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        if not NAME_PATTERN.match(v):
            raise ValueError(f"invalid skill name {v!r}; must match {NAME_PATTERN.pattern}")
        return v


class SlotAssignment(BaseModel):
    """Binding of one slot in a pack manifest to one skill."""

    model_config = ConfigDict(frozen=True)

    slot_name: str
    slot_type: str
    required: bool
    skill: str | None


class PackSource(BaseModel):
    """`[source]` provenance block of a pack.toml.

    `extra="allow"` on purpose: real packs carry bespoke provenance keys
    (`upstream_git`, `harvested_from`, `excluded`, `*_manifest_sha256`) that must
    survive a load/render round-trip rather than being silently dropped.
    """

    model_config = ConfigDict(extra="allow", frozen=True)

    upstream: str | None = None
    upstream_version: str | None = None
    rendered_from: str | None = None
    payload_files: int | None = None

    @field_validator("payload_files")
    @classmethod
    def _validate_payload_files(cls, v: int | None) -> int | None:
        if v is not None and v < 0:
            raise ValueError(f"[source].payload_files must be >= 0, got {v}")
        return v


class PackPolicy(BaseModel):
    """`[policy]` block of a pack.toml.

    `immutable` forbids in-place edits/re-render. `sealed` demands checksum
    verification (contract section 4). Note that `immutable` alone does NOT imply
    `sealed`. `flatten` declares a two-level (container/leaf) upstream layout that
    is expanded at PROJECTION time (contract section 3b) - the pack on disk keeps
    the nesting verbatim. `extra="allow"` because packs in the wild carry extra
    policy keys (`overlay_wins`, `base_readonly`).
    """

    model_config = ConfigDict(extra="allow", frozen=True)

    immutable: bool = False
    sealed: bool = False
    flatten: bool = False
    project_projection: str | None = None


class PackManifest(BaseModel):
    """Raw parsed pack.toml structure, pre-resolution."""

    model_config = ConfigDict(frozen=True)

    name: str
    version: str = "0.0.0"
    description: str = ""
    slots: dict[str, SlotAssignment] = Field(default_factory=dict)
    freeform_skills: list[str] = Field(default_factory=list)
    source: PackSource = Field(default_factory=PackSource)
    policy: PackPolicy = Field(default_factory=PackPolicy)

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        if not PACK_NAME_PATTERN.match(v) or not is_safe_component(v):
            raise ValueError(f"invalid pack name {v!r}; must match {PACK_NAME_PATTERN.pattern}")
        return v

    @field_validator("version")
    @classmethod
    def _validate_version(cls, v: str) -> str:
        if not VERSION_PATTERN.match(v) or not is_safe_component(v):
            raise ValueError(f"invalid pack version {v!r}; must match {VERSION_PATTERN.pattern}")
        return v

    @property
    def is_canonical_name(self) -> bool:
        """True when the pack name also satisfies the strict contract name shape."""
        return bool(NAME_PATTERN.match(self.name))


class Pack(BaseModel):
    """A pack with its manifest and (optionally) resolved skill references.

    `slot_skills`/`freeform_skills` are populated only when the pack was loaded
    against a skills index (:func:`skillex.core.loader.load_pack`). Self-contained
    packs - the ones the packs contract describes, which ship their skill
    directories inside the pack root - are loaded by
    :func:`skillex.core.loader.load_pack_standalone` and carry their inventory in
    `manifest.freeform_skills` with no index resolution.
    """

    model_config = ConfigDict(frozen=True)

    manifest: PackManifest
    pack_path: Path
    slot_skills: dict[str, Skill] = Field(default_factory=dict)
    freeform_skills: list[Skill] = Field(default_factory=list)
    manifest_path: Path | None = None
    """Absolute path to pack.toml, or None for a pack.toml-less pack."""
    dir_name: str | None = None
    """Directory name the pack lives under (`packs/<dir_name>[/<version_dir>]`)."""
    version_dir: str | None = None
    """Version directory name, or None for a flat/unversioned pack."""

    @property
    def has_manifest(self) -> bool:
        return self.manifest_path is not None

    @property
    def inventory(self) -> list[str]:
        """Declared skill names: `[freeform].skills`, or the globbed dirs when no pack.toml."""
        return list(self.manifest.freeform_skills)


class PackEntry(BaseModel):
    """One entry of a skills.json `packs[]` array (contract section 1)."""

    model_config = ConfigDict(frozen=True)

    name: str
    version: str | None = None
    source: str | None = None
    registry: str | None = None
    registry_path: str | None = None
    include: tuple[str, ...] = ()
    exclude: tuple[str, ...] = ()
    optional: bool = False
    sealed: bool | None = None
    flatten: bool | None = None

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        if not PACK_NAME_PATTERN.match(v) or not is_safe_component(v):
            raise ValueError(f"invalid pack name {v!r}; must match {PACK_NAME_PATTERN.pattern}")
        return v

    @field_validator("version")
    @classmethod
    def _validate_version(cls, v: str | None) -> str | None:
        if v is None:
            return None
        if not VERSION_PATTERN.match(v) or not is_safe_component(v):
            raise ValueError(f"invalid pack version {v!r}; must match {VERSION_PATTERN.pattern}")
        return v

    @field_validator("registry_path")
    @classmethod
    def _validate_registry_path(cls, v: str | None) -> str | None:
        if v is None:
            return None
        if not is_safe_relpath(v):
            raise ValueError(
                f"invalid registry_path {v!r}; must be a relative, /-separated path "
                "with no '.', '..' or empty segments"
            )
        return v

    @field_validator("include", "exclude")
    @classmethod
    def _validate_filter_names(cls, v: tuple[str, ...]) -> tuple[str, ...]:
        for name in v:
            if not is_safe_component(name):
                raise ValueError(f"invalid skill name {name!r}; must be one safe path component")
        return v

    @model_validator(mode="after")
    def _validate_exclusivity(self) -> PackEntry:
        if self.source is not None and self.registry_path is not None:
            raise ValueError("pack entry may not set both 'source' and 'registry_path'")
        return self

    @classmethod
    def from_spec(cls, spec: str | dict[str, object]) -> PackEntry:
        """Build an entry from the string shorthand or the object form.

        `"bmad"` -> name only; `"bmad@6.10.2"` -> name + version.
        """
        if isinstance(spec, str):
            name, sep, version = spec.partition("@")
            return cls(name=name, version=version if sep else None)
        return cls.model_validate(spec)

    def filter_inventory(self, names: list[str]) -> list[str]:
        """Apply `include` then `exclude` to a declared inventory, preserving order."""
        selected = [n for n in names if n in self.include] if self.include else list(names)
        if self.exclude:
            selected = [n for n in selected if n not in self.exclude]
        return selected

    def is_sealed(self, manifest_sealed: bool) -> bool:
        """Resolve the effective sealed flag.

        `sealed` in the manifest may only TIGHTEN: `sealed: false` MUST NOT disable
        a pack.toml that declares `[policy] sealed = true`.
        """
        return manifest_sealed or bool(self.sealed)

    def is_flattened(self, pack_flatten: bool) -> bool:
        """Resolve the effective flatten flag (contract section 3b).

        Enabled when EITHER the pack's `pack.toml` declares `[policy] flatten = true`
        OR this manifest entry sets `"flatten": true`. Layout is a property of the
        pack, so `pack.toml` is the natural home; the manifest field exists for packs
        that ship no `pack.toml`. Like `sealed`, the manifest may only TIGHTEN -
        `"flatten": false` does not un-flatten a pack that declares the layout.
        """
        return pack_flatten or bool(self.flatten)


class UnsupportedFieldError(ValueError):
    """A manifest field that exists in the schema but that sync deliberately refuses.

    Distinct from a plain validation error so the loader can report it as
    ``E_UNSUPPORTED_FIELD`` with the authored explanation intact. Silently ignoring
    one of these would be the worst outcome: `sets[].flatten` in particular would
    project **zero** skills and report success.
    """


def _refuse(field_name: str, why: str) -> None:
    raise UnsupportedFieldError(f"{field_name} is not supported. {why}")


class SetEntry(BaseModel):
    """One entry of a skills.json `sets[]` array.

    A set is a directory of symlinks under ``sets/<name>`` in the registry.
    Declaring it projects every member; you never list members individually.

    Four schema fields are accepted-and-refused rather than ignored -- see
    :class:`UnsupportedFieldError` and the per-field explanations below.
    """

    model_config = ConfigDict(frozen=True)

    name: str
    source: str | None = None
    registry_path: str | None = None
    include: tuple[str, ...] = ()
    exclude: tuple[str, ...] = ()
    optional: bool = False

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        if not PACK_NAME_PATTERN.match(v) or not is_safe_component(v):
            raise ValueError(f"invalid set name {v!r}; must match {PACK_NAME_PATTERN.pattern}")
        return v

    @field_validator("registry_path")
    @classmethod
    def _validate_registry_path(cls, v: str | None) -> str | None:
        if v is None:
            return None
        if not is_safe_relpath(v):
            raise ValueError(
                f"invalid registry_path {v!r}; must be a relative, /-separated path "
                "with no '.', '..' or empty segments"
            )
        return v

    @field_validator("include", "exclude")
    @classmethod
    def _validate_filter_names(cls, v: tuple[str, ...]) -> tuple[str, ...]:
        for name in v:
            if not is_safe_component(name):
                raise ValueError(f"invalid skill name {name!r}; must be one safe path component")
        return v

    @model_validator(mode="after")
    def _validate_exclusivity(self) -> SetEntry:
        if self.source is not None and self.registry_path is not None:
            raise ValueError("set entry may not set both 'source' and 'registry_path'")
        return self

    @classmethod
    def from_spec(cls, spec: str | dict[str, object]) -> SetEntry:
        """Build an entry from the string shorthand or the object form.

        The shorthand is name-only. The published schema's pattern also admits
        ``<name>@<version>``, but that group was copy-pasted from ``packs`` -- the
        object form has no ``version`` field, so an ``@`` shorthand is not even
        expressible in the long form, and ``sets/`` has no version layout on disk.
        Refused rather than silently treated as part of the name, which would
        produce a confusing "no such set 'min-global@1.0.0'".
        """
        if isinstance(spec, str):
            name, sep, version = spec.partition("@")
            if sep:
                _refuse(
                    f"sets[] shorthand {spec!r}: the '@{version}' version suffix",
                    "Sets are not versioned; the object form has no 'version' field "
                    "and sets/ has no version layout. Use the bare set name.",
                )
            return cls(name=name)
        if "flatten" in spec:
            _refuse(
                "sets[].flatten",
                "The flatten walker never follows a symlink and a set is entirely "
                "symlinks, so enabling it would project zero skills and report success. "
                "Remove the field.",
            )
        if "sealed" in spec:
            _refuse(
                "sets[].sealed",
                "Sealing forbids symlinks anywhere in the payload and a set is entirely "
                "symlinks, so no set can ever be sealed. Remove the field.",
            )
        if "version" in spec:
            _refuse("sets[].version", "Sets are not versioned. Remove the field.")
        if "registry" in spec:
            _refuse(
                "sets[].registry (per-entry override)",
                "Nothing in skillex clones; a second registry would resolve against a "
                "checkout that may not exist. Use the manifest-level 'registry', "
                "--registry-root, or PJ_SKILLS_REGISTRY_ROOT.",
            )
        return cls.model_validate(spec)

    def filter_inventory(self, names: list[str]) -> list[str]:
        """Apply `include` then `exclude` to a member list, preserving order."""
        selected = [n for n in names if n in self.include] if self.include else list(names)
        if self.exclude:
            selected = [n for n in selected if n not in self.exclude]
        return selected


class SkillEntry(BaseModel):
    """One entry of a skills.json `skills[]` array.

    Four authored forms collapse into (projected name, registry-relative path):

    ==============================  ==============  ==========================
    manifest form                   projected name  path
    ==============================  ==============  ==========================
    ``"hindsight"``                 ``hindsight``   ``all-skills/hindsight``
    ``"sets/min-global/hindsight"`` ``hindsight``   as written
    ``{name, registry_path}``       ``name``        ``registry_path``
    ``{name}``                      ``name``        ``all-skills/<name>``
    ==============================  ==============  ==========================

    The projected name is ALWAYS the declared name, never the target's basename.
    """

    model_config = ConfigDict(frozen=True)

    name: str
    source: str | None = None
    registry_path: str | None = None
    #: The slash-form string as authored, when the entry came from that shorthand.
    raw_path: str | None = None

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        if not PROJECTION_NAME_PATTERN.match(v) or not is_safe_component(v):
            raise ValueError(
                f"invalid skill name {v!r}; must match {PROJECTION_NAME_PATTERN.pattern}"
            )
        return v

    @field_validator("registry_path", "raw_path")
    @classmethod
    def _validate_relpath(cls, v: str | None) -> str | None:
        if v is None:
            return None
        if not is_safe_relpath(v):
            raise ValueError(
                f"invalid path {v!r}; must be a relative, /-separated path "
                "with no '.', '..' or empty segments"
            )
        return v

    @model_validator(mode="after")
    def _validate_exclusivity(self) -> SkillEntry:
        if self.source is not None and self.registry_path is not None:
            raise ValueError("skill entry may not set both 'source' and 'registry_path'")
        return self

    @classmethod
    def from_spec(cls, spec: str | dict[str, object]) -> SkillEntry:
        """Build an entry from the string shorthand or the object form.

        The string form is validated here rather than at resolution time because
        the published schema puts NO pattern on it: ``"/etc/passwd"`` and
        ``"../../../../etc/passwd"`` both validate against the schema today and
        would otherwise be joined straight onto the registry root.
        """
        if isinstance(spec, str):
            if not is_safe_relpath(spec):
                raise ValueError(
                    f"invalid skills[] entry {spec!r}; must be a relative, /-separated "
                    "path with no '.', '..' or empty segments"
                )
            if "/" in spec:
                return cls(name=spec.rsplit("/", 1)[1], raw_path=spec)
            return cls(name=spec)
        if "version" in spec:
            _refuse(
                "skills[].version (a git ref)",
                "Nothing in skillex clones or checks out; sync-skills.py is the only "
                "surface allowed to clone. Remove the field.",
            )
        if "registry" in spec:
            _refuse(
                "skills[].registry (per-entry override)",
                "Nothing in skillex clones. Use the manifest-level 'registry', "
                "--registry-root, or PJ_SKILLS_REGISTRY_ROOT.",
            )
        return cls.model_validate(spec)

    @property
    def relpath(self) -> str:
        """Registry-relative path this entry resolves to, absent a `source`."""
        return self.registry_path or self.raw_path or f"all-skills/{self.name}"


VERSION_REF_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/+-]*$")
"""A pinned upstream version: a git tag, branch, or commit SHA.

Deliberately NOT :data:`VERSION_PATTERN` (which forbids ``/`` and so cannot
express ``origin/main`` or ``release/1.4``) and deliberately narrower than git's
own ``check-ref-format`` in two ways that matter for safety: it must not start
with ``-`` (a ref that becomes a command-line flag) and it may not contain ``..``
(git's range operator, which would silently turn a pin into a diff).
"""

_REPO_SCHEMES = ("https://", "http://", "ssh://", "git://", "git@", "file://")


class SourceSkill(BaseModel):
    """One skill taken from an external source: (catalog name, directory in the repo).

    The two halves are separate because on this machine they disagree twice, in
    opposite directions:

    * ``momo`` -- the source directory is named ``skill`` and the catalog name is
      ``momo``, so the name cannot be the basename;
    * ``project-jangler`` -- the source directory *is* ``project-jangler`` but its
      ``SKILL.md`` frontmatter says ``name: pjangler``, so the name cannot be the
      frontmatter either.

    The catalog name therefore comes from the manifest and only from the manifest.
    ``dir`` merely defaults to it.
    """

    model_config = ConfigDict(frozen=True)

    name: str
    dir: str | None = None

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        if not PROJECTION_NAME_PATTERN.match(v) or not is_safe_component(v):
            raise ValueError(
                f"invalid catalog name {v!r}; must match {PROJECTION_NAME_PATTERN.pattern}"
            )
        return v

    @field_validator("dir")
    @classmethod
    def _validate_dir(cls, v: str | None) -> str | None:
        if v is None:
            return None
        if not is_safe_component(v):
            raise ValueError(f"invalid source directory {v!r}; must be one safe path component")
        return v

    @classmethod
    def from_spec(cls, spec: str | dict[str, object]) -> SourceSkill:
        """``"mise-tasks"`` or ``{name = "momo", dir = "skill"}``."""
        if isinstance(spec, str):
            return cls(name=spec)
        return cls.model_validate(spec)

    @property
    def relpath(self) -> str:
        """Directory name inside the source's ``subdir``."""
        return self.dir or self.name


class SourceEntry(BaseModel):
    """One ``[[source]]`` table of ``all-skills/sources.toml``.

    A source names an external git repository that AUTHORS skills. `skillex vendor`
    reads them out of that repository at ``version`` -- from an already-present
    local object database, never over the network -- and lands them under
    ``all-skills/`` as real, committed content.

    ``subdir`` defaults to ``"skills"``: the repo's root-level skills directory is
    the convention, and the manifest only has to say otherwise for a repo that
    breaks it (``momo`` keeps its single skill in ``skill/``).
    """

    model_config = ConfigDict(frozen=True)

    name: str
    repo: str
    version: str
    subdir: str = "skills"
    checkout: str | None = None
    skills: tuple[SourceSkill, ...] = ()
    include: tuple[str, ...] = ()
    exclude: tuple[str, ...] = ()
    optional: bool = False

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        if not PACK_NAME_PATTERN.match(v) or not is_safe_component(v):
            raise ValueError(f"invalid source name {v!r}; must match {PACK_NAME_PATTERN.pattern}")
        return v

    @field_validator("repo")
    @classmethod
    def _validate_repo(cls, v: str) -> str:
        if not v.startswith(_REPO_SCHEMES):
            raise ValueError(
                f"invalid repo {v!r}; must start with one of {', '.join(_REPO_SCHEMES)}. "
                "It is a provenance identity recorded in every receipt, never a URL "
                "skillex dials."
            )
        return v

    @field_validator("version")
    @classmethod
    def _validate_version(cls, v: str) -> str:
        if not VERSION_REF_PATTERN.match(v) or ".." in v:
            raise ValueError(
                f"invalid version {v!r}; must be a git tag, branch or commit SHA matching "
                f"{VERSION_REF_PATTERN.pattern} and containing no '..'"
            )
        return v

    @field_validator("subdir")
    @classmethod
    def _validate_subdir(cls, v: str) -> str:
        # "" is the repo root, which is how a repo with no skills/ directory at all
        # is expressed. Anything else must be a safe relative path.
        if v and not is_safe_relpath(v):
            raise ValueError(
                f"invalid subdir {v!r}; must be a relative, /-separated path with no "
                "'.', '..' or empty segments (or \"\" for the repository root)"
            )
        return v

    @field_validator("checkout")
    @classmethod
    def _validate_checkout(cls, v: str | None) -> str | None:
        if v is None:
            return None
        if not is_safe_component(v):
            raise ValueError(
                f"invalid checkout id {v!r}; must be one safe path component. It is a "
                "LOGICAL id resolved against the local ladder, never a path -- "
                "sources.toml is committed and may not contain a machine path."
            )
        return v

    @field_validator("include", "exclude")
    @classmethod
    def _validate_filter_names(cls, v: tuple[str, ...]) -> tuple[str, ...]:
        for name in v:
            if not is_safe_component(name):
                raise ValueError(f"invalid skill name {name!r}; must be one safe path component")
        return v

    @model_validator(mode="after")
    def _validate_exclusivity(self) -> SourceEntry:
        if self.skills and (self.include or self.exclude):
            raise ValueError(
                "source may not set both an explicit 'skills' list and 'include'/'exclude'; "
                "the list is already the selection"
            )
        seen: set[str] = set()
        for skill in self.skills:
            if skill.name in seen:
                raise ValueError(f"duplicate catalog name {skill.name!r} in source {self.name!r}")
            seen.add(skill.name)
        return self

    @classmethod
    def from_spec(cls, spec: dict[str, object]) -> SourceEntry:
        """Build a source from one ``[[source]]`` table, refusing five near-misses."""
        for field_name in ("clone", "fetch", "auto_fetch"):
            if field_name in spec:
                _refuse(
                    f"source.{field_name}",
                    "skillex never clones and never fetches; sync-skills.py is the only "
                    "surface allowed to clone (paths.py). Check the repository out "
                    "yourself -- `vendor` prints the exact command -- or set "
                    "'optional = true'. Remove the field.",
                )
        if "url" in spec:
            _refuse("source.url", "Renamed to 'repo'. Remove the field.")
        if "ref" in spec:
            _refuse(
                "source.ref",
                "Renamed to 'version', which already accepts a tag, a branch or a "
                "commit SHA. Two fields could disagree about the pin. Remove the field.",
            )
        if "path" in spec:
            _refuse(
                "source.path",
                "Ambiguous between the local checkout and the in-repo directory. Use "
                "'subdir' for the directory inside the repository; the local checkout "
                "is resolved from the machine, never from this committed file.",
            )
        for field_name in ("skills", "include", "exclude"):
            value = spec.get(field_name)
            if value is not None and not isinstance(value, list):
                raise ValueError(f"source.{field_name} must be an array")
        raw_skills = spec.get("skills")
        if isinstance(raw_skills, list):
            spec = dict(spec)
            spec["skills"] = [
                SourceSkill.from_spec(item)
                if isinstance(item, str | dict)
                else _bad_skill_spec(item)
                for item in raw_skills
            ]
        return cls.model_validate(spec)

    @property
    def checkout_id(self) -> str:
        """Logical checkout this source resolves through. Defaults to its name.

        Two sources may share one: ``33GOD`` owns skills at two unrelated paths
        (``33god-platform/skills`` and ``krebs/skills``), which is two ``[[source]]``
        tables over one repository and one working copy.
        """
        return self.checkout or self.name

    def tree_path(self, skill: SourceSkill) -> str:
        """Repo-root-relative path of one skill's directory."""
        return f"{self.subdir}/{skill.relpath}" if self.subdir else skill.relpath

    def filter_inventory(self, names: list[str]) -> list[str]:
        """Apply `include` then `exclude` to a discovered member list, preserving order."""
        selected = [n for n in names if n in self.include] if self.include else list(names)
        if self.exclude:
            selected = [n for n in selected if n not in self.exclude]
        return selected


def _bad_skill_spec(item: object) -> SourceSkill:
    raise ValueError(
        f"source.skills[] entry must be a string or a table, got {type(item).__name__}"
    )


class SourcesManifest(BaseModel):
    """A parsed ``sources.toml``.

    ``sources`` is a TUPLE for the same reason the other manifests use one: order
    is authored and reporting follows it.
    """

    model_config = ConfigDict(frozen=True)

    path: Path
    version: int = 1
    sources: tuple[SourceEntry, ...] = ()
    unknown_keys: tuple[str, ...] = ()

    @property
    def is_empty(self) -> bool:
        return not self.sources

    def by_name(self) -> dict[str, SourceEntry]:
        return {entry.name: entry for entry in self.sources}


class SkillsManifest(BaseModel):
    """The subset of a skills.json manifest this CLI reads.

    `sets` and `skills` are TUPLES, never sets or dicts: the entire precedence law
    is positional (a later set overwrites an earlier one), so losing declaration
    order loses the semantics.
    """

    model_config = ConfigDict(frozen=True)

    path: Path
    schema_url: str | None = None
    scope: str | None = None
    inherit_global: bool | None = None
    registry: str | None = None
    packs: tuple[PackEntry, ...] = ()
    sets: tuple[SetEntry, ...] = ()
    skills: tuple[SkillEntry, ...] = ()
    #: Keys present in the JSON that this reader does not know. The schema sets no
    #: ``additionalProperties: false``, so ``"skils"`` is accepted silently today.
    unknown_keys: tuple[str, ...] = ()

    @property
    def is_empty(self) -> bool:
        return not (self.packs or self.sets or self.skills)


class CliAdapterConfig(BaseModel):
    """One entry in the [cli.*] section of skillex.toml."""

    model_config = ConfigDict(frozen=True)

    name: str
    enabled: bool
    global_root: Path
    project_root: Path


class ScopeConfig(BaseModel):
    """Which pack is active at a given scope."""

    model_config = ConfigDict(frozen=True)

    active_pack: str | None = None


class SkillexConfig(BaseModel):
    """Fully resolved ~/.config/skillex/skillex.toml."""

    model_config = ConfigDict(frozen=True)

    skills_root: Path
    packs_root: Path
    log_format: Literal["console", "json"] = "console"
    scopes: dict[str, ScopeConfig] = Field(default_factory=dict)
    cli_adapters: dict[str, CliAdapterConfig] = Field(default_factory=dict)


class LinkOp(BaseModel):
    """One filesystem operation in an activation plan.

    action=add creates a symlink at target pointing to source.
    action=remove deletes the symlink at target (source is informational).
    action=keep is a no-op, used only for plan display.
    """

    model_config = ConfigDict(frozen=True)

    action: Literal["add", "remove", "keep"]
    target: Path
    source: Path
    cli: str
    scope: Literal["global", "project"]
