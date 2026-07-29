from __future__ import annotations


class ProcessingError(Exception):
    """A stable, content-free worker error safe to send to the gateway."""

    def __init__(self, code: str, safe_message: str, *, retryable: bool = False) -> None:
        super().__init__(safe_message)
        self.code = code
        self.safe_message = safe_message
        self.retryable = retryable


class GatewayError(ProcessingError):
    def __init__(
        self,
        code: str,
        safe_message: str,
        *,
        status: int | None = None,
        retryable: bool = False,
    ) -> None:
        super().__init__(code, safe_message, retryable=retryable)
        self.status = status
