from __future__ import annotations

import base64
import http.client
import json
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from .errors import GatewayError, ProcessingError
from .gateway import RETRYABLE_STATUS, _NoRedirect


SCAN_GATEWAY_CONTRACT_HEADER = "x-document-scan-gateway-contract-version"
SCAN_GATEWAY_CONTRACT_VERSION = "3"
CHECKSUM_PREFIX = "etag:"


class ScanGatewayClient:
    def __init__(self, supabase_url: str, token: str, *, timeout_seconds: float = 15) -> None:
        self.base = urllib.parse.urlparse(supabase_url.rstrip("/"))
        self.endpoint = supabase_url.rstrip("/") + "/functions/v1/document-preprocessing"
        self.token = token
        self.timeout_seconds = timeout_seconds
        self.opener = urllib.request.build_opener(_NoRedirect())

    def _post(self, payload: dict[str, Any]) -> Any:
        try:
            body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()
        except (TypeError, ValueError) as exc:
            raise GatewayError("invalid_request", "Scan gateway request is not valid JSON") from exc
        limit = 15 * 1024 * 1024 if payload.get("action") == "complete" else 16 * 1024
        if len(body) > limit:
            raise GatewayError("payload_too_large", "Scan gateway request exceeds its size limit")
        request = urllib.request.Request(
            self.endpoint,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "x-ocr-worker-token": self.token,
                SCAN_GATEWAY_CONTRACT_HEADER: SCAN_GATEWAY_CONTRACT_VERSION,
            },
        )
        try:
            with self.opener.open(request, timeout=self.timeout_seconds) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
                status = response.status
                contract = response.headers.get(SCAN_GATEWAY_CONTRACT_HEADER)
        except urllib.error.HTTPError as exc:
            raw = exc.read(64 * 1024)
            status = exc.code
            contract = exc.headers.get(SCAN_GATEWAY_CONTRACT_HEADER)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise GatewayError("gateway_unavailable", "Scan gateway is unavailable", retryable=True) from exc
        if contract is not None and contract != SCAN_GATEWAY_CONTRACT_VERSION:
            raise GatewayError("gateway_contract_mismatch", "Worker and scan gateway contracts do not match")
        if len(raw) > 2 * 1024 * 1024:
            raise GatewayError("gateway_response_too_large", "Scan gateway response is too large")
        try:
            envelope = json.loads(raw.decode("utf-8", "strict"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise GatewayError(
                "gateway_invalid_response",
                "Scan gateway returned an invalid response",
                status=status,
                retryable=status in RETRYABLE_STATUS,
            ) from exc
        if type(envelope) is not dict or type(envelope.get("ok")) is not bool:
            raise GatewayError("gateway_invalid_response", "Scan gateway returned an invalid response")
        if envelope["ok"] is False:
            error = envelope.get("error")
            code = error.get("code") if type(error) is dict else None
            message = error.get("message") if type(error) is dict else None
            raise GatewayError(
                code if type(code) is str else "gateway_error",
                message if type(message) is str else "Scan gateway rejected the request",
                status=status,
                retryable=status in RETRYABLE_STATUS,
            )
        if not 200 <= status < 300 or set(envelope) != {"ok", "data"}:
            raise GatewayError("gateway_invalid_response", "Scan gateway returned an invalid response")
        return envelope["data"]

    def claim(self, lease_owner: str, lease_seconds: int) -> dict[str, Any] | None:
        data = self._post({
            "action": "claim",
            "lease_owner": lease_owner,
            "lease_seconds": lease_seconds,
        })
        if data is None:
            return None
        required = {
            "job_id", "document_id", "org_id", "storage_path", "mime_type", "file_name",
            "input_checksum", "requested_mode", "manual_corners", "lease_until", "attempt_count",
            "processing_attempt_id", "processing_attempt_started_at",
            "download_url", "download_expires_in", "download_lease_id", "download_lease_token",
        }
        if type(data) is not dict or set(data) != required:
            raise GatewayError("gateway_invalid_response", "Scan claim response has an invalid shape")
        try:
            uuid.UUID(data["job_id"])
            uuid.UUID(data["document_id"])
            uuid.UUID(data["org_id"])
            uuid.UUID(data["processing_attempt_id"])
            uuid.UUID(data["download_lease_id"])
            uuid.UUID(data["download_lease_token"])
        except (ValueError, TypeError, AttributeError) as exc:
            raise GatewayError("gateway_invalid_response", "Scan claim response contains an invalid id") from exc
        if (
            type(data["mime_type"]) is not str
            or not data["mime_type"].startswith("image/")
            or type(data["input_checksum"]) is not str
            or not data["input_checksum"].startswith(CHECKSUM_PREFIX)
            or data["requested_mode"] not in {"auto", "grayscale", "black_and_white"}
            or not self._valid_corners(data["manual_corners"])
            or type(data["attempt_count"]) is not int
            or data["attempt_count"] < 1
            or type(data["download_url"]) is not str
            or type(data["processing_attempt_started_at"]) is not str
        ):
            raise GatewayError("gateway_invalid_response", "Scan claim response contains invalid metadata")
        return data

    @staticmethod
    def _valid_corners(value: Any) -> bool:
        if value is None:
            return True
        return type(value) is list and len(value) == 4 and all(
            type(point) is list and len(point) == 2 and all(
                type(coordinate) in {int, float} and 0 <= coordinate <= 1 for coordinate in point
            ) for point in value
        )

    def acknowledge_download(
        self, job: dict[str, Any], lease_owner: str, lease_seconds: int
    ) -> None:
        data = self._post({
            "action": "ack_download",
            "job_id": job["job_id"],
            "lease_owner": lease_owner,
            "download_lease_id": job["download_lease_id"],
            "download_lease_token": job["download_lease_token"],
            "lease_seconds": lease_seconds,
        })
        required = {
            "job_id", "org_id", "processing_attempt_id", "egress_lease_id",
            "acknowledged_at", "job_lease_until", "egress_expires_at", "idempotent",
        }
        if (
            type(data) is not dict
            or set(data) != required
            or data["job_id"] != job["job_id"]
            or data["processing_attempt_id"] != job["processing_attempt_id"]
            or data["egress_lease_id"] != job["download_lease_id"]
            or type(data["idempotent"]) is not bool
        ):
            raise GatewayError("gateway_invalid_response", "Scan download acknowledgement has an invalid shape")

    def heartbeat(self, job: dict[str, Any], lease_owner: str, lease_seconds: int) -> None:
        data = self._post({
            "action": "heartbeat",
            "job_id": job["job_id"],
            "lease_owner": lease_owner,
            "download_lease_id": job["download_lease_id"],
            "download_lease_token": job["download_lease_token"],
            "lease_seconds": lease_seconds,
        })
        required = {
            "job_id", "processing_attempt_id", "egress_lease_id", "acknowledged_at",
            "job_lease_until", "egress_expires_at",
        }
        if (
            type(data) is not dict
            or set(data) != required
            or data["job_id"] != job["job_id"]
            or data["processing_attempt_id"] != job["processing_attempt_id"]
            or data["egress_lease_id"] != job["download_lease_id"]
        ):
            raise GatewayError("gateway_invalid_response", "Scan heartbeat response has an invalid shape")

    def complete(
        self,
        job: dict[str, Any],
        lease_owner: str,
        output: Path,
        metadata: dict[str, Any],
    ) -> dict[str, Any]:
        try:
            encoded = base64.b64encode(output.read_bytes()).decode("ascii")
        except OSError as exc:
            raise ProcessingError("scan_output_failed", "Scanned document could not be read") from exc
        data = self._post({
            "action": "complete",
            "job_id": job["job_id"],
            "processing_attempt_id": job["processing_attempt_id"],
            "lease_owner": lease_owner,
            "download_lease_id": job["download_lease_id"],
            "download_lease_token": job["download_lease_token"],
            "input_checksum": job["input_checksum"],
            "output_base64": encoded,
            "metadata": metadata,
        })
        if (
            type(data) is not dict
            or set(data) != {
                "job_id", "output_id", "processing_attempt_id", "egress_lease_id",
                "evidence_sha256", "status", "idempotent",
            }
            or data["job_id"] != job["job_id"]
            or data["processing_attempt_id"] != job["processing_attempt_id"]
            or data["egress_lease_id"] != job["download_lease_id"]
            or data["status"] not in {"ready", "accepted"}
            or type(data["idempotent"]) is not bool
        ):
            raise GatewayError("gateway_invalid_response", "Scan completion response has an invalid shape")
        return data

    def fail(
        self,
        job: dict[str, Any],
        lease_owner: str,
        error_code: str,
        error_message: str | None,
        retryable: bool,
    ) -> dict[str, Any]:
        data = self._post({
            "action": "fail",
            "job_id": job["job_id"],
            "processing_attempt_id": job["processing_attempt_id"],
            "lease_owner": lease_owner,
            "download_lease_id": job["download_lease_id"],
            "download_lease_token": job["download_lease_token"],
            "error_code": error_code,
            "error_message": error_message,
            "retryable": retryable,
        })
        if (
            type(data) is not dict
            or set(data) != {
                "job_id", "processing_attempt_id", "egress_lease_id", "evidence_sha256",
                "status", "retryable", "idempotent",
            }
            or data["job_id"] != job["job_id"]
            or data["processing_attempt_id"] != job["processing_attempt_id"]
            or data["egress_lease_id"] != job["download_lease_id"]
            or type(data["status"]) is not str
            or type(data["retryable"]) is not bool
            or type(data["idempotent"]) is not bool
        ):
            raise GatewayError("gateway_invalid_response", "Scan failure response has an invalid shape")
        return data

    def download(self, url: str, destination: str | Path, max_bytes: int) -> int:
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != self.base.scheme or parsed.netloc != self.base.netloc or parsed.scheme not in {"http", "https"}:
            raise ProcessingError("download_url_invalid", "Signed scan source URL has an invalid origin")
        target = Path(destination)
        partial = target.with_name(target.name + ".partial")
        try:
            partial.unlink(missing_ok=True)
            with self.opener.open(
                urllib.request.Request(url, headers={"Accept-Encoding": "identity"}),
                timeout=self.timeout_seconds,
            ) as response:
                total = 0
                with partial.open("xb") as output:
                    while chunk := response.read(64 * 1024):
                        total += len(chunk)
                        if total > max_bytes:
                            raise ProcessingError("file_size_limit", "Source document exceeds the file size limit")
                        output.write(chunk)
            if total < 1:
                raise ProcessingError("empty_document", "Source document is empty")
            partial.replace(target)
            return total
        except ProcessingError:
            raise
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError) as exc:
            raise ProcessingError("download_failed", "Signed scan source download failed", retryable=True) from exc
        finally:
            partial.unlink(missing_ok=True)
