"""Findings, refusals and exit codes for `skillex sync`.

Every problem sync can have is a :class:`Finding` carrying a stable :class:`Code`.
Nothing is ever reported as a bare string, because two properties depend on the
code being an enum member:

* ``--strict`` promotes a specific, named subset of warnings to errors. A string
  cannot be a member of that set without stringly-typed comparisons that rot.
* ``--json`` publishes ``code`` as a contract. Renaming a message is free;
  renaming a code is a breaking change, and making that visible is the point.

The severity ladder is deliberately three-valued and NOT a log level:

* ``ERROR``   - sync refuses. **Nothing is mutated**, ever, not even partially.
* ``WARNING`` - sync proceeds and tells you what it did that you may not want.
* ``INFO``    - sync proceeds; shown only under ``-v``. Reserved for events that
  are *expected* in a healthy tree, so they must not train the eye to skip
  warnings. Two sets sharing 35 identically-targeted names is INFO; two sets
  disagreeing about one name is a WARNING.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from enum import Enum, StrEnum
from pathlib import Path


class Severity(Enum):
    """Ordered by escalation; `max()` over a run's severities is meaningful."""

    INFO = 10
    WARNING = 20
    ERROR = 30

    def __lt__(self, other: object) -> bool:
        if not isinstance(other, Severity):
            return NotImplemented
        return self.value < other.value

    def __le__(self, other: object) -> bool:
        if not isinstance(other, Severity):
            return NotImplemented
        return self.value <= other.value


