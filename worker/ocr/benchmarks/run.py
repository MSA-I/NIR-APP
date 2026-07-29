#!/usr/bin/env python3
"""Run and score the private OCR benchmark without storing corpus data in Git."""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REQUIRED_ENGINES = {"unlimited-ocr", "qwen3-vl-8b", "tesseract-heb-eng"}
REQUIRED_MODELS = {
    "unlimited-ocr": "baidu/Unlimited-OCR",
    "qwen3-vl-8b": "Qwen/Qwen3-VL-8B-Instruct",
    "tesseract-heb-eng": "tesseract heb+eng",
}
REQUIRED_DOCUMENT_TYPES = {"invoice", "delivery_note", "credit_note", "price_list"}
ALLOWED_DOCUMENT_TYPES = REQUIRED_DOCUMENT_TYPES | {
    "quote",
    "payment_confirmation",
    "other",
}
REQUIRED_MARK_KINDS = {"circle", "check", "cross", "underline", "star"}
CANONICAL_MAX_THRESHOLDS = {
    "clean_printed_cer_max": 0.05,
    "scan_photo_cer_max": 0.10,
    "p95_seconds_per_page_max": 10.0,
}
CANONICAL_MIN_THRESHOLDS = {
    "table_cell_f1_min": 0.90,
    "document_type_macro_f1_min": 0.95,
    "supplier_match_precision_min": 0.95,
    "mark_precision_min": 0.95,
    "mark_recall_min": 0.85,
    "soak_hours_min": 2.0,
}
MAX_ADAPTER_OUTPUT_BYTES = 26 * 1024 * 1024
MAX_ADAPTER_STDERR_BYTES = 64 * 1024
SHA40 = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
IMAGE_DIGEST = re.compile(r"^[^\s@]+@sha256:[0-9a-f]{64}$")
HEBREW = re.compile(r"[\u0590-\u05ff]")
ENGLISH_ASCII = re.compile(r"[A-Za-z]")
DIGIT = re.compile(r"[0-9]")


class BenchmarkError(RuntimeError):
    pass


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise BenchmarkError(f"invalid_json:{path.name}") from exc
    if not isinstance(value, dict):
        raise BenchmarkError(f"json_object_required:{path.name}")
    return value


def _resolve_inside(root: Path, relative: str) -> Path:
    if not relative or Path(relative).is_absolute():
        raise BenchmarkError("corpus_paths_must_be_relative")
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as exc:
        raise BenchmarkError("corpus_path_escape") from exc
    return candidate


