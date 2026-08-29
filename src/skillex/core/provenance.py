"""``.source.yaml`` -- the per-skill provenance record, read and written.

163 of these already exist in the catalog. They were written once each by a
``skill_ssot.py`` that has been dead since 2026-06-03 (its systemd unit is
disabled and nothing references it), yet the format is still alive: agents
hand-write it from copy-pasted prompts, so timestamps run months past the
script's last commit. This module takes ownership of the header line and of the
one shape that already almost says what vendoring needs.

**Extended, not replaced.** The wild vocabulary is
``origin.{type, extracted_at, rescued_from, authored_in, upstream,
upstream_version}``, ``modified_locally`` and ``notes``, with
``origin.type`` in ``{local, adhoc, vendored}``. Exactly one ``vendored`` record
exists (``all-skills/ego-browser``) and it already carries ``upstream`` and
``upstream_version``. What it lacks is the three things that make the claim
checkable: which subtree of the repo it came from, which commit that was, and a
digest of what actually landed. Those are added under ``origin`` as new keys, so
every existing reader of ``origin.type`` / ``extracted_at`` / ``modified_locally``
keeps working and nothing already on disk has to be rewritten.

**Two divergences from what came before, both deliberate.**

*Not write-once.* ``skill_ssot.py:92`` opens ``if out.exists(): return``, so no
field was ever updated after extraction. That is why ``project-lifecycle`` still
claims ``modified_locally: false`` through a near-total rewrite. Vendoring
rewrites the record every time it writes the bytes it describes.

*``modified_locally`` is computed, not remembered.* It is written ``false`` at
vendor time (true then, by construction) and kept only so existing readers do not
break. The live answer is ``digest`` recomputed against the directory, which needs
no network, no source repository and no receipt elsewhere -- a fresh clone can
check it.

**Why the receipt is committed here and not in XDG state.** ``core/state.py`` puts
its receipt in ``$XDG_STATE_HOME`` because it records what *this machine* wrote
into an activation root -- per-machine, rewritten on every run, never committable
clean. This receipt is the opposite on every axis: it describes bytes that are
themselves committed, it is byte-identical on every machine by construction, it
changes only in the same commit that changes those bytes, and it must be visible
in the diff that introduces them. The declaration/receipt split is preserved --
``sources.toml`` declares, ``.source.yaml`` records -- and the split lands where
the facts live.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import yaml

SOURCE_YAML = ".source.yaml"

HEADER = "# Provenance for this skill. Managed by `skillex vendor`; do not hand-edit."

#: ``origin.type`` this module writes. The other two values in the wild
#: (``local``, ``adhoc``) are read and never produced.
VENDORED = "vendored"


@dataclass(frozen=True)
class Provenance:
    """A parsed ``.source.yaml``. Every field optional; the file is not a schema."""

    type: str = "local"
    source: str | None = None
    upstream: str | None = None
    upstream_version: str | None = None
    upstream_commit: str | None = None
    upstream_tree: str | None = None
    upstream_path: str | None = None
    extracted_at: str | None = None
    digest: str | None = None
    modified_locally: bool = False
    notes: str | None = None

    @property
    def is_vendored(self) -> bool:
        return self.type == VENDORED

    def as_dict(self) -> dict[str, object]:
        """The published shape, for ``--json``."""
        return {
            "type": self.type,
            "source": self.source,
            "upstream": self.upstream,
            "upstream_version": self.upstream_version,
            "upstream_commit": self.upstream_commit,
            "upstream_tree": self.upstream_tree,
            "upstream_path": self.upstream_path,
            "extracted_at": self.extracted_at,
            "digest": self.digest,
            "modified_locally": self.modified_locally,
        }


def now_stamp() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _text(raw: object) -> str | None:
    """A string field, or None when absent or the wrong shape.

    Same rule ``state.py`` states for its receipt: a record that fails to parse
    must degrade to "I know less", never to a crash and never to a wrong type
    flowing into a decision about whether to overwrite someone's edit.
    """
    if isinstance(raw, str):
        return raw
    if isinstance(raw, int | float) and not isinstance(raw, bool):
        return str(raw)
    return None


def parse_provenance(text: str) -> Provenance | None:
    """Parse a ``.source.yaml`` body. Returns None when it is not a usable record."""
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError:
        return None
    if not isinstance(data, dict):
        return None
    origin_raw = data.get("origin")
    origin: dict[str, object] = origin_raw if isinstance(origin_raw, dict) else {}
    modified = data.get("modified_locally")
    return Provenance(
        type=_text(origin.get("type")) or "local",
        source=_text(origin.get("source")),
        upstream=_text(origin.get("upstream")),
        upstream_version=_text(origin.get("upstream_version")),
        upstream_commit=_text(origin.get("upstream_commit")),
        upstream_tree=_text(origin.get("upstream_tree")),
        upstream_path=_text(origin.get("upstream_path")),
        extracted_at=_text(origin.get("extracted_at")),
        digest=_text(origin.get("digest")),
        modified_locally=bool(modified) if isinstance(modified, bool) else False,
        # A folded (`>`) block always parses back with a trailing newline that is
        # a YAML artifact, not content. Normalized so a round-trip is an identity.
        notes=(_text(data.get("notes")) or "").strip() or None,
    )


def read_provenance(skill_dir: Path) -> Provenance | None:
    """Read ``<skill_dir>/.source.yaml``. Never raises; None means "no usable record"."""
    path = skill_dir / SOURCE_YAML
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, ValueError):
        # ValueError and not UnicodeDecodeError alone: a truncated or zeroed file is
        # exactly the case this exists for, and half of those are not valid UTF-8.
        return None
    return parse_provenance(text)


def _scalar(value: str) -> str:
    """Render one scalar, quoting exactly when a bare one would not round-trip.

    Self-checking rather than a hand-maintained character blacklist, because the
    blacklist was wrong: a 40-character commit SHA that happens to be all digits
    reads back as the integer 0, and the record then claims a pin it does not
    have. Anything YAML would not hand back byte-identical gets quoted.
    """
    if not value or value.strip() != value:
        return _quote(value)
    try:
        if yaml.safe_load(value) == value:
            return value
    except yaml.YAMLError:
        pass
    return _quote(value)


def _quote(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
    return f'"{escaped}"'


def render_provenance(prov: Provenance) -> str:
    """Render the fixed block layout the catalog already uses.

    Hand-rendered rather than ``yaml.safe_dump``-ed so key order is the authored
    order (which is the reading order: what, from where, at what version, proved
    how) and so the header comment survives -- a dumper would drop it, and the
    header is the only place the file says who owns it.
    """
    lines = [HEADER, "origin:", f"  type: {_scalar(prov.type)}"]
    for key, value in (
        ("source", prov.source),
        ("upstream", prov.upstream),
        ("upstream_version", prov.upstream_version),
        ("upstream_commit", prov.upstream_commit),
        ("upstream_tree", prov.upstream_tree),
        ("upstream_path", prov.upstream_path),
        ("extracted_at", prov.extracted_at),
        ("digest", prov.digest),
    ):
        if value is not None:
            lines.append(f"  {key}: {_scalar(value)}")
    lines.append(f"modified_locally: {'true' if prov.modified_locally else 'false'}")
    if prov.notes:
        lines.append("notes: >")
        lines.extend(f"  {line}" for line in prov.notes.strip().splitlines())
    return "\n".join(lines) + "\n"


def write_provenance(skill_dir: Path, prov: Provenance) -> Path:
    """Write ``<skill_dir>/.source.yaml``, OVERWRITING any existing record.

    Deliberately not write-once. ``skill_ssot.py`` returned early when the file
    existed, which froze every claim at extraction time and is how a record can
    still say ``modified_locally: false`` about a directory that was rewritten
    since. A record that is not maintained is worse than none: it is believed.
    """
    path = skill_dir / SOURCE_YAML
    path.write_text(render_provenance(prov), encoding="utf-8")
    return path


__all__ = [
    "HEADER",
    "SOURCE_YAML",
    "VENDORED",
    "Provenance",
    "now_stamp",
    "parse_provenance",
    "read_provenance",
    "render_provenance",
    "write_provenance",
]
