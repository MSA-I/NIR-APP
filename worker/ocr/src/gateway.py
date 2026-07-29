from __future__ import annotations

import http.client
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from .errors import GatewayError, ProcessingError


RETRYABLE_STATUS = {429, 500, 502, 503, 504}
CHECKSUM_RE = re.compile(r"^etag:[0-9a-fA-F]{16,128}(?:-[0-9]+)?$")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        del req, fp, code, msg, headers, newurl
        return None


class GatewayClient:
    def __init__(self, supabase_url: str, token: str, *, timeout_seconds: float = 15) -> None:
        self.base = urllib.parse.urlparse(supabase_url.rstrip("/"))
        self.endpoint = supabase_url.rstrip("/") + "/functions/v1/document-processing"
        self.token = token
        self.timeout_seconds = timeout_seconds
        self.opener = urllib.request.build_opener(_NoRedirect())

    def _post(self, payload: dict[str, Any]) -> Any:
        try:
            body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()
        except (TypeError, ValueError) as exc:
            raise GatewayError("invalid_request", "Gateway request is not valid JSON") from exc
        limit = 26 * 1024 * 1024 if payload.get("action") == "complete" else 16 * 1024
        if len(body) > limit:
            raise GatewayError("payload_too_large", "Gateway request exceeds its size limit")
        request = urllib.request.Request(
            self.endpoint,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "x-ocr-worker-token": self.token,
            },
        )
        try:
            with self.opener.open(request, timeout=self.timeout_seconds) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
                status = response.status
        except urllib.error.HTTPError as exc:
            raw = exc.read(64 * 1024)
            status = exc.code
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise GatewayError(
                "gateway_unavailable", "Document gateway is unavailable", retryable=True
            ) from exc
        if len(raw) > 2 * 1024 * 1024:
            raise GatewayError("gateway_response_too_large", "Gateway response is too large")
        try:
            envelope = json.loads(raw.decode("utf-8", "strict"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise GatewayError(
                "gateway_invalid_response",
                "Document gateway returned an invalid response",
                status=status,
                retryable=status in RETRYABLE_STATUS,
            ) from exc
        if type(envelope) is not dict or type(envelope.get("ok")) is not bool:
            raise GatewayError("gateway_invalid_response", "Document gateway returned an invalid response")
        if envelope["ok"] is False:
            error = envelope.get("error")
            code = error.get("code") if type(error) is dict else None
            message = error.get("message") if type(error) is dict else None
            raise GatewayError(
                code if type(code) is str else "gateway_error",
                message if type(message) is str else "Document gateway rejected the request",
                status=status,
                retryable=status in RETRYABLE_STATUS,
            )
        if not 200 <= status < 300 or set(envelope) != {"ok", "data"}:
            raise GatewayError("gateway_invalid_response", "Document gateway returned an invalid response")
        return envelope["data"]

    def claim(self, lease_owner: str, lease_seconds: int) -> dict[str, Any] | None:
        data = self._post(
            {"action": "claim", "lease_owner": lease_owner, "lease_seconds": lease_seconds}
        )
        if data is None:
            return None
        required = {
            "job_id",
            "document_id",
            "mime_type",
            "file_name",
            "input_checksum",
            "contract_version",
            "lease_until",
            "attempt_count",
            "download_url",
            "download_expires_in",
        }
        if type(data) is not dict or set(data) != required:
            raise GatewayError("gateway_invalid_response", "Claim response has an invalid shape")
        try:
            uuid.UUID(data["job_id"])
            uuid.UUID(data["document_id"])
        except (ValueError, TypeError, AttributeError) as exc:
            raise GatewayError("gateway_invalid_response", "Claim response contains an invalid id") from exc
        strings = ("mime_type", "file_name", "lease_until", "download_url")
        if any(type(data[key]) is not str or not data[key] for key in strings):
            raise GatewayError("gateway_invalid_response", "Claim response contains invalid metadata")
        if data["contract_version"] != "1" or type(data["input_checksum"]) is not str or not CHECKSUM_RE.fullmatch(data["input_checksum"]):
            raise GatewayError("gateway_invalid_response", "Claim response contains an invalid contract")
        if type(data["attempt_count"]) is not int or data["attempt_count"] < 1:
            raise GatewayError("gateway_invalid_response", "Claim response contains an invalid attempt")
        if type(data["download_expires_in"]) is not int or not 30 <= data["download_expires_in"] <= 120:
            raise GatewayError("gateway_invalid_response", "Claim response contains an invalid download expiry")
        return data

    def heartbeat(self, job_id: str, lease_owner: str, lease_seconds: int) -> None:
        data = self._post(
            {
                "action": "heartbeat",
                "job_id": job_id,
                "lease_owner": lease_owner,
                "lease_seconds": lease_seconds,
            }
        )
        if type(data) is not dict or set(data) != {"lease_until"} or type(data["lease_until"]) is not str:
            raise GatewayError("gateway_invalid_response", "Heartbeat response has an invalid shape")

    def complete(self, payload: dict[str, Any]) -> str:
        data = self._post({"action": "complete", **payload})
        if type(data) is not dict or set(data) != {"extraction_id"}:
            raise GatewayError("gateway_invalid_response", "Completion response has an invalid shape")
        try:
            uuid.UUID(data["extraction_id"])
        except (ValueError, TypeError, AttributeError) as exc:
            raise GatewayError("gateway_invalid_response", "Completion response contains an invalid id") from exc
        return data["extraction_id"]

    def fail(self, job_id: str, lease_owner: str, error_code: str, error_message: str | None) -> None:
        data = self._post(
            {
                "action": "fail",
                "job_id": job_id,
                "lease_owner": lease_owner,
                "error_code": error_code,
                "error_message": error_message,
            }
        )
        if type(data) is not dict or set(data) != {"job_id"} or data["job_id"] != job_id:
            raise GatewayError("gateway_invalid_response", "Failure response has an invalid shape")

    def download(self, url: str, destination: str | Path, max_bytes: int) -> int:
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != self.base.scheme or parsed.netloc != self.base.netloc or parsed.scheme not in {"http", "https"}:
            raise ProcessingError("download_url_invalid", "Signed download URL has an invalid origin")
        request = urllib.request.Request(url, headers={"Accept-Encoding": "identity"})
        target = Path(destination)
        partial = target.with_name(target.name + ".partial")
        if target.exists():
            raise ProcessingError(
                "download_destination_exists", "Download destination already exists"
            )
        try:
            partial.unlink(missing_ok=True)
            with self.opener.open(request, timeout=self.timeout_seconds) as response:
                length = response.headers.get("Content-Length")
                expected = int(length) if length is not None else None
                if expected is not None and expected > max_bytes:
                    raise ProcessingError("file_size_limit", "Source document exceeds the file size limit")
                total = 0
                with partial.open("xb") as output:
                    while chunk := response.read(64 * 1024):
                        total += len(chunk)
                        if total > max_bytes:
                            raise ProcessingError("file_size_limit", "Source document exceeds the file size limit")
                        output.write(chunk)
            if expected is not None and total != expected:
                raise ProcessingError(
                    "download_incomplete", "Signed source download was incomplete", retryable=True
                )
            if total < 1:
                raise ProcessingError("empty_document", "Source document is empty")
            os.replace(partial, target)
        except ProcessingError:
            raise
        except urllib.error.HTTPError as exc:
            raise ProcessingError(
                "download_failed", "Signed source download failed", retryable=exc.code in RETRYABLE_STATUS
            ) from exc
        except (
            urllib.error.URLError,
            http.client.HTTPException,
            TimeoutError,
            OSError,
            ValueError,
        ) as exc:
            raise ProcessingError("download_failed", "Signed source download failed", retryable=True) from exc
        finally:
            try:
                partial.unlink(missing_ok=True)
            except OSError:
                pass
        return total
