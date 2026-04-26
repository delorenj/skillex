"""Tests for skillex.core.registry."""

from __future__ import annotations

import pytest

from skillex.core.registry import (
    CANONICAL_SLOT_TYPES,
    explain_invalid_slot_type,
    is_valid_slot_type,
)


class TestCanonicalRegistry:
    def test_mvp_has_three_types(self) -> None:
        assert CANONICAL_SLOT_TYPES == frozenset({"Memory", "Workflow", "TTS"})


class TestIsValidSlotType:
    @pytest.mark.parametrize("name", ["Memory", "Workflow", "TTS"])
    def test_accepts_canonical(self, name: str) -> None:
        assert is_valid_slot_type(name) is True

    @pytest.mark.parametrize(
        "name",
        ["custom:voice-cloning", "custom:ocr", "custom:x"],
    )
    def test_accepts_custom_prefix(self, name: str) -> None:
        assert is_valid_slot_type(name) is True

    @pytest.mark.parametrize(
        "name",
        [
            "memory",         # wrong case
            "Review",         # not yet canonical
            "custom:",        # empty suffix
            "",               # empty
            "random:foo",     # wrong prefix
        ],
    )
    def test_rejects_invalid(self, name: str) -> None:
        assert is_valid_slot_type(name) is False


class TestExplainInvalid:
    def test_empty_custom_suffix_message(self) -> None:
        msg = explain_invalid_slot_type("custom:")
        assert "custom:" in msg
        assert "suffix" in msg

    def test_unknown_canonical_lists_options(self) -> None:
        msg = explain_invalid_slot_type("Review")
        assert "Memory" in msg
        assert "Workflow" in msg
        assert "TTS" in msg
        assert "custom:" in msg
