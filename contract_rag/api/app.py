"""FastAPI application factory for the V1 upload backend."""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from contract_rag.api.routes import config, contracts, processing, query, uploads
from contract_rag.storage import db


@asynccontextmanager
async def _lifespan(app: FastAPI):
    db.init_db()
    yield


def create_app() -> FastAPI:
    app = FastAPI(title="Contract-RAG V1 API", lifespan=_lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    for module in (uploads, contracts, processing, config, query):
        app.include_router(module.router, prefix="/api")
    return app


app = create_app()
