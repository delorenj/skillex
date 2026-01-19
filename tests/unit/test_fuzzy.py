"""Unit tests for FuzzyMatcherService - Fuzzy matching testing."""

from pathlib import Path

import pytest

from skillex.services.discovery import SkillInfo
from skillex.services.fuzzy import FuzzyMatcherService


class TestFuzzyMatcherService:
    """Test suite for FuzzyMatcherService."""

    @pytest.fixture
    def matcher(self) -> FuzzyMatcherService:
        """Create FuzzyMatcherService instance.

        Returns:
            FuzzyMatcherService: Service instance
        """
        return FuzzyMatcherService()

    @pytest.fixture
    def sample_skills(self) -> list[SkillInfo]:
        """Create sample skills for testing.

        Returns:
            list[SkillInfo]: Sample skill list
        """
        return [
            SkillInfo(
                name="python-pro",
                path=Path("/path/python-pro"),
                size_bytes=1000,
                file_count=10,
            ),
            SkillInfo(
                name="typescript-pro",
                path=Path("/path/typescript-pro"),
                size_bytes=2000,
                file_count=20,
            ),
            SkillInfo(
                name="rust-pro",
                path=Path("/path/rust-pro"),
                size_bytes=1500,
                file_count=15,
            ),
            SkillInfo(
                name="javascript-pro",
                path=Path("/path/javascript-pro"),
                size_bytes=1800,
                file_count=18,
            ),
            SkillInfo(
                name="golang-pro",
                path=Path("/path/golang-pro"),
                size_bytes=1200,
                file_count=12,
            ),
        ]

    def test_init(self, matcher: FuzzyMatcherService) -> None:
        """Test FuzzyMatcherService initialization."""
        assert isinstance(matcher, FuzzyMatcherService)

    def test_empty_pattern_returns_all_skills(
        self, matcher: FuzzyMatcherService, sample_skills: list[SkillInfo]
    ) -> None:
        """Test that empty pattern returns all skills sorted alphabetically."""
        results = matcher.match("", sample_skills)

        assert len(results) == 5
        # Should be sorted alphabetically
        assert results[0].name == "golang-pro"
        assert results[1].name == "javascript-pro"
        assert results[2].name == "python-pro"
        assert results[3].name == "rust-pro"
        assert results[4].name == "typescript-pro"

    def test_exact_match(
        self, matcher: FuzzyMatcherService, sample_skills: list[SkillInfo]
    ) -> None:
        """Test exact skill name match."""
        results = matcher.match("python-pro", sample_skills)

        assert len(results) == 1
        assert results[0].name == "python-pro"

    def test_partial_match_substring(
        self, matcher: FuzzyMatcherService, sample_skills: list[SkillInfo]
    ) -> None:
        """Test partial substring matching."""
        results = matcher.match("python", sample_skills)

        assert len(results) == 1
        assert results[0].name == "python-pro"

    def test_case_insensitive_matching(
        self, matcher: FuzzyMatcherService, sample_skills: list[SkillInfo]
    ) -> None:
        """Test case-insensitive matching."""
        # Uppercase pattern
        results_upper = matcher.match("PYTHON", sample_skills)
        assert len(results_upper) == 1
        assert results_upper[0].name == "python-pro"

        # Mixed case pattern
        results_mixed = matcher.match("PyThOn", sample_skills)
        assert len(results_mixed) == 1
        assert results_mixed[0].name == "python-pro"

        # Lowercase pattern
        results_lower = matcher.match("python", sample_skills)
        assert len(results_lower) == 1
        assert results_lower[0].name == "python-pro"

    def test_multiple_matches_sorted_alphabetically(
        self, matcher: FuzzyMatcherService, sample_skills: list[SkillInfo]
    ) -> None:
        """Test multiple matches are returned sorted alphabetically."""
        # Pattern "script" matches "javascript-pro" and "typescript-pro"
        results = matcher.match("script", sample_skills)

        assert len(results) == 2
        # Should be alphabetically sorted
        assert results[0].name == "javascript-pro"
        assert results[1].name == "typescript-pro"

    def test_pattern_matches_suffix(
        self, matcher: FuzzyMatcherService, sample_skills: list[SkillInfo]
    ) -> None:
        """Test pattern matching at end of skill name."""
        results = matcher.match("pro", sample_skills)

        # All skills end with "-pro"
        assert len(results) == 5
        # Verify sorted alphabetically
        assert results[0].name == "golang-pro"
        assert results[4].name == "typescript-pro"

    def test_pattern_matches_prefix(
        self, matcher: FuzzyMatcherService, sample_skills: list[SkillInfo]
    ) -> None:
        """Test pattern matching at start of skill name."""
        results = matcher.match("rust", sample_skills)

        assert len(results) == 1
        assert results[0].name == "rust-pro"

    def test_pattern_matches_middle(
        self, matcher: FuzzyMatcherService, sample_skills: list[SkillInfo]
    ) -> None:
        """Test pattern matching in middle of skill name."""
        results = matcher.match("lang", sample_skills)

        assert len(results) == 1
        assert results[0].name == "golang-pro"

    def test_no_matches_returns_empty_list(
        self, matcher: FuzzyMatcherService, sample_skills: list[SkillInfo]
    ) -> None:
        """Test that pattern with no matches returns empty list."""
        results = matcher.match("nonexistent", sample_skills)

        assert results == []
        assert isinstance(results, list)

    def test_empty_skills_list(self, matcher: FuzzyMatcherService) -> None:
        """Test matching against empty skills list."""
        results = matcher.match("python", [])

        assert results == []

    def test_empty_pattern_with_empty_skills(
        self, matcher: FuzzyMatcherService
    ) -> None:
        """Test empty pattern with empty skills list."""
        results = matcher.match("", [])

        assert results == []

    def test_single_character_pattern(
        self, matcher: FuzzyMatcherService, sample_skills: list[SkillInfo]
    ) -> None:
        """Test single character pattern matching."""
        results = matcher.match("p", sample_skills)

        # Matches all skills (all contain "p" in "-pro")
        assert len(results) == 5
        # Verify sorted alphabetically
        assert results[0].name == "golang-pro"
        assert results[1].name == "javascript-pro"
        assert results[2].name == "python-pro"
        assert results[3].name == "rust-pro"
        assert results[4].name == "typescript-pro"

    def test_hyphen_in_pattern(
        self, matcher: FuzzyMatcherService, sample_skills: list[SkillInfo]
    ) -> None:
        """Test pattern with hyphen character."""
        results = matcher.match("-pro", sample_skills)

        # All skills contain "-pro"
        assert len(results) == 5

    def test_whitespace_pattern(self, matcher: FuzzyMatcherService) -> None:
        """Test pattern with only whitespace."""
        skills = [
            SkillInfo("test-skill", Path("/path"), 100, 5),
        ]

        # Whitespace should not match empty pattern behavior
        results = matcher.match("   ", skills)

        # Should return no matches (whitespace is not in skill name)
        assert results == []

    def test_special_characters_in_skill_names(
        self, matcher: FuzzyMatcherService
    ) -> None:
        """Test matching skills with special characters in names."""
        skills = [
            SkillInfo("python-3.12-pro", Path("/path"), 100, 5),
            SkillInfo("skill_with_underscores", Path("/path"), 200, 10),
            SkillInfo("skill.with.dots", Path("/path"), 150, 8),
        ]

        # Match by version number
        results = matcher.match("3.12", skills)
        assert len(results) == 1
        assert results[0].name == "python-3.12-pro"

        # Match by underscore
        results = matcher.match("_with_", skills)
        assert len(results) == 1
        assert results[0].name == "skill_with_underscores"

        # Match by dots
        results = matcher.match(".with.", skills)
        assert len(results) == 1
        assert results[0].name == "skill.with.dots"

    def test_pattern_longer_than_skill_names(
        self, matcher: FuzzyMatcherService, sample_skills: list[SkillInfo]
    ) -> None:
        """Test pattern longer than any skill name."""
        very_long_pattern = "this-is-a-very-long-pattern-that-wont-match-anything"
        results = matcher.match(very_long_pattern, sample_skills)

        assert results == []

    def test_alphabetical_sorting_with_mixed_case_names(
        self, matcher: FuzzyMatcherService
    ) -> None:
        """Test alphabetical sorting with mixed case skill names."""
        skills = [
            SkillInfo("Zulu-skill", Path("/path"), 100, 5),
            SkillInfo("alpha-skill", Path("/path"), 100, 5),
            SkillInfo("Bravo-skill", Path("/path"), 100, 5),
        ]

        results = matcher.match("", skills)

        # Should be sorted alphabetically (case-sensitive sort by name)
        assert results[0].name == "Bravo-skill"
        assert results[1].name == "Zulu-skill"
        assert results[2].name == "alpha-skill"

    def test_match_preserves_skill_metadata(
        self, matcher: FuzzyMatcherService
    ) -> None:
        """Test that matching preserves all SkillInfo metadata."""
        skill = SkillInfo(
            name="python-pro",
            path=Path("/test/path"),
            size_bytes=12345,
            file_count=42,
        )

        results = matcher.match("python", [skill])

        assert len(results) == 1
        assert results[0].name == "python-pro"
        assert results[0].path == Path("/test/path")
        assert results[0].size_bytes == 12345
        assert results[0].file_count == 42

    def test_match_returns_new_list(
        self, matcher: FuzzyMatcherService, sample_skills: list[SkillInfo]
    ) -> None:
        """Test that match returns a new list (doesn't modify input)."""
        original_skills = sample_skills.copy()
        results = matcher.match("python", sample_skills)

        # Original list should be unchanged
        assert sample_skills == original_skills
        assert results is not sample_skills


