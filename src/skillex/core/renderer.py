"""Render a pack: write `pack.toml` + `SHA256SUMS` for a pack directory.

Ported from the validated reference renderer; it round-trips both real bmad packs
byte-for-byte. The payload definition is exactly PACKS-CONTRACT.md section 4:

    payload = pack.toml + every file recursively under each declared skill dir

Mutation discipline - the whole file exists to preserve this property:

    Every check that can fail runs BEFORE the first byte is written. The payload
    is enumerated (which raises on any symlink or non-regular file) and every
    digest is computed up front, so one unsafe or broken symlink anywhere in the
    tree produces ZERO mutation.

`pack.toml` is hashed from the exact bytes about to be written rather than
re-walking the tree afterwards, so there is no window where pack.toml exists but
SHA256SUMS does not describe it.

Re-rendering an EXISTING pack is the dangerous direction, because render is a
generator: it re-derives the inventory from the tree and re-emits the manifest
from its arguments. Three rules keep that from quietly eating a pack:

1.  Discovery follows the pack's own layout. A pack that declares
    `[policy] flatten = true` is a two-level tree (contract section 3b), so its
    top-level entries are CONTAINERS with no `SKILL.md` of their own; plain
    single-level discovery would see none of them.
2.  `[policy]` is carried through, not rewritten. Keys the renderer does not
    know about (`overlay_wins`, `base_readonly`, ...) are re-emitted verbatim.
3.  Anything still lost is a hard stop. A re-render that would drop a key the
    existing `pack.toml` declares refuses without `--force`, as does one against
    a pack marked `immutable` or `base_readonly`, or one whose `pack.toml` does
    not parse. Fail closed: an unreadable manifest is never treated as an empty
    one.
"""

from __future__ import annotations

import hashlib
import re
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from skillex.core.loader import discover_declared_dirs, flatten_inventory
from skillex.core.models import VERSION_PATTERN, is_safe_component
from skillex.core.payload import (
    MANIFEST_FILENAME,
    SUMS_FILENAME,
    PayloadError,
    assert_real_dir,
    discover_skill_dirs,
    payload_entries,
    sha256_file,
    unauthenticated_directories,
)
from skillex.logging import get_logger

log = get_logger(__name__)

RENDERED_POLICY_KEYS = frozenset({"immutable", "sealed", "flatten", "project_projection"})
"""`[policy]` keys the renderer emits from its own arguments.

Every OTHER key found in an existing `[policy]` is carried through untouched.
`packs/hermes-base` declares `overlay_wins` and `base_readonly`, which are
consumed by the curator guard and are not the renderer's to invent or discard.
"""

PROTECTED_POLICY_KEYS: tuple[str, ...] = ("immutable", "base_readonly")
"""Declarations that make a pack read-only, so re-rendering it needs `--force`.

`immutable` forbids re-render outright. `base_readonly` says the directories are
a verifiable mirror that an agent must never edit in place - which a re-render
very much is. Neither implies the other, and a pack may declare either alone.
"""


class RenderError(Exception):
    """Raised when a pack cannot be rendered."""


@dataclass(frozen=True)
class RenderPlan:
    """Everything a render will write, computed before anything is written."""

    root: Path
    name: str
    version: str
    skills: tuple[str, ...]
    """The DECLARED inventory about to be written to `[freeform].skills`.

    For a flattened pack these are the containers, not the projected leaves; the
    payload and the seal are defined from exactly these entries (section 4).
    """
    payload: tuple[str, ...]
    """Payload paths of the rendered pack, including pack.toml."""
    declared_payload_files: int
    """`[source].payload_files`: the payload count EXCLUDING pack.toml."""
    manifest_text: str
    sums_text: str
    flatten: bool = False
    """Whether this pack projects through section 3b container expansion."""
    leaves: tuple[str, ...] = ()
    """Projected leaf skill names when `flatten`; the declared names otherwise."""
    dropped_keys: tuple[str, ...] = ()
    """Keys the existing pack.toml declares that this render would NOT re-emit.

    Non-empty means the render is LOSSY and :func:`apply_render` will refuse it
    without `force`. Computed here so `--check` can show it before anything runs.
    """
    unparseable_manifest: bool = False
    """True when a pack.toml exists at the root but could not be parsed.

    Treated as protective, never as absent: a manifest that cannot be read cannot
    be shown to be safe to overwrite.
    """

    @property
    def manifest_path(self) -> Path:
        return self.root / MANIFEST_FILENAME

    @property
    def sums_path(self) -> Path:
        return self.root / SUMS_FILENAME


