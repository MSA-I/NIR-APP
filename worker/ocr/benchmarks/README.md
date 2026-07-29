# OCR benchmark

This directory contains the reproducible benchmark harness only. Real or derived
document content, ground truth, model weights, and run outputs stay outside Git.

## Required evidence

- At least 200 licensed or anonymized documents. Every ground truth must contain
  Hebrew; the corpus as a whole must also contain ASCII English, digits, all five
  mark kinds (`circle`, `check`, `cross`, `underline`, `star`), and at least one
  `handwriting` block.
- At least 40 documents whose validated ground-truth `extraction.marks` is
  non-empty. Manifest flags are not accepted as a substitute for actual marks.
- Ground-truth document types must include `invoice`, `delivery_note`,
  `credit_note`, and `price_list`. The other InterpretationContract v1 values
  (`quote`, `payment_confirmation`, `other`) are also valid.
- The three pinned candidates in `manifest.example.json`.
- An NVIDIA target with at least 24 GiB VRAM. The local Quadro P2000 is rejected.
- One accuracy run and a two-hour soak run per candidate.
- `ExtractionContract` version `1` from every adapter; changing the contract per
  engine is not permitted.

Each ground-truth JSON file has this shape:

```json
{
  "extraction": { "schema_version": "1", "document": {}, "blocks": [], "tables": [], "marks": [] },
  "document_type": "invoice",
  "supplier_id": "optional-local-corpus-label"
}
```

Each manifest engine pins a reviewed container image as
`repository@sha256:<64 lowercase hex>` plus every model/tessdata artifact hash.
All-zero and missing placeholders fail preflight. Remote model code must be
reviewed at the pinned revision and baked into that image; the runner never
downloads or executes a host command from the manifest.

`command` is argv inside the pinned image. The runner constructs the Docker
invocation itself and sends one JSON request on stdin; the adapter writes one
JSON response to stdout. The source is the only bind mount and is exposed
read-only at `/input/source`.

```json
{
  "source": "/input/source",
  "claimed_mime": "application/pdf",
  "contract_version": "1",
  "model": "baidu/Unlimited-OCR",
  "revision": "07dea832e22aefee32ad281d4b80551282e1c168"
}
```

```json
{
  "revision": "07dea832e22aefee32ad281d4b80551282e1c168",
  "artifact_sha256": ["<exact-model-artifact-sha256>"],
  "extraction": { "schema_version": "1", "document": {}, "blocks": [], "tables": [], "marks": [] },
  "interpretation": { "document_type": "invoice", "supplier_id": "optional-local-corpus-label" }
}
```

The envelope is benchmark metadata; `extraction` itself remains the shared
production contract. Adapter stdout is capped at 26 MiB and stderr at 64 KiB;
stderr is never copied into reports or logs.

Every adapter run uses `--pull=never`, `--network=none`, a read-only root,
`--cap-drop=ALL`, `no-new-privileges`, a non-root UID, one read-only source-file
mount, an 8 GiB no-exec tmpfs, a 256-process limit, 64 GiB RAM with no extra
swap, 16 CPUs, and bounded file descriptors/core dumps. Timeout or output-limit
failure force-removes the exact uniquely named container. Model caches and
network access are disabled, so all runtime code and weights must already be in
the pinned image.

## Local hardware preflight — 2026-07-29

The accessible host has one Quadro P2000: 5,120 MiB VRAM, compute capability
6.1, NVIDIA driver 582.53 and reported CUDA 13.0. Docker exposes local contexts
only. No 24 GiB target was reachable, so no production benchmark was run and the
model decision is `unselected` pending target-hardware and corpus evidence.

Candidate revisions were pinned on 2026-07-29 to
`baidu/Unlimited-OCR@07dea832e22aefee32ad281d4b80551282e1c168` and
`Qwen/Qwen3-VL-8B-Instruct@0c351dd01ed87e9c1b53cbc748cba10e6187ff3b`.
Unlimited OCR's upstream `main` changed that day; the benchmark must keep the
recorded revision instead of following `main`.

The classical baseline is pinned in the worker image to
`tesseract-ocr=5.3.0-2` and `tesseract-ocr-eng/heb=1:4.1.0-2`; the manifest also
requires the exact `eng.traineddata` and `heb.traineddata` SHA-256 values emitted
by the image self-check.

## Commands

Copy the example manifest outside the repository, add corpus entries, replace
all image-digest and model-artifact placeholders with reviewed values, and keep
each `command` as argv that exists inside its pinned image. Set
`soak_memory_review` to `pass` or `fail` only after inspecting the completed
two-hour run. The checked-in placeholders intentionally fail preflight. The
canonical thresholds in the example may be made stricter but cannot be weakened.
Then run on the 24 GiB target:

```powershell
python .\worker\ocr\benchmarks\run.py preflight --manifest D:\private\ocr-benchmark\manifest.json
python .\worker\ocr\benchmarks\run.py execute --manifest D:\private\ocr-benchmark\manifest.json --engine unlimited-ocr --phase accuracy --output D:\private\ocr-benchmark\runs\unlimited-ocr-accuracy.jsonl
python .\worker\ocr\benchmarks\run.py execute --manifest D:\private\ocr-benchmark\manifest.json --engine unlimited-ocr --phase soak --duration-seconds 7200 --output D:\private\ocr-benchmark\runs\unlimited-ocr-soak.jsonl
python .\worker\ocr\benchmarks\run.py evaluate --manifest D:\private\ocr-benchmark\manifest.json --output D:\private\ocr-benchmark\metrics.json
python .\worker\ocr\benchmarks\run.py self-test
```

Repeat `execute` for `qwen3-vl-8b` and `tesseract-heb-eng`. The evaluator reports
CER, table-cell F1 with RTL cell order preserved, document-type macro F1,
supplier precision, mark precision/recall, p50/p95 seconds per page, peak VRAM,
failures, OOMs, contract failures, and soak evidence. It does not select a model
while any mandatory metric or target-hardware evidence is missing.