class TestFuzzyMatcherServiceEdgeCases:
    """Edge case tests for FuzzyMatcherService."""

    @pytest.fixture
    def matcher(self) -> FuzzyMatcherService:
        """Create FuzzyMatcherService instance."""
        return FuzzyMatcherService()

    def test_unicode_characters_in_pattern(
        self, matcher: FuzzyMatcherService
    ) -> None:
        """Test pattern with unicode characters."""
        skills = [
            SkillInfo("skill-café", Path("/path"), 100, 5),
            SkillInfo("regular-skill", Path("/path"), 100, 5),
        ]

        results = matcher.match("café", skills)
        assert len(results) == 1
        assert results[0].name == "skill-café"

    def test_numeric_patterns(self, matcher: FuzzyMatcherService) -> None:
        """Test patterns with numbers."""
        skills = [
            SkillInfo("python-3", Path("/path"), 100, 5),
            SkillInfo("python-2", Path("/path"), 100, 5),
            SkillInfo("python-pro", Path("/path"), 100, 5),
        ]

        results = matcher.match("3", skills)
        assert len(results) == 1
        assert results[0].name == "python-3"

    def test_duplicate_skill_names_handled(
        self, matcher: FuzzyMatcherService
    ) -> None:
        """Test matching with duplicate skill names in list."""
        skills = [
            SkillInfo("python-pro", Path("/path1"), 100, 5),
            SkillInfo("python-pro", Path("/path2"), 200, 10),
            SkillInfo("rust-pro", Path("/path3"), 150, 8),
        ]

        results = matcher.match("python", skills)

        # Both python-pro entries should be returned
        assert len(results) == 2
        assert results[0].name == "python-pro"
        assert results[1].name == "python-pro"
        # Verify they are distinct objects
        assert results[0].path != results[1].path