def _result_path(manifest_path: Path, value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else (manifest_path.parent / path).resolve()


def _real_sha256(value: Any) -> bool:
    text = str(value)
    return bool(SHA256.fullmatch(text)) and text != "0" * 64


def _validate_thresholds(value: Any) -> dict[str, float]:
    required = set(CANONICAL_MAX_THRESHOLDS) | set(CANONICAL_MIN_THRESHOLDS)
    if not isinstance(value, dict) or set(value) != required:
        raise BenchmarkError("mandatory_thresholds_invalid")
    thresholds: dict[str, float] = {}
    for key, raw in value.items():
        if type(raw) not in (int, float) or not math.isfinite(raw):
            raise BenchmarkError("mandatory_thresholds_must_be_finite_numbers")
        thresholds[key] = float(raw)
    if any(thresholds[key] > limit for key, limit in CANONICAL_MAX_THRESHOLDS.items()):
        raise BenchmarkError("mandatory_max_threshold_weakened")
    if any(thresholds[key] < limit for key, limit in CANONICAL_MIN_THRESHOLDS.items()):
        raise BenchmarkError("mandatory_min_threshold_weakened")
    return thresholds


def _load_manifest(path: Path, *, require_command: bool, require_files: bool) -> dict[str, Any]:
    manifest = _load_json(path)
    if manifest.get("schema_version") != "1" or manifest.get("contract_version") != "1":
        raise BenchmarkError("unsupported_manifest_or_contract_version")

    corpus = manifest.get("corpus")
    if not isinstance(corpus, dict) or corpus.get("licensed_or_anonymized") is not True:
        raise BenchmarkError("corpus_license_or_anonymization_not_confirmed")
    if int(corpus.get("minimum_documents", 0)) < 200:
        raise BenchmarkError("minimum_documents_below_200")
    if int(corpus.get("minimum_mark_documents", 0)) < 40:
        raise BenchmarkError("minimum_mark_documents_below_40")
    root = Path(str(corpus.get("root", "")))
    if not root.is_absolute():
        raise BenchmarkError("corpus_root_must_be_absolute")
    if require_files and not root.is_dir():
        raise BenchmarkError("corpus_root_missing")

    hardware = manifest.get("target_hardware")
    if not isinstance(hardware, dict) or int(hardware.get("minimum_vram_mib", 0)) < 24000:
        raise BenchmarkError("target_must_be_24gb_nvidia")

    engines = manifest.get("engines")
    if not isinstance(engines, list) or len(engines) != 3 or {item.get("id") for item in engines if isinstance(item, dict)} != REQUIRED_ENGINES:
        raise BenchmarkError("exactly_three_required_engines_expected")
    for engine in engines:
        engine_id = str(engine["id"])
        if engine.get("model") != REQUIRED_MODELS[engine_id]:
            raise BenchmarkError(f"unexpected_model:{engine_id}")
        revision = str(engine.get("revision", ""))
        if engine_id in {"unlimited-ocr", "qwen3-vl-8b"} and not SHA40.fullmatch(revision):
            raise BenchmarkError(f"unpinned_revision:{engine_id}")
        artifacts = engine.get("artifact_sha256", [])
        if not isinstance(artifacts, list) or not artifacts or any(
            not _real_sha256(value) for value in artifacts
        ):
            raise BenchmarkError(f"invalid_artifact_hash:{engine_id}")
        if engine_id == "tesseract-heb-eng" and len(artifacts) < 2:
            raise BenchmarkError("tesseract_language_hashes_required")
        image = str(engine.get("image", ""))
        if not IMAGE_DIGEST.fullmatch(image) or image.endswith("0" * 64):
            raise BenchmarkError(f"pinned_container_image_required:{engine_id}")
        if not 1 <= int(engine.get("timeout_seconds", 0)) <= 3_600:
            raise BenchmarkError(f"timeout_required:{engine_id}")
        command = engine.get("command")
        if require_command and (not isinstance(command, list) or not command or any(not isinstance(part, str) or not part for part in command)):
            raise BenchmarkError(f"adapter_command_required:{engine_id}")
        if engine.get("soak_memory_review") not in {"pending", "pass", "fail"}:
            raise BenchmarkError(f"invalid_soak_memory_review:{engine_id}")

    manifest["thresholds"] = _validate_thresholds(manifest.get("thresholds"))

    documents = manifest.get("documents")
    if not isinstance(documents, list) or len(documents) < int(corpus["minimum_documents"]):
        raise BenchmarkError("corpus_too_small")
    ids: set[str] = set()
    mark_count = 0
    mark_kinds: set[str] = set()
    profiles: set[str] = set()
    document_types: set[str] = set()
    has_english_ascii = False
    has_digit = False
    has_handwriting = False
    for item in documents:
        if not isinstance(item, dict):
            raise BenchmarkError("document_entry_must_be_object")
        document_id = str(item.get("id", ""))
        if not document_id or document_id in ids:
            raise BenchmarkError("document_ids_must_be_unique")
        ids.add(document_id)
        profile = str(item.get("profile", ""))
        if profile not in {"clean_printed", "scan_photo"}:
            raise BenchmarkError(f"invalid_profile:{document_id}")
        profiles.add(profile)
        if not isinstance(item.get("claimed_mime"), str) or not item["claimed_mime"]:
            raise BenchmarkError(f"claimed_mime_required:{document_id}")
        source = _resolve_inside(root, str(item.get("source", "")))
        truth = _resolve_inside(root, str(item.get("ground_truth", "")))
        if require_files and (not source.is_file() or not truth.is_file()):
            raise BenchmarkError(f"corpus_file_missing:{document_id}")
        if require_files:
            ground = _load_json(truth)
            extraction = _validate_contract(ground.get("extraction"))
            plain_text = extraction["document"]["plain_text"]
            if not HEBREW.search(plain_text):
                raise BenchmarkError(f"hebrew_ground_truth_required:{document_id}")
            has_english_ascii = has_english_ascii or bool(ENGLISH_ASCII.search(plain_text))
            has_digit = has_digit or bool(DIGIT.search(plain_text))
            has_handwriting = has_handwriting or any(
                block["type"] == "handwriting" for block in extraction["blocks"]
            )
            document_type = ground.get("document_type")
            if document_type not in ALLOWED_DOCUMENT_TYPES:
                raise BenchmarkError(f"invalid_document_type:{document_id}")
            document_types.add(document_type)
            marks = extraction["marks"]
            if marks:
                mark_count += 1
                mark_kinds.update(mark["kind"] for mark in marks)
            if "has_marks" in item and item["has_marks"] is not bool(marks):
                raise BenchmarkError(f"mark_manifest_mismatch:{document_id}")
    if profiles != {"clean_printed", "scan_photo"}:
        raise BenchmarkError("both_accuracy_profiles_required")
    if mark_count < int(corpus["minimum_mark_documents"]):
        raise BenchmarkError("mark_corpus_too_small")
    if require_files and not REQUIRED_DOCUMENT_TYPES.issubset(document_types):
        raise BenchmarkError("required_document_types_missing")
    if require_files and not REQUIRED_MARK_KINDS.issubset(mark_kinds):
        raise BenchmarkError("required_mark_kinds_missing")
    if require_files and not has_english_ascii:
        raise BenchmarkError("english_ascii_ground_truth_missing")
    if require_files and not has_digit:
        raise BenchmarkError("digit_ground_truth_missing")
    if require_files and not has_handwriting:
        raise BenchmarkError("handwriting_ground_truth_missing")
    return manifest


def _query_hardware(gpu_index: int) -> dict[str, Any]:
    command = [
        "nvidia-smi",
        "--query-gpu=index,name,uuid,driver_version,memory.total,compute_cap",
        "--format=csv,noheader,nounits",
    ]
    try:
        query = subprocess.run(command, check=True, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError) as exc:
        raise BenchmarkError("nvidia_smi_unavailable") from exc
    rows = list(csv.reader(query.stdout.splitlines()))
    selected = next((row for row in rows if row and int(row[0].strip()) == gpu_index), None)
    if selected is None or len(selected) != 6:
        raise BenchmarkError("target_gpu_missing")
    try:
        summary = subprocess.run(["nvidia-smi"], check=True, capture_output=True, text=True, timeout=10).stdout
    except subprocess.SubprocessError as exc:
        raise BenchmarkError("nvidia_smi_summary_failed") from exc
    cuda = re.search(r"CUDA Version:\s*([0-9.]+)", summary)
    return {
        "gpu_index": gpu_index,
        "name": selected[1].strip(),
        "uuid": selected[2].strip(),
        "driver_version": selected[3].strip(),
        "total_vram_mib": int(float(selected[4].strip())),
        "compute_capability": selected[5].strip(),
        "cuda_version": cuda.group(1) if cuda else None,
    }


def _require_target_hardware(manifest: dict[str, Any]) -> dict[str, Any]:
    target = manifest["target_hardware"]
    hardware = _query_hardware(int(target.get("gpu_index", 0)))
    if hardware["total_vram_mib"] < int(target["minimum_vram_mib"]):
        raise BenchmarkError("target_gpu_vram_below_24gb")
    return hardware


def _gpu_used_mib(gpu_index: int) -> int | None:
    try:
        result = subprocess.run(
            ["nvidia-smi", "-i", str(gpu_index), "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
        return int(float(result.stdout.strip().splitlines()[0]))
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return None


def _safe_docker_env() -> dict[str, str]:
    allowed = {
        "PATH",
        "SYSTEMROOT",
        "WINDIR",
        "TEMP",
        "TMP",
    }
    return {key: value for key, value in os.environ.items() if key.upper() in allowed}


def _terminate(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def _bounded_process(
    command: list[str], request: bytes, timeout_seconds: int
) -> tuple[int, bytes, bytes, str | None]:
    process = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=_safe_docker_env(),
    )
    stdout: list[bytes] = []
    stderr: list[bytes] = []
    overflow = threading.Event()

    def capture(stream: Any, chunks: list[bytes], limit: int) -> None:
        total = 0
        while data := stream.read(64 * 1024):
            remaining = limit - total
            if len(data) > remaining:
                if remaining > 0:
                    chunks.append(data[:remaining])
                overflow.set()
                return
            chunks.append(data)
            total += len(data)

    readers = [
        threading.Thread(target=capture, args=(process.stdout, stdout, MAX_ADAPTER_OUTPUT_BYTES), daemon=True),
        threading.Thread(target=capture, args=(process.stderr, stderr, MAX_ADAPTER_STDERR_BYTES), daemon=True),
    ]
    for reader in readers:
        reader.start()
    try:
        assert process.stdin is not None
        try:
            process.stdin.write(request)
            process.stdin.close()
        except (BrokenPipeError, OSError):
            pass
        deadline = time.monotonic() + timeout_seconds
        failure = None
        while process.poll() is None:
            if overflow.is_set():
                failure = "adapter_output_too_large"
                break
            if time.monotonic() >= deadline:
                failure = "timeout"
                break
            time.sleep(0.05)
        if failure is not None:
            _terminate(process)
        else:
            process.wait()
    finally:
        _terminate(process)
        for reader in readers:
            reader.join(timeout=5)
    if overflow.is_set():
        failure = "adapter_output_too_large"
    return process.returncode, b"".join(stdout), b"".join(stderr), failure


def _sandbox_command(
    engine: dict[str, Any], source: Path, gpu_index: int, container_name: str
) -> list[str]:
    return [
        "docker",
        "run",
        "--rm",
        "--pull=never",
        "--name",
        container_name,
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=256",
        "--memory=64g",
        "--memory-swap=64g",
        "--cpus=16",
        "--ulimit=nofile=1024:1024",
        "--ulimit=core=0:0",
        f"--gpus=device={gpu_index}",
        "--user=10001:10001",
        "--shm-size=1g",
        "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=8g,mode=0700,uid=10001,gid=10001",
        "--mount",
        f"type=bind,source={source},target=/input/source,readonly",
        "--env=HOME=/tmp",
        "--env=TMPDIR=/tmp",
        "--env=PYTHONDONTWRITEBYTECODE=1",
        "--env=HF_HUB_OFFLINE=1",
        "--env=TRANSFORMERS_OFFLINE=1",
        "--env=CUDA_VISIBLE_DEVICES=0",
        engine["image"],
        *engine["command"],
    ]


def _remove_container(container_name: str) -> None:
    try:
        subprocess.run(
            ["docker", "rm", "--force", container_name],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=15,
            env=_safe_docker_env(),
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        pass


def _validate_contract(payload: Any) -> dict[str, Any]:
    worker_root = Path(__file__).resolve().parents[1]
    if str(worker_root) not in sys.path:
        sys.path.insert(0, str(worker_root))
    try:
        from src import validate_extraction

        return validate_extraction(payload)
    except ImportError as exc:
        raise BenchmarkError("worker_public_api_unavailable") from exc


def _run_adapter(
    engine: dict[str, Any],
    document: dict[str, Any],
    corpus_root: Path,
    hardware: dict[str, Any],
) -> dict[str, Any]:
    source = _resolve_inside(corpus_root, document["source"])
    request = {
        "source": "/input/source",
        "claimed_mime": document["claimed_mime"],
        "contract_version": "1",
        "model": engine["model"],
        "revision": engine["revision"],
    }
    stop = threading.Event()
    samples: list[int] = []

    def sample_gpu() -> None:
        while not stop.is_set():
            used = _gpu_used_mib(hardware["gpu_index"])
            if used is not None:
                samples.append(used)
            stop.wait(0.1)

    sampler = threading.Thread(target=sample_gpu, daemon=True)
    sampler.start()
    started = time.perf_counter()
    container_name = f"supplyflow-ocr-benchmark-{uuid.uuid4().hex}"
    try:
        with tempfile.TemporaryDirectory(prefix="supplyflow-ocr-benchmark-") as temporary:
            mounted_source = Path(temporary) / "source"
            shutil.copyfile(source, mounted_source)
            if os.name != "nt":
                mounted_source.chmod(0o444)
            command = _sandbox_command(engine, mounted_source.resolve(), hardware["gpu_index"], container_name)
            returncode, stdout, stderr, failure = _bounded_process(
                command,
                json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
                int(engine["timeout_seconds"]),
            )
        elapsed_ms = (time.perf_counter() - started) * 1000
    except OSError:
        return {"status": "failed", "error_code": "adapter_start_failed", "elapsed_ms": (time.perf_counter() - started) * 1000}
    finally:
        _remove_container(container_name)
        stop.set()
        sampler.join(timeout=2)

    peak = max(samples) if samples else None
    if failure is not None:
        return {"status": "failed", "error_code": failure, "elapsed_ms": elapsed_ms, "peak_gpu_used_mib": peak}
    if returncode != 0:
        lowered = stderr.lower()
        code = "oom" if b"out of memory" in lowered or b"cuda oom" in lowered else "adapter_exit"
        return {"status": "failed", "error_code": code, "elapsed_ms": elapsed_ms, "peak_gpu_used_mib": peak}
    try:
        response = json.loads(stdout.decode("utf-8", "strict"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {"status": "failed", "error_code": "adapter_invalid_json", "elapsed_ms": elapsed_ms, "peak_gpu_used_mib": peak}
    if not isinstance(response, dict) or response.get("revision") != engine["revision"]:
        return {"status": "failed", "error_code": "model_revision_mismatch", "elapsed_ms": elapsed_ms, "peak_gpu_used_mib": peak}
    response_artifacts = response.get("artifact_sha256")
    if not isinstance(response_artifacts, list) or sorted(response_artifacts) != sorted(engine["artifact_sha256"]):
        return {"status": "failed", "error_code": "model_artifact_mismatch", "elapsed_ms": elapsed_ms, "peak_gpu_used_mib": peak}
    try:
        extraction = _validate_contract(response.get("extraction"))
    except Exception:
        return {"status": "failed", "error_code": "contract_validation_failed", "elapsed_ms": elapsed_ms, "peak_gpu_used_mib": peak}
    interpretation = response.get("interpretation")
    if interpretation is not None and not isinstance(interpretation, dict):
        return {"status": "failed", "error_code": "interpretation_metadata_invalid", "elapsed_ms": elapsed_ms, "peak_gpu_used_mib": peak}
    return {
        "status": "ok",
        "elapsed_ms": elapsed_ms,
        "peak_gpu_used_mib": peak,
        "artifact_sha256": response.get("artifact_sha256", []),
        "extraction": extraction,
        "interpretation": interpretation or {},
    }


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    if path.exists():
        raise BenchmarkError(f"output_exists:{path.name}")
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(path.name + ".partial")
    if partial.exists():
        raise BenchmarkError(f"partial_output_exists:{partial.name}")
    partial.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    partial.replace(path)


def _execute(manifest_path: Path, engine_id: str, phase: str, output: Path, duration_seconds: int | None) -> None:
    manifest = _load_manifest(manifest_path, require_command=True, require_files=True)
    hardware = _require_target_hardware(manifest)
    engine = next(item for item in manifest["engines"] if item["id"] == engine_id)
    if phase == "soak" and (duration_seconds is None or duration_seconds < 7200):
        raise BenchmarkError("soak_requires_at_least_7200_seconds")
    if phase == "accuracy" and duration_seconds is not None:
        raise BenchmarkError("duration_only_valid_for_soak")
    if output.exists():
        raise BenchmarkError(f"output_exists:{output.name}")
    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_name(output.name + ".partial")
    if partial.exists():
        raise BenchmarkError(f"partial_output_exists:{partial.name}")

    header = {
        "record_type": "run",
        "schema_version": "1",
        "phase": phase,
        "engine_id": engine_id,
        "model": engine["model"],
        "revision": engine["revision"],
        "hardware": hardware,
        "started_at": _utc_now(),
    }
    started = time.monotonic()
    timings: list[float] = []
    peaks: list[int] = []
    failures = Counter()
    total = 0
    cycles = 0
    corpus_root = Path(manifest["corpus"]["root"])
    with partial.open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(header, ensure_ascii=False) + "\n")
        while True:
            for document in manifest["documents"]:
                if phase == "soak" and cycles > 0 and time.monotonic() - started >= int(duration_seconds):
                    break
                result = _run_adapter(engine, document, corpus_root, hardware)
                total += 1
                timings.append(float(result["elapsed_ms"]))
                if result.get("peak_gpu_used_mib") is not None:
                    peaks.append(int(result["peak_gpu_used_mib"]))
                if result["status"] != "ok":
                    failures[result["error_code"]] += 1
                record = {"record_type": "document", "document_id": document["id"], "cycle": cycles + 1, **result}
                if phase == "soak":
                    record.pop("extraction", None)
                    record.pop("interpretation", None)
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
                handle.flush()
            cycles += 1
            if phase == "accuracy" or time.monotonic() - started >= int(duration_seconds):
                break
        elapsed = time.monotonic() - started
        quarter = max(1, len(peaks) // 4)
        growth = None if not peaks else statistics.median(peaks[-quarter:]) - statistics.median(peaks[:quarter])
        footer = {
            "record_type": "summary",
            "finished_at": _utc_now(),
            "elapsed_seconds": elapsed,
            "cycles": cycles,
            "total_runs": total,
            "failure_count": sum(failures.values()),
            "failure_codes": dict(failures),
            "peak_gpu_used_mib": max(peaks) if peaks else None,
            "gpu_memory_growth_mib": growth,
        }
        handle.write(json.dumps(footer, ensure_ascii=False) + "\n")
    partial.replace(output)


def _normalize_text(value: str) -> str:
    return " ".join(unicodedata.normalize("NFC", value).split())


def _edit_distance(pattern: str, text: str) -> int:
    if len(pattern) > len(text):
        pattern, text = text, pattern
    if not pattern:
        return len(text)
    masks: dict[str, int] = {}
    for index, char in enumerate(pattern):
        masks[char] = masks.get(char, 0) | (1 << index)
    positive = ~0
    negative = 0
    score = len(pattern)
    last = 1 << (len(pattern) - 1)
    for char in text:
        equal = masks.get(char, 0)
        xv = equal | negative
        xh = (((equal & positive) + positive) ^ positive) | equal
        ph = negative | ~(xh | positive)
        mh = positive & xh
        if ph & last:
            score += 1
        elif mh & last:
            score -= 1
        ph = (ph << 1) | 1
        mh <<= 1
        positive = mh | ~(xv | ph)
        negative = ph & xv
    return score


def _percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def _table_cells(payload: dict[str, Any]) -> dict[tuple[int, int, int], str]:
    cells: dict[tuple[int, int, int], str] = {}
    tables = sorted(payload.get("tables", []), key=lambda table: (table["page"], table["bbox"]))
    for table_index, table in enumerate(tables):
        for row_index, row in enumerate(table["rows"]):
            for column_index, cell in enumerate(row):
                cells[(table_index, row_index, column_index)] = _normalize_text(cell["text"])
    return cells


def _cell_counts(predicted: dict[str, Any], truth: dict[str, Any]) -> tuple[int, int, int]:
    pred = _table_cells(predicted)
    expected = _table_cells(truth)
    true_positive = false_positive = false_negative = 0
    for key in pred.keys() | expected.keys():
        if key in pred and key in expected and pred[key] == expected[key]:
            true_positive += 1
        else:
            false_positive += int(key in pred)
            false_negative += int(key in expected)
    return true_positive, false_positive, false_negative


def _iou(first: list[float], second: list[float]) -> float:
    x1, y1 = max(first[0], second[0]), max(first[1], second[1])
    x2, y2 = min(first[2], second[2]), min(first[3], second[3])
    intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    first_area = max(0.0, first[2] - first[0]) * max(0.0, first[3] - first[1])
    second_area = max(0.0, second[2] - second[0]) * max(0.0, second[3] - second[1])
    union = first_area + second_area - intersection
    return intersection / union if union else 0.0


def _mark_counts(predicted: dict[str, Any], truth: dict[str, Any]) -> tuple[int, int, int]:
    candidates = list(predicted.get("marks", []))
    matched: set[int] = set()
    true_positive = 0
    for expected in truth.get("marks", []):
        best = None
        best_iou = 0.0
        for index, candidate in enumerate(candidates):
            if index in matched or candidate["page"] != expected["page"] or candidate["kind"] != expected["kind"]:
                continue
            overlap = _iou(candidate["bbox"], expected["bbox"])
            if overlap >= 0.5 and overlap > best_iou:
                best, best_iou = index, overlap
        if best is not None:
            matched.add(best)
            true_positive += 1
    return true_positive, len(candidates) - true_positive, len(truth.get("marks", [])) - true_positive


def _ratio(tp: int, fp: int, fn: int) -> tuple[float | None, float | None, float | None]:
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / (tp + fn) if tp + fn else None
    f1 = 2 * precision * recall / (precision + recall) if precision is not None and recall is not None and precision + recall else None
    return precision, recall, f1


def _macro_f1(expected: list[str], predicted: list[str | None]) -> float | None:
    labels = set(expected) | {value for value in predicted if value is not None}
    if not labels:
        return None
    scores = []
    for label in labels:
        tp = sum(want == label and got == label for want, got in zip(expected, predicted))
        fp = sum(want != label and got == label for want, got in zip(expected, predicted))
        fn = sum(want == label and got != label for want, got in zip(expected, predicted))
        _, _, f1 = _ratio(tp, fp, fn)
        scores.append(f1 or 0.0)
    return sum(scores) / len(scores)


def _load_run(path: Path, engine: dict[str, Any], phase: str) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    try:
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
    except (OSError, json.JSONDecodeError) as exc:
        raise BenchmarkError(f"invalid_run_file:{engine['id']}:{phase}") from exc
    if len(rows) < 2 or rows[0].get("record_type") != "run" or rows[-1].get("record_type") != "summary":
        raise BenchmarkError(f"incomplete_run_file:{engine['id']}:{phase}")
    header, footer = rows[0], rows[-1]
    if header.get("engine_id") != engine["id"] or header.get("phase") != phase or header.get("revision") != engine["revision"]:
        raise BenchmarkError(f"run_metadata_mismatch:{engine['id']}:{phase}")
    return header, [row for row in rows[1:-1] if row.get("record_type") == "document"], footer


def _score_engine(manifest_path: Path, manifest: dict[str, Any], engine: dict[str, Any]) -> dict[str, Any]:
    accuracy_path = _result_path(manifest_path, engine["accuracy_results"])
    soak_path = _result_path(manifest_path, engine["soak_results"])
    if not accuracy_path.is_file() or not soak_path.is_file():
        return {"engine_id": engine["id"], "evidence_complete": False, "pending": ["accuracy_or_soak_results_missing"]}
    accuracy_header, records, accuracy_footer = _load_run(accuracy_path, engine, "accuracy")
    _, _, soak_footer = _load_run(soak_path, engine, "soak")
    target_vram = int(manifest["target_hardware"]["minimum_vram_mib"])
    hardware = accuracy_header.get("hardware", {})
    hardware_pass = int(hardware.get("total_vram_mib", 0)) >= target_vram
    by_id = {row.get("document_id"): row for row in records}
    if len(by_id) != len(records):
        raise BenchmarkError(f"duplicate_accuracy_result:{engine['id']}")

    corpus_root = Path(manifest["corpus"]["root"])
    edit_totals = {"clean_printed": [0, 0], "scan_photo": [0, 0]}
    cell_tp = cell_fp = cell_fn = 0
    mark_tp = mark_fp = mark_fn = 0
    type_expected: list[str] = []
    type_predicted: list[str | None] = []
    supplier_tp = supplier_fp = supplier_truth = 0
    seconds_per_page: list[float] = []
    failures = Counter()
    peaks: list[int] = []

    for document in manifest["documents"]:
        record = by_id.get(document["id"])
        if not record or record.get("status") != "ok":
            failures[(record or {}).get("error_code", "missing_result")] += 1
            continue
        try:
            predicted = _validate_contract(record.get("extraction"))
            ground = _load_json(_resolve_inside(corpus_root, document["ground_truth"]))
            truth = _validate_contract(ground.get("extraction"))
        except Exception:
            failures["contract_validation_failed"] += 1
            continue
        expected_text = _normalize_text(truth["document"]["plain_text"])
        predicted_text = _normalize_text(predicted["document"]["plain_text"])
        bucket = edit_totals[document["profile"]]
        bucket[0] += _edit_distance(expected_text, predicted_text)
        bucket[1] += max(1, len(expected_text))
        tp, fp, fn = _cell_counts(predicted, truth)
        cell_tp, cell_fp, cell_fn = cell_tp + tp, cell_fp + fp, cell_fn + fn
        tp, fp, fn = _mark_counts(predicted, truth)
        mark_tp, mark_fp, mark_fn = mark_tp + tp, mark_fp + fp, mark_fn + fn
        interpretation = record.get("interpretation") or {}
        if ground.get("document_type") is not None:
            type_expected.append(str(ground["document_type"]))
            type_predicted.append(str(interpretation["document_type"]) if interpretation.get("document_type") is not None else None)
        if ground.get("supplier_id") is not None:
            supplier_truth += 1
            got = interpretation.get("supplier_id")
            if got is not None:
                if str(got) == str(ground["supplier_id"]):
                    supplier_tp += 1
                else:
                    supplier_fp += 1
        pages = max(1, int(predicted["document"]["page_count"]))
        seconds_per_page.append(float(record["elapsed_ms"]) / 1000 / pages)
        if record.get("peak_gpu_used_mib") is not None:
            peaks.append(int(record["peak_gpu_used_mib"]))

    _, _, cell_f1 = _ratio(cell_tp, cell_fp, cell_fn)
    mark_precision, mark_recall, _ = _ratio(mark_tp, mark_fp, mark_fn)
    supplier_predictions = supplier_tp + supplier_fp
    metrics = {
        "clean_printed_cer": edit_totals["clean_printed"][0] / edit_totals["clean_printed"][1] if edit_totals["clean_printed"][1] else None,
        "scan_photo_cer": edit_totals["scan_photo"][0] / edit_totals["scan_photo"][1] if edit_totals["scan_photo"][1] else None,
        "table_cell_f1": cell_f1,
        "document_type_macro_f1": _macro_f1(type_expected, type_predicted),
        "supplier_match_precision": supplier_tp / supplier_predictions if supplier_predictions else None,
        "supplier_match_coverage": supplier_predictions / supplier_truth if supplier_truth else None,
        "mark_precision": mark_precision,
        "mark_recall": mark_recall,
        "p50_seconds_per_page": _percentile(seconds_per_page, 0.50),
        "p95_seconds_per_page": _percentile(seconds_per_page, 0.95),
        "peak_gpu_used_mib": max(peaks) if peaks else accuracy_footer.get("peak_gpu_used_mib"),
        "failure_count": sum(failures.values()),
        "failure_codes": dict(failures),
        "oom_count": failures.get("oom", 0),
        "contract_validation_failures": failures.get("contract_validation_failed", 0),
        "soak_hours": float(soak_footer.get("elapsed_seconds", 0)) / 3600,
        "soak_failure_count": int(soak_footer.get("failure_count", 0)),
        "soak_gpu_memory_growth_mib": soak_footer.get("gpu_memory_growth_mib"),
    }
    threshold = manifest["thresholds"]
    checks = {
        "clean_printed_cer": metrics["clean_printed_cer"] is not None and metrics["clean_printed_cer"] <= threshold["clean_printed_cer_max"],
        "scan_photo_cer": metrics["scan_photo_cer"] is not None and metrics["scan_photo_cer"] <= threshold["scan_photo_cer_max"],
        "table_cell_f1": metrics["table_cell_f1"] is not None and metrics["table_cell_f1"] >= threshold["table_cell_f1_min"],
        "document_type_macro_f1": metrics["document_type_macro_f1"] is not None and metrics["document_type_macro_f1"] >= threshold["document_type_macro_f1_min"],
        "supplier_match_precision": metrics["supplier_match_precision"] is not None and metrics["supplier_match_precision"] >= threshold["supplier_match_precision_min"],
        "mark_precision": metrics["mark_precision"] is not None and metrics["mark_precision"] >= threshold["mark_precision_min"],
        "mark_recall": metrics["mark_recall"] is not None and metrics["mark_recall"] >= threshold["mark_recall_min"],
        "p95_seconds_per_page": metrics["p95_seconds_per_page"] is not None and metrics["p95_seconds_per_page"] <= threshold["p95_seconds_per_page_max"],
        "no_oom": metrics["oom_count"] == 0,
        "contract_valid": metrics["contract_validation_failures"] == 0,
        "all_documents_returned": metrics["failure_count"] == 0,
        "target_hardware": hardware_pass,
        "soak_duration": metrics["soak_hours"] >= threshold["soak_hours_min"],
        "soak_no_job_loss": metrics["soak_failure_count"] == 0,
        "soak_memory_review": engine["soak_memory_review"] == "pass",
    }
    return {
        "engine_id": engine["id"],
        "model": engine["model"],
        "revision": engine["revision"],
        "license": engine["license"],
        "hardware": hardware,
        "metrics": metrics,
        "checks": checks,
        "evidence_complete": all(value is not None for key, value in metrics.items() if key not in {"peak_gpu_used_mib", "soak_gpu_memory_growth_mib"}) and engine["soak_memory_review"] != "pending",
        "eligible": all(checks.values()),
    }


def _decision(results: list[dict[str, Any]]) -> dict[str, Any]:
    if not all(result.get("evidence_complete") for result in results):
        return {"status": "unselected", "reason": "pending_target_24gb_or_mandatory_evidence"}
    eligible = [result for result in results if result.get("eligible")]
    if not eligible:
        return {"status": "unselected", "reason": "no_engine_passed_all_mandatory_gates"}
    unlimited = next(result for result in results if result["engine_id"] == "unlimited-ocr")
    baselines = [result for result in results if result["engine_id"] != "unlimited-ocr"]
    if unlimited.get("eligible"):
        comparisons = [
            ("clean_printed_cer", False),
            ("scan_photo_cer", False),
            ("table_cell_f1", True),
        ]
        within_two_points = all(
            (
                unlimited["metrics"][metric] >= max(base["metrics"][metric] for base in baselines) - 0.02
                if higher_is_better
                else unlimited["metrics"][metric] <= min(base["metrics"][metric] for base in baselines) + 0.02
            )
            for metric, higher_is_better in comparisons
        )
        if within_two_points:
            return {"status": "selected", "engine_id": "unlimited-ocr", "reason": "passed_all_gates_and_within_two_points_of_best_baseline"}
    eligible_baselines = [result for result in eligible if result["engine_id"] != "unlimited-ocr"]
    if len(eligible_baselines) == 1:
        return {"status": "selected", "engine_id": eligible_baselines[0]["engine_id"], "reason": "only_baseline_to_pass_all_mandatory_gates"}
    return {
        "status": "unselected",
        "reason": "multiple_eligible_engines_without_approved_tiebreak" if eligible_baselines else "unlimited_failed_relative_gate",
        "eligible_engines": [result["engine_id"] for result in eligible],
    }


def _evaluate(manifest_path: Path, output: Path) -> None:
    manifest = _load_manifest(manifest_path, require_command=False, require_files=True)
    results = [_score_engine(manifest_path, manifest, engine) for engine in manifest["engines"]]
    report = {
        "schema_version": "1",
        "contract_version": "1",
        "evaluated_at": _utc_now(),
        "engines": results,
        "model_decision": _decision(results),
    }
    _atomic_json(output, report)


def _self_test() -> None:
    assert _edit_distance("kitten", "sitting") == 3
    assert _edit_distance("שלום", "שלם") == 1
    assert _percentile([1.0, 2.0, 3.0, 4.0], 0.5) == 2.5
    assert round(_percentile([1.0, 2.0, 3.0, 4.0], 0.95) or 0, 2) == 3.85
    predicted = {"tables": [{"page": 1, "bbox": [0, 0, 1, 1], "rows": [[{"text": "א", "bbox": None}, {"text": "ב", "bbox": None}]]}]}
    truth = {"tables": [{"page": 1, "bbox": [0, 0, 1, 1], "rows": [[{"text": "א", "bbox": None}, {"text": "ג", "bbox": None}]]}]}
    assert _cell_counts(predicted, truth) == (1, 1, 1)
    mark = {"page": 1, "kind": "check", "bbox": [0.1, 0.1, 0.2, 0.2]}
    assert _mark_counts({"marks": [mark]}, {"marks": [mark]}) == (1, 0, 0)
    assert _macro_f1(["invoice", "credit"], ["invoice", "credit"]) == 1.0
    assert _decision([{"evidence_complete": False}]) == {
        "status": "unselected",
        "reason": "pending_target_24gb_or_mandatory_evidence",
    }
    canonical = {**CANONICAL_MAX_THRESHOLDS, **CANONICAL_MIN_THRESHOLDS}
    assert _validate_thresholds(canonical) == canonical
    stricter = dict(canonical)
    stricter["clean_printed_cer_max"] = 0.04
    stricter["mark_recall_min"] = 0.90
    assert _validate_thresholds(stricter) == stricter
    for key, weakened in (
        ("clean_printed_cer_max", 0.051),
        ("mark_recall_min", 0.849),
    ):
        values = dict(canonical)
        values[key] = weakened
        try:
            _validate_thresholds(values)
        except BenchmarkError:
            pass
        else:
            raise AssertionError(f"weakened_threshold_was_accepted:{key}")
    assert _real_sha256("1" * 64)
    assert not _real_sha256("0" * 64)
    assert IMAGE_DIGEST.fullmatch("candidate@sha256:" + "1" * 64)
    assert not IMAGE_DIGEST.fullmatch("sha256:" + "1" * 64)
    sandbox = _sandbox_command(
        {
            "image": "candidate@sha256:" + "1" * 64,
            "command": ["python", "/app/adapter.py"],
        },
        Path("C:/synthetic/source.pdf"),
        0,
        "synthetic-container",
    )
    for option in (
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=256",
        "--memory=64g",
        "--memory-swap=64g",
        "--cpus=16",
        "--ulimit=nofile=1024:1024",
        "--ulimit=core=0:0",
        "--user=10001:10001",
    ):
        assert option in sandbox
    assert sandbox.count("--mount") == 1
    assert sandbox[-2:] == ["python", "/app/adapter.py"]
    print("benchmark_self_test_passed")


def _preflight(manifest_path: Path) -> None:
    manifest = _load_manifest(manifest_path, require_command=True, require_files=True)
    hardware = _require_target_hardware(manifest)
    print(json.dumps({"status": "ready", "hardware": hardware}, ensure_ascii=False))


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="action", required=True)
    preflight = commands.add_parser("preflight")
    preflight.add_argument("--manifest", type=Path, required=True)
    execute = commands.add_parser("execute")
    execute.add_argument("--manifest", type=Path, required=True)
    execute.add_argument("--engine", choices=sorted(REQUIRED_ENGINES), required=True)
    execute.add_argument("--phase", choices=["accuracy", "soak"], required=True)
    execute.add_argument("--duration-seconds", type=int)
    execute.add_argument("--output", type=Path, required=True)
    evaluate = commands.add_parser("evaluate")
    evaluate.add_argument("--manifest", type=Path, required=True)
    evaluate.add_argument("--output", type=Path, required=True)
    commands.add_parser("self-test")
    return parser


def main() -> int:
    args = _parser().parse_args()
    try:
        if args.action == "preflight":
            _preflight(args.manifest.resolve())
        elif args.action == "execute":
            _execute(args.manifest.resolve(), args.engine, args.phase, args.output.resolve(), args.duration_seconds)
        elif args.action == "evaluate":
            _evaluate(args.manifest.resolve(), args.output.resolve())
        else:
            _self_test()
    except BenchmarkError as exc:
        print(f"benchmark_error:{exc}", file=sys.stderr)
        return 2
    except (KeyError, TypeError, ValueError):
        print("benchmark_error:invalid_manifest_or_evidence", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
