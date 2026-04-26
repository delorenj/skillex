"""Structlog configuration.

Two renderers: console (colored, human-readable) and JSON (machine-parseable).
Select via SkillexConfig.log_format or the top-level --json flag.
"""

from __future__ import annotations

import logging
import sys
from typing import Any, Literal

import structlog


def configure_logging(log_format: Literal["console", "json"] = "console") -> None:
    """Configure structlog globally. Idempotent."""
    processors: list[structlog.types.Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
    ]
    if log_format == "json":
        processors.append(structlog.processors.JSONRenderer())
    else:
        processors.append(
            structlog.dev.ConsoleRenderer(colors=sys.stderr.isatty())
        )

    structlog.configure(
        processors=processors,
        wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
        logger_factory=structlog.PrintLoggerFactory(file=sys.stderr),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str | None = None) -> Any:
    """Return a bound structlog logger. Typed as Any because structlog's
    dynamic binding does not play well with strict typing."""
    return structlog.get_logger(name)