class Code(StrEnum):
    """Stable diagnostic identifiers, published in `--json`.

    Prefix encodes severity at the point of definition: ``E_`` errors, ``W_``
    warnings, ``I_`` info. :func:`severity_of` derives severity from the prefix so
    the two can never disagree.
    """

    # -- manifest / configuration (exit 2) ---------------------------------
    E_MANIFEST_PARSE = "E_MANIFEST_PARSE"
    E_MANIFEST_INVALID = "E_MANIFEST_INVALID"
    E_UNSUPPORTED_FIELD = "E_UNSUPPORTED_FIELD"
    E_MULTIPLE_PACKS = "E_MULTIPLE_PACKS"
    E_PACK_VIA_SKILLS = "E_PACK_VIA_SKILLS"
    E_REMOTE_SOURCE = "E_REMOTE_SOURCE"
    E_UNSAFE_PATH = "E_UNSAFE_PATH"
    E_NO_REGISTRY = "E_NO_REGISTRY"
    E_SET_MISSING = "E_SET_MISSING"
    E_SKILL_MISSING = "E_SKILL_MISSING"
    E_PACK_MISSING = "E_PACK_MISSING"
    E_PACK_MEMBER_MISSING = "E_PACK_MEMBER_MISSING"
    E_PACK_DUPLICATE_MEMBER = "E_PACK_DUPLICATE_MEMBER"
    E_TARGET_NOT_A_SKILL = "E_TARGET_NOT_A_SKILL"
    E_NO_PROJECT_MANIFEST = "E_NO_PROJECT_MANIFEST"

    # -- refusals: the disk holds something sync will not touch (exit 3) ----
    E_OCCUPIED = "E_OCCUPIED"
    E_UNMANAGED_ROOT = "E_UNMANAGED_ROOT"
    E_ROOT_NOT_DIR = "E_ROOT_NOT_DIR"
    E_UNSAFE_ROOT_CHAIN = "E_UNSAFE_ROOT_CHAIN"
    E_ROOT_INSIDE_REGISTRY = "E_ROOT_INSIDE_REGISTRY"
    E_REGISTRY_INTERNAL = "E_REGISTRY_INTERNAL"
    E_RECURSIVE_PROJECTION = "E_RECURSIVE_PROJECTION"
    E_UNSAFE_TARGET = "E_UNSAFE_TARGET"
    E_TARGET_IS_PROJECTION = "E_TARGET_IS_PROJECTION"
    E_SYMLINK_CYCLE = "E_SYMLINK_CYCLE"
    E_ALIAS_WOULD_DISCARD = "E_ALIAS_WOULD_DISCARD"
    E_CLI_ALIAS_WRONG_TARGET = "E_CLI_ALIAS_WRONG_TARGET"

    # -- external sources / vendoring --------------------------------------
    #: `skillex vendor` copies skills out of a foreign git repository into
    #: ``all-skills/`` as real committed content. Its refusals split the same way
    #: everything else here does: a bad ``sources.toml`` is exit 2 (edit a file),
    #: a repository or catalog that holds something we will not touch is exit 3
    #: (move files, or push your edit upstream).
    E_SOURCES_PARSE = "E_SOURCES_PARSE"
    E_SOURCES_INVALID = "E_SOURCES_INVALID"
    E_SOURCE_UNKNOWN = "E_SOURCE_UNKNOWN"
    E_SOURCE_SUBDIR_MISSING = "E_SOURCE_SUBDIR_MISSING"
    E_SOURCE_SKILL_MISSING = "E_SOURCE_SKILL_MISSING"
    E_VENDOR_NAME_COLLISION = "E_VENDOR_NAME_COLLISION"
    E_VENDOR_CATALOG_INVALID = "E_VENDOR_CATALOG_INVALID"
    E_SOURCE_CHECKOUT_MISSING = "E_SOURCE_CHECKOUT_MISSING"
    E_SOURCE_NOT_A_REPO = "E_SOURCE_NOT_A_REPO"
    E_SOURCE_REF_UNKNOWN = "E_SOURCE_REF_UNKNOWN"
    E_SOURCE_ENTRY_IS_LINK = "E_SOURCE_ENTRY_IS_LINK"
    E_SOURCE_ENTRY_IS_SUBMODULE = "E_SOURCE_ENTRY_IS_SUBMODULE"
    E_SOURCE_UNSAFE_MEMBER = "E_SOURCE_UNSAFE_MEMBER"
    E_SOURCE_NOT_A_SKILL = "E_SOURCE_NOT_A_SKILL"
    E_VENDOR_LOCAL_EDITS = "E_VENDOR_LOCAL_EDITS"
    E_VENDOR_WOULD_CLOBBER = "E_VENDOR_WOULD_CLOBBER"
    E_VENDOR_NOT_VENDORED = "E_VENDOR_NOT_VENDORED"
    E_VENDOR_STAGE_DIRTY = "E_VENDOR_STAGE_DIRTY"
    E_RELINK_AMBIGUOUS = "E_RELINK_AMBIGUOUS"

    # -- warnings -----------------------------------------------------------
    W_SET_MEMBER_DANGLING = "W_SET_MEMBER_DANGLING"
    W_SET_MEMBER_UNSAFE_NAME = "W_SET_MEMBER_UNSAFE_NAME"
    W_SET_MEMBER_NONCANONICAL_NAME = "W_SET_MEMBER_NONCANONICAL_NAME"
    W_SET_TOPLEVEL_FILE = "W_SET_TOPLEVEL_FILE"
    W_SET_EMBEDDED_DEFINITION = "W_SET_EMBEDDED_DEFINITION"
    W_SET_LINK_OUTSIDE_CATALOG = "W_SET_LINK_OUTSIDE_CATALOG"
    W_SET_CONTAINER_SKIPPED = "W_SET_CONTAINER_SKIPPED"
    W_SET_CONFLICT_RETARGET = "W_SET_CONFLICT_RETARGET"
    W_SET_OPTIONAL_MISSING = "W_SET_OPTIONAL_MISSING"
    W_TARGET_NO_SKILL_MD = "W_TARGET_NO_SKILL_MD"
    W_PACK_TRUMPS = "W_PACK_TRUMPS"
    W_PACK_MISSING = "W_PACK_MISSING"
    W_PACK_EMPTY_CONTAINER = "W_PACK_EMPTY_CONTAINER"
    W_ALIAS_MODE_DECLINED = "W_ALIAS_MODE_DECLINED"
    W_STALE_REGISTRY_CANDIDATE = "W_STALE_REGISTRY_CANDIDATE"
    W_CLI_ROOT_NOT_ALIAS = "W_CLI_ROOT_NOT_ALIAS"
    W_FOREIGN_ENTRY = "W_FOREIGN_ENTRY"
    W_PRUNE_SKIPPED_NOT_LINK = "W_PRUNE_SKIPPED_NOT_LINK"
    W_INHERIT_DUPLICATES_GLOBAL = "W_INHERIT_DUPLICATES_GLOBAL"
    W_INHERIT_ON_GLOBAL = "W_INHERIT_ON_GLOBAL"
    W_SCOPE_MISMATCH = "W_SCOPE_MISMATCH"
    W_MANIFEST_UNKNOWN_KEY = "W_MANIFEST_UNKNOWN_KEY"
    W_PROJECTION_NOT_GITIGNORED = "W_PROJECTION_NOT_GITIGNORED"
    W_INCUMBENT_ENGINE_ACTIVE = "W_INCUMBENT_ENGINE_ACTIVE"
    W_SOURCE_REF_IS_BRANCH = "W_SOURCE_REF_IS_BRANCH"
    W_SOURCE_REMOTE_MISMATCH = "W_SOURCE_REMOTE_MISMATCH"
    W_SOURCE_OPTIONAL_MISSING = "W_SOURCE_OPTIONAL_MISSING"
    W_VENDOR_LOCAL_EDITS = "W_VENDOR_LOCAL_EDITS"
    W_VENDOR_PIN_STALE = "W_VENDOR_PIN_STALE"
    W_VENDOR_UNRECORDED = "W_VENDOR_UNRECORDED"
    W_VENDOR_ORPHANED = "W_VENDOR_ORPHANED"
    W_VENDOR_DROPPED_SOURCE_YAML = "W_VENDOR_DROPPED_SOURCE_YAML"
    W_RELINK_NO_CATALOG_ENTRY = "W_RELINK_NO_CATALOG_ENTRY"

    # -- info (-v only) -----------------------------------------------------
    #: A rival installer's lock file is INFO, not a warning, and the distinction
    #: is the one this class's docstring draws: it is *expected in a healthy
    #: tree*. The other environment checks describe something you can go and fix
    #: -- an unignored root, a wired-up projector -- and they fall silent once you
    #: do. This one cannot: if you still use that installer the file stays, so at
    #: WARNING it is unclearable, fires on every single global sync forever, and
    #: is the only finding on an otherwise healthy run of this machine. That is
    #: precisely how a warning channel gets trained out of a reader. It is also
    #: what STRICT_PROMOTES below already calls it in prose -- "operational noise
    #: (... a rival writer ...) ... describes the environment, not the
    #: composition" -- so this only makes the severity agree with the comment.
    #:
    #: Nothing is lost: ``--json`` publishes every finding regardless of severity,
    #: so a consumer still sees it (now as ``"severity": "info"``), and ``-v``
    #: still shows it to a human who goes looking.
    I_RIVAL_LOCKFILE = "I_RIVAL_LOCKFILE"
    I_SET_REBIND = "I_SET_REBIND"
    I_SKILL_OVERRIDES_SET = "I_SKILL_OVERRIDES_SET"
    I_PROJECT_BELOW_CWD = "I_PROJECT_BELOW_CWD"
    I_SIBLING_PROJECTS = "I_SIBLING_PROJECTS"
    I_VENDOR_UNCHANGED = "I_VENDOR_UNCHANGED"
    I_VENDOR_RELINKED = "I_VENDOR_RELINKED"


