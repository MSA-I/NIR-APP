FROM python:3.12.11-slim-bookworm@sha256:c00fc7b44d844b6da22861ec24af43968a5200eac4ec607b4725d585165d6b49

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    OCR_TEMP_ROOT=/var/tmp/supplyflow-ocr

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libreoffice-core=4:7.4.7-1+deb12u14 \
        libreoffice-writer=4:7.4.7-1+deb12u14 \
        libreoffice-calc=4:7.4.7-1+deb12u14 \
        # deb12u2 -> deb12u3 (09.08.2026). Not an upgrade: same upstream 22.12.0-2, a Debian
        # security revision. The old pin became UNINSTALLABLE when the archive moved
        # libpoppler126 to u3 — poppler-utils=u2 depends on libpoppler126 (= u2) exactly, so
        # the build failed with "held broken packages" on any machine without a warm cache.
        # First caught by CI; the local image had survived on cache since before the revision.
        poppler-utils=22.12.0-2+deb12u3 \
        tesseract-ocr=5.3.0-2 \
        tesseract-ocr-eng=1:4.1.0-2 \
        tesseract-ocr-heb=1:4.1.0-2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.lock ./requirements.lock
RUN python -m pip install --no-deps --requirement requirements.lock

RUN groupadd --gid 10001 ocr \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin ocr \
    && mkdir -p /var/tmp/supplyflow-ocr \
    && chown -R ocr:ocr /app /var/tmp/supplyflow-ocr

COPY --chown=ocr:ocr src ./src
COPY --chown=ocr:ocr self_check.py ./self_check.py
COPY --chown=ocr:ocr test_scanning.py ./test_scanning.py
COPY --chown=ocr:ocr test_scan_gateway.py ./test_scan_gateway.py

USER 10001:10001
CMD ["python", "-m", "src.worker"]
