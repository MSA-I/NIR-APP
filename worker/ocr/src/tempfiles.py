from __future__ import annotations

import shutil
import sys
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from .errors import ProcessingError


@contextmanager
def job_temp_dir(root: str | Path | None = None) -> Iterator[Path]:
    base = Path(root).resolve() if root is not None else None
    if base is not None:
        base.mkdir(parents=True, exist_ok=True)
    path = Path(tempfile.mkdtemp(prefix="job-", dir=base)).resolve()
    if base is not None and base not in path.parents:
        raise ProcessingError("temp_directory_invalid", "Temporary directory escaped its root")
    try:
        yield path
    finally:
        active_error = sys.exc_info()[0] is not None
        try:
            shutil.rmtree(path)
        except OSError as exc:
            if not active_error:
                raise ProcessingError(
                    "temp_cleanup_failed", "Temporary files could not be removed"
                ) from exc