#: Warnings ``--strict`` promotes to errors.
#:
#: Every member is a *topology* violation -- something ADR-0001 forbids that sync
#: tolerates so the tree stays syncable during migration. Operational noise
#: (a missing optional set, a rival writer, a not-gitignored root) is deliberately
#: absent: those describe the environment, not the composition, and failing CI on
#: them would make ``--strict`` useless as a topology gate.
STRICT_PROMOTES: frozenset[Code] = frozenset(
    {
        Code.W_SET_TOPLEVEL_FILE,
        Code.W_SET_EMBEDDED_DEFINITION,
        Code.W_SET_LINK_OUTSIDE_CATALOG,
        Code.W_SET_CONFLICT_RETARGET,
        Code.W_PACK_TRUMPS,
        Code.W_SET_MEMBER_DANGLING,
        Code.W_SET_MEMBER_UNSAFE_NAME,
        Code.W_SET_MEMBER_NONCANONICAL_NAME,
        Code.W_TARGET_NO_SKILL_MD,
    }
)

#: Errors that mean "your manifest is wrong" (exit 2) rather than "your disk holds
#: something I will not touch" (exit 3). The split is load-bearing for scripting:
#: 2 is fixed by editing JSON, 3 is fixed by moving files.
_CONFIG_ERRORS: frozenset[Code] = frozenset(
    {
        Code.E_MANIFEST_PARSE,
        Code.E_MANIFEST_INVALID,
        Code.E_UNSUPPORTED_FIELD,
        Code.E_MULTIPLE_PACKS,
        Code.E_PACK_VIA_SKILLS,
        Code.E_REMOTE_SOURCE,
        Code.E_UNSAFE_PATH,
        Code.E_NO_REGISTRY,
        Code.E_SET_MISSING,
        Code.E_SKILL_MISSING,
        Code.E_PACK_MISSING,
        Code.E_PACK_MEMBER_MISSING,
        Code.E_PACK_DUPLICATE_MEMBER,
        Code.E_TARGET_NOT_A_SKILL,
        Code.E_NO_PROJECT_MANIFEST,
        # Vendoring: everything you fix by editing sources.toml (or by passing a
        # different --source / --catalog) is a 2. Everything you fix by touching a
        # repository or moving bytes on disk is a 3 and is deliberately absent.
        Code.E_SOURCES_PARSE,
        Code.E_SOURCES_INVALID,
        Code.E_SOURCE_UNKNOWN,
        Code.E_SOURCE_SUBDIR_MISSING,
        Code.E_SOURCE_SKILL_MISSING,
        Code.E_VENDOR_NAME_COLLISION,
        Code.E_VENDOR_CATALOG_INVALID,
    }
)

