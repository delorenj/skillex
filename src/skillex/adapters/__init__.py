"""Built-in CLI adapters.

Importing this package registers the bundled adapters via module side effects.
"""

from skillex.adapters import claude, codex, gemini, hermes, kimi, opencode

__all__ = ["claude", "codex", "gemini", "hermes", "kimi", "opencode"]
