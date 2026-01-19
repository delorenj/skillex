"""Fuzzy Matcher Service - Service Layer Component.

This module provides fuzzy matching functionality for skill discovery.
It filters and sorts skills based on case-insensitive substring matching.
"""

from skillex.services.discovery import SkillInfo


class FuzzyMatcherService:
    """Filters and sorts skills using fuzzy substring matching.

    This service provides simple, case-insensitive substring matching
    for skill names. It's designed for interactive CLI usage where users
    may not remember exact skill names.

    The matching is intentionally simple in v1.0:
    - Case-insensitive substring matching only
    - No regex support
    - Results sorted alphabetically

    Example:
        >>> matcher = FuzzyMatcherService()
        >>> skills = [
        ...     SkillInfo("python-pro", Path("/path"), 100, 5),
        ...     SkillInfo("typescript-pro", Path("/path"), 200, 8),
        ...     SkillInfo("rust-pro", Path("/path"), 150, 6),
        ... ]
        >>> results = matcher.match("py", skills)
        >>> print(results[0].name)
        python-pro
    """

    def match(self, pattern: str, skills: list[SkillInfo]) -> list[SkillInfo]:
        """Filter and sort skills based on pattern matching.

        Performs case-insensitive substring matching against skill names.
        An empty pattern matches all skills (returns all, sorted).

        Args:
            pattern: Search pattern (substring to match). Empty string matches all.
            skills: List of SkillInfo objects to filter

        Returns:
            list[SkillInfo]: Filtered and sorted skills, alphabetically by name

        Example:
            >>> matcher = FuzzyMatcherService()
            >>> results = matcher.match("python", all_skills)
            >>> # Returns skills containing "python" (case-insensitive)
        """
        # Normalize pattern for case-insensitive matching
        pattern_lower = pattern.lower()

        # Empty pattern matches all skills
        if not pattern_lower:
            return sorted(skills, key=lambda s: s.name)

        # Filter skills where pattern is substring of name (case-insensitive)
        matches = [
            skill for skill in skills if pattern_lower in skill.name.lower()
        ]

        # Sort alphabetically by name
        return sorted(matches, key=lambda s: s.name)