#: Warnings ``skillex vendor --strict`` promotes, and ``skillex sync --strict``
#: deliberately does not.
#:
#: :data:`STRICT_PROMOTES` is a *topology* gate -- its own comment reserves it for
#: ADR-0001 violations and excludes anything that "describes the environment, not
#: the composition". Every warning here describes the environment: a moving ref, a
#: pin that has fallen behind, a catalog entry someone hand-edited. They are worth
#: failing a vendoring run over and worthless as a topology signal, and `sync`
#: cannot emit any of them, so putting them in the shared set would be dead weight
#: in the one place a reader looks to learn what ``--strict`` means.
VENDOR_STRICT_PROMOTES: frozenset[Code] = frozenset(
    {
        Code.W_SOURCE_REF_IS_BRANCH,
        Code.W_SOURCE_REMOTE_MISMATCH,
        Code.W_VENDOR_LOCAL_EDITS,
        Code.W_VENDOR_PIN_STALE,
        Code.W_VENDOR_UNRECORDED,
        Code.W_VENDOR_ORPHANED,
    }
)


def severity_of(code: Code) -> Severity:
    """Severity implied by the code's prefix. The prefix IS the declaration."""
    if code.value.startswith("E_"):
        return Severity.ERROR
    if code.value.startswith("W_"):
        return Severity.WARNING
    return Severity.INFO