def render_manifest_text(
    name: str,
    version: str,
    skills: list[str],
    payload_count: int,
    *,
    description: str = "",
    upstream: str | None = None,
    upstream_version: str | None = None,
    rendered_from: str | None = None,
    immutable: bool = True,
    sealed: bool = True,
    project_projection: str | None = "symlink",
    flatten: bool = False,
    extra_policy: Mapping[str, Any] | None = None,
) -> str:
    """Render pack.toml text. Deterministic: same inputs, same bytes.

    `extra_policy` carries through `[policy]` keys the renderer does not own. They
    are emitted last, sorted, so the output stays byte-stable; a pack with none
    (both bmad packs) renders exactly as it did before this parameter existed.
    """
    lines = [
        "[pack]",
        f'name = "{_toml_str(name)}"',
        f'version = "{_toml_str(version)}"',
        f'description = "{_toml_str(description)}"',
        "",
        "[source]",
    ]
    if upstream:
        lines.append(f'upstream = "{_toml_str(upstream)}"')
        lines.append(f'upstream_version = "{_toml_str(upstream_version or version)}"')
    if rendered_from:
        lines.append(f'rendered_from = "{_toml_str(rendered_from)}"')
    lines.append(f"payload_files = {payload_count}")
    lines += ["", "[freeform]", "skills = ["]
    lines += [f'  "{_toml_str(s)}",' for s in skills]
    lines += [
        "]",
        "",
        "[policy]",
        f"immutable = {str(immutable).lower()}",
        f"sealed = {str(sealed).lower()}",
    ]
    if project_projection:
        lines.append(f'project_projection = "{_toml_str(project_projection)}"')
    if flatten:
        # Emitted only when true, so an unflattened pack is byte-identical to
        # what previous versions of this renderer produced.
        lines.append("flatten = true")
    carried: Mapping[str, Any] = extra_policy or {}
    for key in sorted(carried):
        if key in RENDERED_POLICY_KEYS:
            continue
        if not _KEY_PATTERN.match(key):
            raise RenderError(f"policy key {key!r} cannot be embedded in pack.toml")
        lines.append(f"{key} = {_toml_value(carried[key], f'[policy].{key}')}")
    lines.append("")
    return "\n".join(lines)


_KEY_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
"""A bare TOML key. Anything else would need quoting, so it is refused instead."""


def _toml_str(value: str) -> str:
    """Guard against a value that would break out of a TOML basic string."""
    if any(c in value for c in ('"', "\\", "\n", "\r", "\x00")):
        raise RenderError(f"value {value!r} cannot be embedded in pack.toml")
    return value


def _toml_value(value: Any, what: str) -> str:
    """Render a carried-through TOML scalar or flat array.

    Anything richer (a sub-table, a nested array) RAISES rather than being
    dropped: silently losing a declaration is the exact failure this carry-through
    exists to prevent, so an unrenderable one has to be loud.
    """
    # bool before int: `isinstance(True, int)` is True and would print `1`.
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, str):
        return f'"{_toml_str(value)}"'
    if isinstance(value, list) and all(isinstance(v, str | int | float | bool) for v in value):
        return "[" + ", ".join(_toml_value(v, what) for v in value) + "]"
    raise RenderError(
        f"cannot re-emit {what}: unsupported TOML value {value!r}. "
        "Rendering would drop it; edit pack.toml by hand instead."
    )


