# Backend image: FastAPI + retrieval + (lazy) MinerU ingestion.
# MinerU's ~3.5GB models are NOT baked in — they download on first ingest only
# (the seeded query demo never needs them). Python deps install via uv.
FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_LINK_MODE=copy \
    WEAVIATE_HOST=weaviate \
    PATH="/app/.venv/bin:$PATH"

# System libs: pymupdf/opencv (libgl, glib), unstructured/pdfplumber (poppler),
# healthcheck/build (curl, build-essential).
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential libgl1 libglib2.0-0 poppler-utils curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /uvx /bin/

WORKDIR /app

# Dependency layer (cached unless pyproject/lock change).
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# Application code + committed seed (SQLite ledger, Weaviate snapshot, demo PDFs).
COPY contract_rag ./contract_rag
COPY scripts ./scripts
COPY docker ./docker
COPY contract_rag.db ./contract_rag.db
COPY data/cuad/weaviate_snapshot.parquet ./data/cuad/weaviate_snapshot.parquet
COPY data/cuad/pdfs ./data/cuad/pdfs
RUN chmod +x docker/entrypoint.sh

EXPOSE 8000
# Entrypoint prepares the corpus (demo vs empty per DEMO_DATA), then runs the CMD.
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["uvicorn", "contract_rag.api.app:app", "--host", "0.0.0.0", "--port", "8000"]