@dataclass(frozen=True)
class Finding:
    """One diagnostic.

    ``detail`` lines are printed indented under ``message``; ``fix`` is printed
    last as a single ``fix:`` line. Both are optional, but an ERROR without a
    ``fix`` is a bug: every refusal must name a non-destructive way forward.
    """

    code: Code
    message: str
    scope: str | None = None
    name: str | None = None
    path: Path | None = None
    detail: tuple[str, ...] = ()
    fix: str | None = None
    #: True when ``--strict`` promoted this warning to an error.
    #:
    #: The SEVERITY moves and the CODE does not, and the flag is what makes that
    #: expressible: severity is otherwise derived from the code's prefix, so a
    #: promoted copy that carries the same ``W_`` code is byte-identical to the
    #: warning it came from -- which is exactly what :meth:`promoted` used to
    #: return. Renaming the code under a flag is not an option either: ``code`` is
    #: the published ``--json`` contract, and a consumer's mapping must not depend
    #: on which flags the run happened to be given.
    strict: bool = False

    @property
    def severity(self) -> Severity:
        return Severity.ERROR if self.strict else severity_of(self.code)

    def promoted(self) -> Finding:
        """This finding as an ERROR, for ``--strict``. Code and message left intact."""
        if severity_of(self.code) is not Severity.WARNING:
            return self
        return replace(self, strict=True)

    def as_dict(self) -> dict[str, object]:
        out: dict[str, object] = {
            "severity": self.severity.name.lower(),
            "code": self.code.value,
            "message": self.message,
        }
        if self.scope is not None:
            out["scope"] = self.scope
        if self.name is not None:
            out["name"] = self.name
        if self.path is not None:
            out["path"] = str(self.path)
        if self.detail:
            out["detail"] = list(self.detail)
        if self.fix is not None:
            out["fix"] = self.fix
        if self.strict:
            # So a consumer can tell "this is an error" from "--strict made this an
            # error" without diffing two runs.
            out["strict"] = True
        return out


class RefusalError(Exception):
    """A single finding raised as control flow, for the cases that cannot continue.

    Most errors are *collected* and reported together -- one run should tell you
    about all four broken set names, not the first. `RefusalError` is for the cases
    where continuing would compute nonsense: no registry at all, an unsafe path
    about to be joined, a symlink cycle.
    """

    def __init__(self, finding: Finding) -> None:
        super().__init__(finding.message)
        self.finding = finding


@dataclass
class Reporter:
    """Collects findings in emission order.

    Deliberately a plain list and not a set: the same code fires once per offending
    name (10 out-of-catalog links = 10 findings), and the renderer groups them.
    """

    findings: list[Finding] = field(default_factory=list)
    scope: str | None = None

    def emit(self, code: Code, message: str, **kw: object) -> Finding:
        finding = Finding(code=code, message=message, scope=kw.pop("scope", self.scope), **kw)  # type: ignore[arg-type]
        self.findings.append(finding)
        return finding

    def extend(self, findings: list[Finding]) -> None:
        self.findings.extend(findings)

    def worst(self) -> Severity | None:
        return max((f.severity for f in self.findings), default=None)

    def errors(self) -> list[Finding]:
        return [f for f in self.findings if f.severity is Severity.ERROR]

    def warnings(self) -> list[Finding]:
        return [f for f in self.findings if f.severity is Severity.WARNING]


# -- exit codes -------------------------------------------------------------
EXIT_OK = 0
EXIT_INTERNAL = 1
EXIT_CONFIG = 2
EXIT_REFUSED = 3
EXIT_PARTIAL = 4
EXIT_LOCK_BUSY = 5
EXIT_DRIFT = 6
EXIT_INTERRUPTED = 130


def exit_code_for(findings: list[Finding]) -> int:
    """Map a run's findings to an exit code.

    A configuration error and a safety refusal can both be present; the refusal
    wins, because "I did not touch your disk for a reason you must look at" is the
    more urgent of the two and 3 is the stronger signal in a script.
    """
    errors = [f for f in findings if f.severity is Severity.ERROR]
    if not errors:
        return EXIT_OK
    if any(f.code not in _CONFIG_ERRORS for f in errors):
        return EXIT_REFUSED
    return EXIT_CONFIG


__all__ = [
    "EXIT_CONFIG",
    "EXIT_DRIFT",
    "EXIT_INTERNAL",
    "EXIT_INTERRUPTED",
    "EXIT_LOCK_BUSY",
    "EXIT_OK",
    "EXIT_PARTIAL",
    "EXIT_REFUSED",
    "STRICT_PROMOTES",
    "VENDOR_STRICT_PROMOTES",
    "Code",
    "Finding",
    "RefusalError",
    "Reporter",
    "Severity",
    "exit_code_for",
    "severity_of",
]
