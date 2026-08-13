from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from pathlib import Path
from typing import Any

from src.errors import GatewayError
from src.scan_gateway import (
    SCAN_GATEWAY_CONTRACT_HEADER,
    SCAN_GATEWAY_CONTRACT_VERSION,
    ScanGatewayClient,
)


JOB_ID = "11111111-1111-4111-8111-111111111111"
DOCUMENT_ID = "22222222-2222-4222-8222-222222222222"
ORG_ID = "33333333-3333-4333-8333-333333333333"
ATTEMPT_ID = "44444444-4444-4444-8444-444444444444"
LEASE_ID = "55555555-5555-4555-8555-555555555555"
LEASE_TOKEN = "66666666-6666-4666-8666-666666666666"


class _Response:
    def __init__(self, data: Any, *, contract: str = SCAN_GATEWAY_CONTRACT_VERSION) -> None:
        self.status = 200
        self.headers = {SCAN_GATEWAY_CONTRACT_HEADER: contract}
        self.body = json.dumps({"ok": True, "data": data}).encode("utf-8")

    def read(self, size: int = -1) -> bytes:
        return self.body if size < 0 else self.body[:size]

    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, *args: Any) -> bool:
        del args
        return False


class _Opener:
    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []

    def open(self, request: Any, timeout: float | None = None) -> _Response:
        del timeout
        payload = json.loads(request.data.decode("utf-8"))
        self.requests.append(payload)
        action = payload["action"]
        if action == "claim":
            return _Response({
                "job_id": JOB_ID,
                "document_id": DOCUMENT_ID,
                "org_id": ORG_ID,
                "storage_path": f"{ORG_ID}/inbox/source.jpg",
                "mime_type": "image/jpeg",
                "file_name": "source.jpg",
                "input_checksum": "etag:0123456789abcdef",
                "requested_mode": "auto",
                "manual_corners": None,
                "lease_until": "2099-01-01T00:02:00Z",
                "attempt_count": 1,
                "processing_attempt_id": ATTEMPT_ID,
                "processing_attempt_started_at": "2099-01-01T00:00:00Z",
                "download_url": "https://example.test/storage/v1/object/sign/documents/source",
                "download_expires_in": 120,
                "download_lease_id": LEASE_ID,
                "download_lease_token": LEASE_TOKEN,
            })
        if action == "ack_download":
            return _Response({
                "job_id": JOB_ID,
                "org_id": ORG_ID,
                "processing_attempt_id": ATTEMPT_ID,
                "egress_lease_id": LEASE_ID,
                "acknowledged_at": "2099-01-01T00:00:01Z",
                "job_lease_until": "2099-01-01T00:02:00Z",
                "egress_expires_at": "2099-01-01T00:02:00Z",
                "idempotent": False,
            })
        if action == "heartbeat":
            return _Response({
                "job_id": JOB_ID,
                "processing_attempt_id": ATTEMPT_ID,
                "egress_lease_id": LEASE_ID,
                "acknowledged_at": "2099-01-01T00:00:01Z",
                "job_lease_until": "2099-01-01T00:03:00Z",
                "egress_expires_at": "2099-01-01T00:03:00Z",
            })
        if action == "complete":
            return _Response({
                "job_id": JOB_ID,
                "output_id": str(uuid.UUID(int=7)),
                "processing_attempt_id": ATTEMPT_ID,
                "egress_lease_id": LEASE_ID,
                "evidence_sha256": "a" * 64,
                "status": "ready",
                "idempotent": False,
            })
        if action == "fail":
            return _Response({
                "job_id": JOB_ID,
                "processing_attempt_id": ATTEMPT_ID,
                "egress_lease_id": LEASE_ID,
                "evidence_sha256": "b" * 64,
                "status": "needs_corners",
                "retryable": False,
                "idempotent": False,
            })
        raise AssertionError(f"unexpected action: {action}")


class ScanGatewayClientTests(unittest.TestCase):
    def test_attempt_and_egress_binding_are_sent_on_every_settlement(self) -> None:
        client = ScanGatewayClient("https://example.test", "x" * 32)
        opener = _Opener()
        client.opener = opener
        job = client.claim("scanner-1", 120)
        self.assertIsNotNone(job)
        assert job is not None

        client.acknowledge_download(job, "scanner-1", 120)
        client.heartbeat(job, "scanner-1", 120)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "scan.png"
            output.write_bytes(b"\x89PNG\r\n\x1a\n")
            client.complete(job, "scanner-1", output, {"schema_version": "1"})
        client.fail(job, "scanner-1", "document_not_detected", None, False)

        by_action = {request["action"]: request for request in opener.requests}
        for action in ("ack_download", "heartbeat", "complete", "fail"):
            self.assertEqual(by_action[action]["download_lease_id"], LEASE_ID)
            self.assertEqual(by_action[action]["download_lease_token"], LEASE_TOKEN)
        self.assertEqual(by_action["complete"]["processing_attempt_id"], ATTEMPT_ID)
        self.assertEqual(by_action["fail"]["processing_attempt_id"], ATTEMPT_ID)

    def test_claim_rejects_a_malformed_attempt_identity(self) -> None:
        client = ScanGatewayClient("https://example.test", "x" * 32)

        class Malformed(_Opener):
            def open(self, request: Any, timeout: float | None = None) -> _Response:
                response = super().open(request, timeout)
                envelope = json.loads(response.body.decode("utf-8"))
                envelope["data"]["processing_attempt_id"] = "not-a-uuid"
                response.body = json.dumps(envelope).encode("utf-8")
                return response

        client.opener = Malformed()
        with self.assertRaisesRegex(GatewayError, "invalid id"):
            client.claim("scanner-1", 120)


if __name__ == "__main__":
    unittest.main()
