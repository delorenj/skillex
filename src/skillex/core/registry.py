"""Canonical slot-type registry and validation.

MVP ships three canonical types. Additional types are promoted one-per-PR
with a regression test. The `custom:` prefix lets users prototype new slot
types without a registry change.
"""

from __future__ import annotations

CANONICAL_SLOT_TYPES: frozenset[str] = frozenset({"Memory", "Workflow", "TTS"})

CUSTOM_PREFIX = "custom:"


def is_valid_slot_type(name: str) -> bool:
    """Return True if name is canonical or uses the custom: prefix with a non-empty suffix."""
    if name in CANONICAL_SLOT_TYPES:
        return True
    if name.startswith(CUSTOM_PREFIX) and len(name) > len(CUSTOM_PREFIX):
        return True
    return False


def explain_invalid_slot_type(name: str) -> str:
    """Produce an actionable error message for an invalid slot type."""
    canonical_list = ", ".join(sorted(CANONICAL_SLOT_TYPES))
    if name.startswith(CUSTOM_PREFIX):
        return (
            f"slot type {name!r} uses the custom: prefix but has no suffix. "
            f"Use something like 'custom:my-slot'."
        )
    return (
        f"slot type {name!r} is not canonical. Either use one of "
        f"[{canonical_list}] or prefix with 'custom:' to declare a new type."
    )