def plan_render(
    root: Path,
    name: str,
    version: str,
    *,
    description: str = "",
    upstream: str | None = None,
    upstream_version: str | None = None,
    rendered_from: str | None = None,
    immutable: bool = True,
    sealed: bool = True,
    project_projection: str | None = "symlink",
    flatten: bool | None = None,
    skills: list[str] | None = None,
) -> RenderPlan:
    """Compute the full render without touching the filesystem.

    Raises :class:`RenderError` (or :class:`PayloadError`) on anything unsafe, so a
    caller that plans first and writes second can never half-mutate a pack.

    `flatten` may only TIGHTEN, exactly like everywhere else in the contract: it
    turns section 3b expansion on for a pack whose `pack.toml` does not declare it
    (or that has no `pack.toml` yet), and passing False never turns off a pack that
    declares `[policy] flatten = true` itself.
    """
    if not is_safe_component(name):
        raise RenderError(f"invalid pack name {name!r}; must be one safe path component")
    if not is_safe_component(version) or not VERSION_PATTERN.match(version):
        raise RenderError(f"invalid pack version {version!r}")

    # Validate BEFORE resolving. `Path.resolve()` follows a final-component
    # symlink, so resolving first would silently launder a symlinked pack root
    # into its real target and defeat the "pack root must be a real directory"
    # rule (contract section 2 step 4).
    assert_real_dir(root, "pack root")
    root = root.resolve()
    assert_real_dir(root, "pack root")

    prior = read_existing_manifest(root)
    prior_policy = prior.policy
    # Pure OR, matching `loader.pack_flatten_enabled` and `linter.is_sealed`.
    flatten_effective = bool(prior_policy.get("flatten")) or bool(flatten)

    if skills is not None:
        selected = list(skills)
    elif flatten_effective:
        # A flattened pack's top-level entries are CONTAINERS with no SKILL.md of
        # their own. Single-level discovery sees none of them, which is how a
        # re-render used to silently amputate the pack down to its few already-flat
        # entries and then seal the remains.
        selected = discover_declared_dirs(root)
    else:
        selected = discover_skill_dirs(root)
    if not selected:
        raise RenderError(
            f"no skill directories (child dir with SKILL.md) under {root}; refusing to render"
        )
    for skill in selected:
        if not is_safe_component(skill):
            raise RenderError(f"invalid skill name {skill!r}; must be one safe path component")

    # Enumerate first: this raises on ANY symlink or non-regular file in the payload.
    enumerated = payload_entries(root, selected)
    skill_files = [p for p in enumerated.files if p != MANIFEST_FILENAME]
    declared_payload_files = len(skill_files)

    # A sealed pack may not contain a directory that no checksum authenticates
    # (contract section 4). Rendering one anyway would emit a pack that fails its
    # own verification the instant it is checked, so refuse here instead.
    if sealed:
        hollow = unauthenticated_directories(enumerated.files, enumerated.directories)
        if hollow:
            raise RenderError(
                f"refusing to seal {root}: {len(hollow)} payload director"
                f"{'y' if len(hollow) == 1 else 'ies'} contain no file, so no "
                f"{SUMS_FILENAME} entry can authenticate them: {', '.join(hollow[:5])}"
            )

    manifest_text = render_manifest_text(
        name,
        version,
        selected,
        declared_payload_files,
        description=description,
        upstream=upstream,
        upstream_version=upstream_version,
        rendered_from=rendered_from,
        immutable=immutable,
        sealed=sealed,
        project_projection=project_projection,
        flatten=flatten_effective,
        extra_policy=prior_policy,
    )

    # Hash every skill file now. Any unreadable/irregular file fails here, before
    # a single byte is written.
    digests: dict[str, str] = {rel: sha256_file(root / rel) for rel in skill_files}
    digests[MANIFEST_FILENAME] = hashlib.sha256(manifest_text.encode("utf-8")).hexdigest()

    payload = sorted(digests)
    sums_text = "".join(f"{digests[rel]}  {rel}\n" for rel in payload)

    leaves = (
        tuple(flatten_inventory(root, selected).names) if flatten_effective else tuple(selected)
    )

    return RenderPlan(
        root=root,
        name=name,
        version=version,
        skills=tuple(selected),
        payload=tuple(payload),
        declared_payload_files=declared_payload_files,
        manifest_text=manifest_text,
        sums_text=sums_text,
        flatten=flatten_effective,
        leaves=leaves,
        dropped_keys=tuple(dropped_manifest_keys(prior.document, manifest_text)),
        unparseable_manifest=prior.present and not prior.readable,
    )


@dataclass(frozen=True)
class ExistingManifest:
    """An existing `pack.toml` at a pack root, as far as it could be read.

    `present` and `readable` are kept apart on purpose. A manifest that exists but
    does not parse must NOT be treated as an absent one: that would turn a corrupt
    or truncated `pack.toml` into a free pass past every declaration it was
    supposed to carry (`immutable`, `base_readonly`, `flatten`).
    """

    present: bool = False
    readable: bool = False
    document: Mapping[str, Any] = field(default_factory=dict)

    @property
    def policy(self) -> Mapping[str, Any]:
        policy = self.document.get("policy", {})
        return policy if isinstance(policy, Mapping) else {}


