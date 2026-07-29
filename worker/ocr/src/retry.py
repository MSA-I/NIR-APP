from __future__ import annotations

import random
import time
from collections.abc import Callable
from typing import TypeVar


T = TypeVar("T")


def bounded_backoff(
    attempt: int,
    base_seconds: float = 1.0,
    max_seconds: float = 30.0,
    jitter_ratio: float = 0.2,
    random_value: float | None = None,
) -> float:
    if attempt < 0 or base_seconds <= 0 or max_seconds <= 0 or not 0 <= jitter_ratio <= 1:
        raise ValueError("invalid backoff configuration")
    delay = min(max_seconds, base_seconds * (2**attempt))
    sample = random.random() if random_value is None else random_value
    if not 0 <= sample <= 1:
        raise ValueError("random_value must be in 0..1")
    return min(max_seconds, max(0.0, delay * (1 + jitter_ratio * (2 * sample - 1))))


def retry_call(
    operation: Callable[[], T],
    *,
    attempts: int = 3,
    retryable: Callable[[Exception], bool] = lambda _exc: True,
    sleep: Callable[[float], None] = time.sleep,
    **backoff_kwargs: float,
) -> T:
    if attempts < 1:
        raise ValueError("attempts must be positive")
    for attempt in range(attempts):
        try:
            return operation()
        except Exception as exc:
            if attempt + 1 == attempts or not retryable(exc):
                raise
            sleep(bounded_backoff(attempt, **backoff_kwargs))
    raise AssertionError("unreachable")
