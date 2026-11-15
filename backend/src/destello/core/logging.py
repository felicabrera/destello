"""Structured JSON logging with structlog."""

from __future__ import annotations

import logging
import sys
from typing import Any

import structlog


def configure_logging(level: str = "INFO") -> None:
    """Configure structlog to emit one JSON object per line on stdout."""
    silence_known_astropy_noise()
    logging.basicConfig(format="%(message)s", stream=sys.stdout, level=level.upper())
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.getLevelName(level.upper())),
        cache_logger_on_first_use=True,
    )


def get_logger(**context: Any) -> Any:
    """Return a bound logger carrying the given context (sequence_id, stage, ...)."""
    return structlog.get_logger().bind(**context)


class _KnownAstropyNoise(logging.Filter):
    """Drop the astropy INFO about SIP coefficients on non-celestial WCS keys.

    SPHEREx headers carry SIP keywords once, for the celestial WCS (RA---TAN-SIP, where SIP is
    intended and applied). Building the auxiliary WCS keys "A" (LINEAR, detector pixels) and "W"
    (WAVE-TAB) from the same header makes astropy repeat a notice that the CTYPE lacks -SIP. SIP is
    not applied to those keys, so the notice is harmless and is emitted once per cutout otherwise.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        return "SIP coefficients were detected" not in record.getMessage()


_FILTER = _KnownAstropyNoise()


def silence_known_astropy_noise() -> None:
    """Attach the filter to the astropy loggers (idempotent)."""
    for name in ("astropy", "astropy.wcs", "astropy.wcs.wcs"):
        lg = logging.getLogger(name)
        if _FILTER not in lg.filters:
            lg.addFilter(_FILTER)
