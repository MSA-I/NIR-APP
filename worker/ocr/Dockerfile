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
        poppler-utils=22.12.0-2+deb12u2 \
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

USER 10001:10001
CMD ["python", "-m", "src.worker"]
