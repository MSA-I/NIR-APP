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
GATEWAY_CONTRACT_HEADER = "x-ocr-gateway-contract-version"
# 2 -> 3 (#20): the extraction payload gained a REQUIRED `normalizations` array, so a worker
# built before it can no longer produce a payload this gateway accepts. The number moves on BOTH
# sides in the same commit -- `supabase/functions/document-processing/contract.ts` -- because
# moving it on one side leaves a pool that reports `Up`, claims every job and fails
# `gateway_contract_mismatch` on every poll while the screen says "waiting in queue". That is
# a3603c0: five days, zero documents. The VPS is redeployed with this change, not after it.
GATEWAY_CONTRACT_VERSION = "4"
CHECKSUM_RE = re.compile(r"^etag:[0-9a-fA-F]{16,128}(?:-[0-9]+)?$")
EVIDENCE_SHA_RE = re.compile(r"^[0-9a-fA-F]{64}$")


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
                GATEWAY_CONTRACT_HEADER: GATEWAY_CONTRACT_VERSION,
            },
        )
        try:
            with self.opener.open(request, timeout=self.timeout_seconds) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
                status = response.status
                advertised_contract = response.headers.get(GATEWAY_CONTRACT_HEADER)
        except urllib.error.HTTPError as exc:
            raw = exc.read(64 * 1024)
            status = exc.code
            advertised_contract = exc.headers.get(GATEWAY_CONTRACT_HEADER)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise GatewayError(
                "gateway_unavailable", "Document gateway is unavailable", retryable=True
            ) from exc
        if len(raw) > 2 * 1024 * 1024:
            raise GatewayError("gateway_response_too_large", "Gateway response is too large")
        # The old Edge did not advertise a version, so absence remains rollout-compatible while
        # the new worker is deployed first. Once an Edge advertises a contract it must agree.
        if advertised_contract is not None and advertised_contract != GATEWAY_CONTRACT_VERSION:
            raise GatewayError(
                "gateway_contract_mismatch",
                "Worker and document gateway contracts do not match",
                status=status,
            )
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
            "processing_attempt_id",
            "processing_attempt_started_at",
            "document_id",
            "mime_type",
            "file_name",
            "input_checksum",
            "contract_version",
            "lease_until",
            "attempt_count",
            "download_url",
            "download_expires_in",
            "download_lease_id",
            "download_lease_token",
        }
        if type(data) is not dict or set(data) != required:
            raise GatewayError("gateway_invalid_response", "Claim response has an invalid shape")
        try:
            uuid.UUID(data["job_id"])
            uuid.UUID(data["document_id"])
            uuid.UUID(data["processing_attempt_id"])
            uuid.UUID(data["download_lease_id"])
            uuid.UUID(data["download_lease_token"])
        except (ValueError, TypeError, AttributeError) as exc:
            raise GatewayError("gateway_invalid_response", "Claim response contains an invalid id") from exc
        strings = (
            "mime_type",
            "file_name",
            "lease_until",
            "processing_attempt_id",
            "processing_attempt_started_at",
            "download_url",
            "download_lease_id",
            "download_lease_token",
        )
        if any(type(data[key]) is not str or not data[key] for key in strings):
            raise GatewayError("gateway_invalid_response", "Claim response contains invalid metadata")
        if data["contract_version"] != "1" or type(data["input_checksum"]) is not str or not CHECKSUM_RE.fullmatch(data["input_checksum"]):
            raise GatewayError("gateway_invalid_response", "Claim response contains an invalid contract")
        if type(data["attempt_count"]) is not int or data["attempt_count"] < 1:
            raise GatewayError("gateway_invalid_response", "Claim response contains an invalid attempt")
        if type(data["download_expires_in"]) is not int or not 30 <= data["download_expires_in"] <= 120:
            raise GatewayError("gateway_invalid_response", "Claim response contains an invalid download expiry")
        return data

    def acknowledge_download(
        self, job: dict[str, Any], lease_owner: str, lease_seconds: int
    ) -> None:
        data = self._post(
            {
                "action": "ack_download",
                "job_id": job["job_id"],
                "lease_owner": lease_owner,
                "download_lease_id": job["download_lease_id"],
                "download_lease_token": job["download_lease_token"],
                "lease_seconds": lease_seconds,
            }
        )
        required = {
            "job_id", "org_id", "processing_attempt_id", "egress_lease_id",
            "acknowledged_at", "job_lease_until", "egress_expires_at", "idempotent",
        }
        if type(data) is not dict or set(data) != required:
            raise GatewayError(
                "gateway_invalid_response", "Download acknowledgement has an invalid shape"
            )
        try:
            uuid.UUID(data["org_id"])
            uuid.UUID(data["processing_attempt_id"])
            uuid.UUID(data["egress_lease_id"])
        except (ValueError, TypeError, AttributeError) as exc:
            raise GatewayError(
                "gateway_invalid_response", "Download acknowledgement has an invalid id"
            ) from exc
        if (
            data["job_id"] != job["job_id"]
            or data["processing_attempt_id"] != job["processing_attempt_id"]
            or data["egress_lease_id"] != job["download_lease_id"]
            or type(data["idempotent"]) is not bool
            or any(
                type(data[key]) is not str or not data[key]
                for key in ("acknowledged_at", "job_lease_until", "egress_expires_at")
            )
        ):
            raise GatewayError(
                "gateway_invalid_response", "Download acknowledgement binding does not match"
            )

    def heartbeat(
        self,
        job: dict[str, Any],
        lease_owner: str,
        lease_seconds: int,
        progress: tuple[int, int] | None = None,
    ) -> None:
        body: dict[str, Any] = {
            "action": "heartbeat",
            "job_id": job["job_id"],
            "lease_owner": lease_owner,
            "download_lease_id": job["download_lease_id"],
            "download_lease_token": job["download_lease_token"],
            "lease_seconds": lease_seconds,
        }
        # Omitted rather than sent as null when there is nothing to report: the gateway treats an
        # absent pair as "this worker does not report progress", which is what keeps the contract
        # version from moving and lets an older worker keep heartbeating unchanged.
        if progress is not None:
            body["progress_done"], body["progress_total"] = progress
        data = self._post(body)
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
            or any(
                type(data[key]) is not str or not data[key]
                for key in ("acknowledged_at", "job_lease_until", "egress_expires_at")
            )
        ):
            raise GatewayError("gateway_invalid_response", "Heartbeat response has an invalid shape")

    def complete(self, job: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
        data = self._post({"action": "complete", **payload})
        required = {
            "job_id", "processing_attempt_id", "egress_lease_id", "extraction_id",
            "evidence_sha256", "payload_sha256", "business_applied", "access_mode",
            "idempotent",
        }
        if type(data) is not dict or set(data) != required:
            raise GatewayError("gateway_invalid_response", "Completion response has an invalid shape")
        try:
            uuid.UUID(data["processing_attempt_id"])
            uuid.UUID(data["egress_lease_id"])
            if data["extraction_id"] is not None:
                uuid.UUID(data["extraction_id"])
        except (ValueError, TypeError, AttributeError) as exc:
            raise GatewayError("gateway_invalid_response", "Completion response contains an invalid id") from exc
        if (
            data["job_id"] != job["job_id"]
            or data["processing_attempt_id"] != job["processing_attempt_id"]
            or data["egress_lease_id"] != job["download_lease_id"]
            or type(data["evidence_sha256"]) is not str
            or not EVIDENCE_SHA_RE.fullmatch(data["evidence_sha256"])
            or type(data["payload_sha256"]) is not str
            or not EVIDENCE_SHA_RE.fullmatch(data["payload_sha256"])
            or type(data["business_applied"]) is not bool
            or type(data["access_mode"]) is not str
            or not data["access_mode"]
            or type(data["idempotent"]) is not bool
            or (data["business_applied"] and data["extraction_id"] is None)
            or (not data["business_applied"] and data["extraction_id"] is not None)
        ):
            raise GatewayError(
                "gateway_invalid_response", "Completion response binding does not match"
            )
        return data

    def fail(
        self,
        job: dict[str, Any],
        lease_owner: str,
        error_code: str,
        error_message: str | None,
        retryable: bool,
    ) -> dict[str, Any]:
        data = self._post(
            {
                "action": "fail",
                "job_id": job["job_id"],
                "lease_owner": lease_owner,
                "download_lease_id": job["download_lease_id"],
                "download_lease_token": job["download_lease_token"],
                "error_code": error_code,
                "error_message": error_message,
                "retryable": retryable,
            }
        )
        required = {
            "job_id", "processing_attempt_id", "egress_lease_id", "evidence_sha256",
            "job_status", "retryable", "business_applied", "access_mode", "idempotent",
        }
        if type(data) is not dict or set(data) != required:
            raise GatewayError("gateway_invalid_response", "Failure response has an invalid shape")
        try:
            uuid.UUID(data["processing_attempt_id"])
            uuid.UUID(data["egress_lease_id"])
        except (ValueError, TypeError, AttributeError) as exc:
            raise GatewayError("gateway_invalid_response", "Failure response contains an invalid id") from exc
        if (
            data["job_id"] != job["job_id"]
            or data["processing_attempt_id"] != job["processing_attempt_id"]
            or data["egress_lease_id"] != job["download_lease_id"]
            or type(data["evidence_sha256"]) is not str
            or not EVIDENCE_SHA_RE.fullmatch(data["evidence_sha256"])
            or type(data["job_status"]) is not str
            or not data["job_status"]
            or data["retryable"] is not retryable
            or type(data["business_applied"]) is not bool
            or type(data["access_mode"]) is not str
            or not data["access_mode"]
            or type(data["idempotent"]) is not bool
        ):
            raise GatewayError(
                "gateway_invalid_response", "Failure response binding does not match"
            )
        return data

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
