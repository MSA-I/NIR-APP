from __future__ import annotations

import json
import logging
import multiprocessing
import os
import platform
import signal
import socket
import sys
import threading
import time
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import cv2

from .errors import GatewayError, ProcessingError
from .gateway import GatewayClient
from .limits import DEFAULT_LIMITS, ExtractionLimits
from .ocr import TesseractOcrAdapter, create_ocr_adapter, openai_model_name
from .parsers import extract_file
from .retry import bounded_backoff, retry_call
from .scan_gateway import ScanGatewayClient
from .scanning import scan_document
from .tempfiles import job_temp_dir


WORKER_VERSION = "2"


def _log(event: str, **fields: Any) -> None:
    logging.info(json.dumps({"event": event, **fields}, separators=(",", ":"), sort_keys=True))


def _integer_env(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError as exc:
        raise ProcessingError("worker_config_invalid", f"{name} must be an integer") from exc
    if not minimum <= value <= maximum:
        raise ProcessingError("worker_config_invalid", f"{name} is outside its allowed range")
    return value


@dataclass(frozen=True, slots=True)
class WorkerConfig:
    supabase_url: str
    token: str
    worker_id: str
    adapter_name: str
    lease_seconds: int
    heartbeat_seconds: int
    poll_seconds: int
    max_backoff_seconds: int
    request_timeout_seconds: int
    job_timeout_seconds: int
    max_memory_mb: int
    max_job_attempts: int
    temp_root: Path
    # Held in the config, never left in the environment: _scrub_credential_env removes it before
    # any subprocess can inherit it, and it reaches the extraction child as an argument instead.
    openai_api_key: str = ""
    max_ai_pages: int = DEFAULT_LIMITS.max_ai_pages

    @classmethod
    def from_env(cls) -> "WorkerConfig":
        forbidden = (
            "SUPABASE_SERVICE_ROLE_KEY",
            "SUPABASE_SERVICE_KEY",
            "SUPABASE_KEY",
            "SUPABASE_ANON_KEY",
        )
        if any(os.environ.get(name) for name in forbidden):
            raise ProcessingError(
                "forbidden_credential",
                "Private worker must not receive a Supabase service or anonymous key",
            )
        url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        token = os.environ.get("OCR_WORKER_TOKEN", "")
        parsed = urlparse(url)
        local_http = parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        if not parsed.netloc or (parsed.scheme != "https" and not local_http):
            raise ProcessingError("worker_config_invalid", "SUPABASE_URL must use HTTPS or local HTTP")
        if len(token) < 32:
            raise ProcessingError("worker_config_invalid", "OCR_WORKER_TOKEN must contain at least 32 characters")
        worker_id = os.environ.get("OCR_WORKER_ID") or f"{socket.gethostname()}-{os.getpid()}"
        if not worker_id.strip() or len(worker_id) > 200:
            raise ProcessingError("worker_config_invalid", "OCR_WORKER_ID is invalid")
        adapter_name = os.environ.get("OCR_ADAPTER", "disabled").strip().lower()
        openai_api_key = os.environ.get("OPENAI_API_KEY", "")
        # Fail fast at startup rather than on the first document: this also validates that a
        # provider-backed adapter actually has a key.
        create_ocr_adapter(adapter_name, openai_api_key)
        lease_seconds = _integer_env("OCR_LEASE_SECONDS", 120, 30, 900)
        heartbeat_seconds = _integer_env("OCR_HEARTBEAT_SECONDS", 30, 5, 450)
        if heartbeat_seconds * 2 > lease_seconds:
            raise ProcessingError("worker_config_invalid", "Heartbeat interval must be at most half the lease")
        temp_root = Path(os.environ.get("OCR_TEMP_ROOT", "/var/tmp/supplyflow-ocr")).resolve()
        return cls(
            url,
            token,
            worker_id,
            adapter_name,
            lease_seconds,
            heartbeat_seconds,
            _integer_env("OCR_POLL_SECONDS", 2, 1, 60),
            _integer_env("OCR_MAX_BACKOFF_SECONDS", 30, 1, 300),
            _integer_env("OCR_REQUEST_TIMEOUT_SECONDS", 15, 1, 120),
            # A scanned packet can contain up to 20 paid OCR pages with 2-3 QA passes each.
            # Page concurrency keeps normal latency low; 900 seconds remains a hard resource
            # ceiling for a slow but healthy provider response.
            _integer_env("OCR_JOB_TIMEOUT_SECONDS", 900, 10, 3_600),
            _integer_env("OCR_MAX_MEMORY_MB", 2_048, 256, 65_536),
            _integer_env("OCR_MAX_JOB_ATTEMPTS", 3, 1, 20),
            temp_root,
            openai_api_key,
            _integer_env("OCR_MAX_AI_PAGES", DEFAULT_LIMITS.max_ai_pages, 1, 100),
        )


def _scrub_credential_env() -> None:
    os.environ.pop("OCR_WORKER_TOKEN", None)
    os.environ.pop("OPENAI_API_KEY", None)
    for name in tuple(os.environ):
        if name.startswith("SUPABASE_"):
            os.environ.pop(name, None)


def _apply_resource_limits(
    job_timeout_seconds: int,
    max_memory_mb: int,
    limits: ExtractionLimits,
) -> None:
    try:
        import resource

        memory = max_memory_mb * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
        resource.setrlimit(resource.RLIMIT_CPU, (job_timeout_seconds, job_timeout_seconds + 5))
        file_size = max(limits.max_decompressed_bytes, limits.max_payload_bytes)
        resource.setrlimit(resource.RLIMIT_FSIZE, (file_size, file_size))
        if hasattr(resource, "RLIMIT_NPROC"):
            resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
    except (ImportError, OSError, ValueError) as exc:
        raise ProcessingError("resource_limit_unavailable", "Runtime resource limits could not be applied") from exc


def _extract_child(
    source: str,
    claimed_mime: str,
    adapter_name: str,
    openai_api_key: str,
    job_timeout_seconds: int,
    max_memory_mb: int,
    limits: ExtractionLimits,
    result_path: str,
) -> None:
    output = Path(result_path)
    temporary = output.with_suffix(".tmp")
    try:
        # The key arrives as an argument, so it lives only in this process's memory. Scrubbing
        # still runs first so LibreOffice, pdftoppm and tesseract inherit no credential at all.
        _scrub_credential_env()
        _apply_resource_limits(job_timeout_seconds, max_memory_mb, limits)
        payload = extract_file(
            source,
            claimed_mime,
            adapter=create_ocr_adapter(adapter_name, openai_api_key),
            limits=limits,
        )
        result: dict[str, Any] = {"ok": True, "payload": payload}
    except ProcessingError as exc:
        result = {
            "ok": False,
            "error": {"code": exc.code, "message": exc.safe_message, "retryable": exc.retryable},
        }
    except BaseException:
        result = {
            "ok": False,
            "error": {
                "code": "worker_internal_error",
                "message": "Document extraction failed unexpectedly",
                "retryable": False,
            },
        }
    try:
        temporary.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        os.replace(temporary, output)
    except OSError:
        os._exit(70)


def _scan_child(
    source: str,
    output_path: str,
    corners: list[list[float]] | None,
    mode: str,
    job_timeout_seconds: int,
    max_memory_mb: int,
    limits: ExtractionLimits,
    result_path: str,
) -> None:
    result_file = Path(result_path)
    temporary = result_file.with_suffix(".tmp")
    try:
        _scrub_credential_env()
        _apply_resource_limits(job_timeout_seconds, max_memory_mb, limits)
        result = scan_document(
            source,
            output_path,
            corners=corners,
            mode=mode,  # type: ignore[arg-type]
            limits=limits,
        )
        payload: dict[str, Any] = {"ok": True, "metadata": result.metadata()}
    except ProcessingError as exc:
        payload = {
            "ok": False,
            "error": {"code": exc.code, "message": exc.safe_message, "retryable": exc.retryable},
        }
    except MemoryError as exc:
        _log("scan_child_resource_failure", exception_type=type(exc).__name__)
        payload = {
            "ok": False,
            "error": {
                "code": "processing_resource_failure",
                "message": "Document scanning exceeded a resource limit",
                "retryable": False,
            },
        }
    except cv2.error as exc:
        if exc.code == cv2.Error.StsNoMem or "Insufficient memory" in str(exc):
            _log("scan_child_resource_failure", exception_type=type(exc).__name__)
            payload = {
                "ok": False,
                "error": {
                    "code": "processing_resource_failure",
                    "message": "Document scanning exceeded a resource limit",
                    "retryable": False,
                },
            }
        else:
            _log("scan_child_internal_error", exception_type=type(exc).__name__)
            payload = {
                "ok": False,
                "error": {
                    "code": "worker_internal_error",
                    "message": "Document scanning failed unexpectedly",
                    "retryable": False,
                },
            }
    except BaseException as exc:
        # The class and phase are operational evidence; document bytes, names and signed URLs
        # never enter the log record.
        _log("scan_child_internal_error", exception_type=type(exc).__name__)
        payload = {
            "ok": False,
            "error": {
                "code": "worker_internal_error",
                "message": "Document scanning failed unexpectedly",
                "retryable": False,
            },
        }
    try:
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        os.replace(temporary, result_file)
    except OSError:
        os._exit(70)


class _WorkerStopping(Exception):
    pass


def _run_extraction(
    source: Path,
    claimed_mime: str,
    config: WorkerConfig,
    workdir: Path,
    stop: threading.Event,
    limits: ExtractionLimits,
) -> dict[str, Any]:
    result_path = workdir / "result.json"
    context = multiprocessing.get_context("spawn")
    _scrub_credential_env()
    process = context.Process(
        target=_extract_child,
        args=(
            str(source),
            claimed_mime,
            config.adapter_name,
            config.openai_api_key,
            config.job_timeout_seconds,
            config.max_memory_mb,
            limits,
            str(result_path),
        ),
        daemon=False,
    )
    process.start()
    deadline = time.monotonic() + config.job_timeout_seconds
    while process.is_alive() and time.monotonic() < deadline and not stop.wait(0.2):
        pass
    if process.is_alive():
        process.terminate()
        process.join(5)
        if process.is_alive() and hasattr(process, "kill"):
            process.kill()
            process.join(5)
        if stop.is_set():
            raise _WorkerStopping()
        # Restarting the whole document discards every completed paid page and repeats the same
        # deterministic wall-clock failure. Provider calls already have their own bounded retry.
        raise ProcessingError("processing_timeout", "Document processing exceeded its time limit")
    process.join()
    if process.exitcode != 0 or not result_path.is_file():
        raise ProcessingError("processing_resource_failure", "Document processing exceeded a resource limit", retryable=True)
    try:
        if result_path.stat().st_size > limits.max_payload_bytes + 4_096:
            raise ProcessingError("extraction_payload_limit", "Extraction payload limit exceeded")
        result = json.loads(result_path.read_text(encoding="utf-8", errors="strict"))
    except ProcessingError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ProcessingError("worker_internal_error", "Document extraction result is invalid") from exc
    if type(result) is not dict or type(result.get("ok")) is not bool:
        raise ProcessingError("worker_internal_error", "Document extraction result is invalid")
    if result["ok"] is False:
        error = result.get("error")
        if type(error) is not dict:
            raise ProcessingError("worker_internal_error", "Document extraction failed unexpectedly")
        raise ProcessingError(
            error.get("code", "worker_internal_error"),
            error.get("message", "Document extraction failed unexpectedly"),
            retryable=error.get("retryable") is True,
        )
    return result["payload"]


def _run_scan(
    source: Path,
    output: Path,
    corners: list[list[float]] | None,
    mode: str,
    config: WorkerConfig,
    workdir: Path,
    stop: threading.Event,
    limits: ExtractionLimits,
) -> dict[str, Any]:
    result_path = workdir / "scan-result.json"
    context = multiprocessing.get_context("spawn")
    _scrub_credential_env()
    process = context.Process(
        target=_scan_child,
        args=(
            str(source),
            str(output),
            corners,
            mode,
            config.job_timeout_seconds,
            config.max_memory_mb,
            limits,
            str(result_path),
        ),
        daemon=False,
    )
    process.start()
    deadline = time.monotonic() + config.job_timeout_seconds
    while process.is_alive() and time.monotonic() < deadline and not stop.wait(0.2):
        pass
    if process.is_alive():
        process.terminate()
        process.join(5)
        if process.is_alive() and hasattr(process, "kill"):
            process.kill()
            process.join(5)
        if stop.is_set():
            raise _WorkerStopping()
        raise ProcessingError("processing_timeout", "Document scanning exceeded its time limit", retryable=True)
    process.join()
    if process.exitcode != 0 or not result_path.is_file():
        raise ProcessingError("processing_resource_failure", "Document scanning exceeded a resource limit", retryable=True)
    try:
        result = json.loads(result_path.read_text(encoding="utf-8", errors="strict"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ProcessingError("worker_internal_error", "Document scanning result is invalid") from exc
    if type(result) is not dict or type(result.get("ok")) is not bool:
        raise ProcessingError("worker_internal_error", "Document scanning result is invalid")
    if result["ok"] is False:
        error = result.get("error")
        if type(error) is not dict:
            raise ProcessingError("worker_internal_error", "Document scanning failed unexpectedly")
        raise ProcessingError(
            error.get("code", "worker_internal_error"),
            error.get("message", "Document scanning failed unexpectedly"),
            retryable=error.get("retryable") is True,
        )
    metadata = result.get("metadata")
    if type(metadata) is not dict or not output.is_file():
        raise ProcessingError("worker_internal_error", "Document scanning result is invalid")
    return metadata


def _gateway_retry(operation):  # type: ignore[no-untyped-def]
    return retry_call(
        operation,
        attempts=3,
        retryable=lambda exc: isinstance(exc, (GatewayError, ProcessingError)) and exc.retryable,
        base_seconds=0.5,
        max_seconds=4.0,
    )


def _pipeline_identity(adapter_name: str) -> tuple[str, str, str]:
    if adapter_name == "disabled":
        return "supplyflow-native", "native-parsers", WORKER_VERSION
    if adapter_name == "tesseract":
        return "supplyflow-native+tesseract", "tesseract-heb+eng", TesseractOcrAdapter.version()
    if adapter_name == "openai":
        # The exact snapshot is only known per response; the alias plus the API surface is what
        # this worker can honestly assert about the whole extraction.
        return "supplyflow-native+openai", openai_model_name(), "v1/responses"
    raise ProcessingError("ocr_adapter_invalid", "Configured OCR adapter is not supported")


def _process_job(
    client: GatewayClient,
    job: dict[str, Any],
    config: WorkerConfig,
    stop: threading.Event,
    limits: ExtractionLimits,
) -> None:
    job_id = job["job_id"]
    heartbeat_done = threading.Event()
    heartbeat_lost = threading.Event()

    def heartbeat() -> None:
        while not heartbeat_done.wait(config.heartbeat_seconds):
            try:
                _gateway_retry(
                    lambda: client.heartbeat(job, config.worker_id, config.lease_seconds)
                )
            except (GatewayError, ProcessingError):
                heartbeat_lost.set()
                return

    thread = threading.Thread(target=heartbeat, name="ocr-heartbeat", daemon=True)
    heartbeat_started = False

    def stop_heartbeat() -> None:
        heartbeat_done.set()
        if heartbeat_started:
            thread.join(timeout=2)

    started = time.monotonic()
    error: ProcessingError | None = None
    try:
        with job_temp_dir(config.temp_root) as workdir:
            source = workdir / "source.bin"
            _gateway_retry(lambda: client.download(job["download_url"], source, limits.max_file_bytes))
            _gateway_retry(
                lambda: client.acknowledge_download(
                    job, config.worker_id, config.lease_seconds
                )
            )
            thread.start()
            heartbeat_started = True
            payload = _run_extraction(source, job["mime_type"], config, workdir, stop, limits)
            if heartbeat_lost.is_set():
                raise GatewayError("lease_lost", "Document processing lease was lost")
            engine, model, model_version = _pipeline_identity(config.adapter_name)
            duration_ms = max(0, round((time.monotonic() - started) * 1_000))
            completion = _gateway_retry(
                lambda: client.complete(
                    job,
                    {
                        "job_id": job_id,
                        "processing_attempt_id": job["processing_attempt_id"],
                        "lease_owner": config.worker_id,
                        "download_lease_id": job["download_lease_id"],
                        "download_lease_token": job["download_lease_token"],
                        "engine": engine,
                        "model": model,
                        "model_version": model_version,
                        "input_checksum": job["input_checksum"],
                        "contract_version": job["contract_version"],
                        "payload": payload,
                        "duration_ms": duration_ms,
                        "resource_metadata": {
                            "worker_version": WORKER_VERSION,
                            "adapter": config.adapter_name,
                            "python": platform.python_version(),
                        },
                    }
                )
            )
            if completion["business_applied"]:
                _log("job_completed", job_id=job_id, duration_ms=duration_ms)
            else:
                _log(
                    "job_evidence_recorded",
                    job_id=job_id,
                    access_mode=completion["access_mode"],
                    duration_ms=duration_ms,
                )
    except _WorkerStopping:
        error = ProcessingError(
            "worker_stopping", "Document processing stopped before completion", retryable=True
        )
    except ProcessingError as exc:
        error = exc
    except BaseException:
        error = ProcessingError("worker_internal_error", "Document processing failed unexpectedly")

    if error is None or heartbeat_lost.is_set() or error.code == "lease_lost":
        stop_heartbeat()
        if error is not None and heartbeat_lost.is_set():
            _log("job_lease_lost", job_id=job_id)
        return
    retryable = error.retryable and job["attempt_count"] < config.max_job_attempts
    try:
        failure = _gateway_retry(
            lambda: client.fail(
                job,
                config.worker_id,
                error.code[:100],
                error.safe_message[:1_000],
                retryable,
            )
        )
        if failure["business_applied"] and failure["job_status"] == "queued":
            _log(
                "job_retry_queued",
                job_id=job_id,
                error_code=error.code,
                attempt=job["attempt_count"],
            )
        elif failure["business_applied"]:
            _log("job_failed", job_id=job_id, error_code=error.code)
        else:
            _log(
                "job_failure_evidence_recorded",
                job_id=job_id,
                error_code=error.code,
                access_mode=failure["access_mode"],
            )
    except (GatewayError, ProcessingError) as fail_error:
        _log("job_fail_report_failed", job_id=job_id, error_code=fail_error.code)
    finally:
        # A downloaded source is an acknowledged external disclosure. Keep renewing both the job
        # lease and its attempt-bound egress lease until the failure receipt is durably settled.
        stop_heartbeat()


def _process_scan_job(
    client: ScanGatewayClient,
    job: dict[str, Any],
    config: WorkerConfig,
    stop: threading.Event,
    limits: ExtractionLimits,
) -> None:
    heartbeat_done = threading.Event()
    heartbeat_lost = threading.Event()

    def heartbeat() -> None:
        while not heartbeat_done.wait(config.heartbeat_seconds):
            try:
                _gateway_retry(
                    lambda: client.heartbeat(job, config.worker_id, config.lease_seconds)
                )
            except (GatewayError, ProcessingError):
                heartbeat_lost.set()
                return

    thread = threading.Thread(target=heartbeat, name="scan-heartbeat", daemon=True)
    heartbeat_started = False

    def stop_heartbeat() -> None:
        heartbeat_done.set()
        if heartbeat_started:
            thread.join(timeout=2)

    started = time.monotonic()
    error: ProcessingError | None = None
    try:
        with job_temp_dir(config.temp_root) as workdir:
            source = workdir / "source.bin"
            output = workdir / "scan.png"
            _gateway_retry(lambda: client.download(job["download_url"], source, limits.max_file_bytes))
            _gateway_retry(
                lambda: client.acknowledge_download(
                    job, config.worker_id, config.lease_seconds
                )
            )
            thread.start()
            heartbeat_started = True
            metadata = _run_scan(
                source,
                output,
                job["manual_corners"],
                job["requested_mode"],
                config,
                workdir,
                stop,
                limits,
            )
            if heartbeat_lost.is_set():
                raise GatewayError("lease_lost", "Document scan lease was lost")
            completed = _gateway_retry(
                lambda: client.complete(job, config.worker_id, output, metadata)
            )
            _log(
                "scan_ready",
                job_id=job["job_id"],
                output_id=completed["output_id"],
                duration_ms=max(0, round((time.monotonic() - started) * 1_000)),
            )
    except _WorkerStopping:
        error = ProcessingError(
            "worker_stopping", "Document scanning stopped before completion", retryable=True
        )
    except ProcessingError as exc:
        error = exc
    except GatewayError as exc:
        error = ProcessingError(exc.code, exc.safe_message, retryable=exc.retryable)
    except BaseException as exc:
        _log("scan_parent_internal_error", exception_type=type(exc).__name__)
        error = ProcessingError("worker_internal_error", "Document scanning failed unexpectedly")

    if error is None or heartbeat_lost.is_set() or error.code == "lease_lost":
        stop_heartbeat()
        if error is not None:
            _log("scan_lease_lost", job_id=job["job_id"])
        return
    retryable = error.retryable and job["attempt_count"] < config.max_job_attempts
    try:
        failed = _gateway_retry(
            lambda: client.fail(
                job,
                config.worker_id,
                error.code[:100],
                error.safe_message[:1_000],
                retryable,
            )
        )
        _log(
            "scan_needs_corners" if failed["status"] == "needs_corners" else "scan_failed",
            job_id=job["job_id"],
            error_code=error.code,
            status=failed["status"],
        )
    except (GatewayError, ProcessingError) as fail_error:
        _log("scan_fail_report_failed", job_id=job["job_id"], error_code=fail_error.code)
    finally:
        stop_heartbeat()


def process_one(
    client: GatewayClient,
    config: WorkerConfig,
    stop: threading.Event | None = None,
    limits: ExtractionLimits = DEFAULT_LIMITS,
) -> bool:
    stop_event = stop or threading.Event()
    job = _gateway_retry(lambda: client.claim(config.worker_id, config.lease_seconds))
    if job is None:
        return False
    _log("job_claimed", job_id=job["job_id"], attempt=job["attempt_count"])
    _process_job(client, job, config, stop_event, limits)
    return True


def process_scan_one(
    client: ScanGatewayClient,
    config: WorkerConfig,
    stop: threading.Event | None = None,
    limits: ExtractionLimits = DEFAULT_LIMITS,
) -> bool:
    stop_event = stop or threading.Event()
    job = _gateway_retry(lambda: client.claim(config.worker_id, config.lease_seconds))
    if job is None:
        return False
    _log("scan_claimed", job_id=job["job_id"], attempt=job["attempt_count"])
    _process_scan_job(client, job, config, stop_event, limits)
    return True


def run(config: WorkerConfig, stop: threading.Event | None = None) -> None:
    stop_event = stop or threading.Event()
    client = GatewayClient(
        config.supabase_url,
        config.token,
        timeout_seconds=config.request_timeout_seconds,
    )
    scan_client = ScanGatewayClient(
        config.supabase_url,
        config.token,
        timeout_seconds=config.request_timeout_seconds,
    )
    limits = replace(DEFAULT_LIMITS, max_ai_pages=config.max_ai_pages)
    failure_count = 0
    _log("worker_started", worker_id=config.worker_id, adapter=config.adapter_name)
    while not stop_event.is_set():
        try:
            scan_processed = process_scan_one(scan_client, config, stop_event, limits)
            ocr_processed = False if stop_event.is_set() else process_one(
                client, config, stop_event, limits
            )
            processed = scan_processed or ocr_processed
            failure_count = 0
            if not processed:
                stop_event.wait(config.poll_seconds)
        except (GatewayError, ProcessingError) as exc:
            delay = bounded_backoff(
                failure_count,
                base_seconds=1,
                max_seconds=config.max_backoff_seconds,
            )
            failure_count = min(failure_count + 1, 20)
            _log("poll_failed", error_code=exc.code, retry_in_seconds=round(delay, 2))
            stop_event.wait(delay)
    _log("worker_stopped", worker_id=config.worker_id)


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    stop = threading.Event()

    def request_stop(signum, frame):  # type: ignore[no-untyped-def]
        del signum, frame
        stop.set()

    signal.signal(signal.SIGINT, request_stop)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, request_stop)
    try:
        config = WorkerConfig.from_env()
        run(config, stop)
        return 0
    except ProcessingError as exc:
        _log("worker_start_failed", error_code=exc.code)
        return 2


if __name__ == "__main__":
    sys.exit(main())