def read_existing_manifest(root: Path) -> ExistingManifest:
    """Parse the `pack.toml` already at `root`, recording whether it could be read."""
    manifest = root / MANIFEST_FILENAME
    if not manifest.is_file():
        return ExistingManifest()
    try:
        raw = tomllib.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError):
        return ExistingManifest(present=True, readable=False)
    return ExistingManifest(present=True, readable=True, document=raw)


def existing_policy(root: Path) -> dict[str, object]:
    """Read `[policy]` from an existing pack.toml, or `{}` if there is none."""
    return dict(read_existing_manifest(root).policy)


def dropped_manifest_keys(before: Mapping[str, Any], rendered_text: str) -> list[str]:
    """Keys declared in `before` that `rendered_text` would not carry over.

    A key-path diff, not a value diff: a re-render is SUPPOSED to move
    `payload_files` and `[freeform].skills`, but it is never supposed to make a
    declaration disappear. This is what catches the whole class of loss rather
    than the two keys that happened to be noticed - `[promote_candidates]`,
    `[source].upstream_git`, a future `[policy]` flag nobody has written yet.
    """
    try:
        after = tomllib.loads(rendered_text)
    except tomllib.TOMLDecodeError:  # pragma: no cover - we generated this text
        return []
    return _missing_key_paths(before, after)


def _missing_key_paths(
    before: Mapping[str, Any], after: Mapping[str, Any], prefix: str = ""
) -> list[str]:
    lost: list[str] = []
    for key, value in before.items():
        path = f"{prefix}{key}"
        if key not in after:
            lost.append(path)
        elif isinstance(value, Mapping) and isinstance(after[key], Mapping):
            lost.extend(_missing_key_paths(value, after[key], f"{path}."))
    return sorted(lost)


def apply_render(plan: RenderPlan, *, force: bool = False) -> None:
    """Write pack.toml then SHA256SUMS.

    Refuses, unless `force` is set, to overwrite a pack whose existing pack.toml

    - declares `[policy] immutable = true` or `[policy] base_readonly = true`,
    - cannot be parsed at all, or
    - declares any key this render would not re-emit.

    Every one of those is re-read from DISK here rather than trusted from the
    plan: the checks in :func:`plan_render` are a preflight, not the only gate,
    and the manifest may have changed since.
    """
    root = plan.root
    # Re-validate at the mutation boundary. Between plan and apply the tree may
    # have been swapped for a symlink.
    assert_real_dir(root, "pack root")

    prior = read_existing_manifest(root)
    if not force:
        if prior.present and not prior.readable:
            raise RenderError(
                f"refusing to re-render {root}: the existing {MANIFEST_FILENAME} does not "
                "parse, so its policy cannot be honoured (pass --force to overwrite it)"
            )
        protected = [key for key in PROTECTED_POLICY_KEYS if bool(prior.policy.get(key))]
        if protected:
            declared = ", ".join(f"[policy] {key} = true" for key in protected)
            raise RenderError(
                f"refusing to re-render {root}: existing pack.toml declares "
                f"{declared} (pass --force to override)"
            )
        dropped = dropped_manifest_keys(prior.document, plan.manifest_text)
        if dropped:
            raise RenderError(
                f"refusing to re-render {root}: this render would drop "
                f"{len(dropped)} declaration(s) the existing {MANIFEST_FILENAME} carries: "
                f"{', '.join(dropped[:8])} (pass --force to discard them)"
            )

    for target in (plan.manifest_path, plan.sums_path):
        if target.is_symlink():
            raise RenderError(f"refusing to write through a symlink: {target}")
        if target.exists() and not target.is_file():
            raise RenderError(f"refusing to overwrite a non-regular file: {target}")

    plan.manifest_path.write_text(plan.manifest_text, encoding="utf-8")
    plan.sums_path.write_text(plan.sums_text, encoding="utf-8")
    log.info(
        "pack.rendered",
        pack=plan.name,
        version=plan.version,
        skills=len(plan.skills),
        leaves=len(plan.leaves),
        flatten=plan.flatten,
        payload_files=len(plan.payload),
        forced=force,
    )


__all__ = [
    "PROTECTED_POLICY_KEYS",
    "RENDERED_POLICY_KEYS",
    "ExistingManifest",
    "PayloadError",
    "RenderError",
    "RenderPlan",
    "apply_render",
    "dropped_manifest_keys",
    "existing_policy",
    "plan_render",
    "read_existing_manifest",
    "render_manifest_text",
]
