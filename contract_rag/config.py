"""Typed configuration loader for contract_rag.

Replaces the old fragile ``open("config.yaml")`` (which broke the moment the
working directory changed). The YAML lives next to this file and is resolved
via ``__file__``, so config loading is independent of the caller's cwd.

Relative paths under ``paths:`` are resolved against the *project root*
(the parent of the ``contract_rag`` package), so ``./storage`` always means
``<repo>/storage`` regardless of where the process was launched.
"""
from __future__ import annotations

import pathlib
from dataclasses import dataclass
from functools import lru_cache

import yaml

_CONFIG_PATH = pathlib.Path(__file__).resolve().parent / "config.yaml"
_PROJECT_ROOT = _CONFIG_PATH.parent.parent  # parent of the contract_rag/ package


@dataclass(frozen=True)
class ChunkingConfig:
    soft_target: int
    hard_cap: int
    overlap: int


@dataclass(frozen=True)
class RouterConfig:
    cover_threshold: float


@dataclass(frozen=True)
class PathsConfig:
    storage_dir: pathlib.Path
    sqlite_path: pathlib.Path
    mineru_out: pathlib.Path


@dataclass(frozen=True)
class WeaviateConfig:
    collection: str


@dataclass(frozen=True)
class RetrievalConfig:
    alpha: float
    use_reranker: bool
    k: int
    top_n: int
    # Max messages kept per Q&A conversation: both the window replayed into the
    # agent and the hard cap at which the UI forces a new conversation (so older
    # turns never silently drop out of context).
    history_max_messages: int = 8


@dataclass(frozen=True)
class MineruConfig:
    method: str
    backend: str
    lang: str


@dataclass(frozen=True)
class ModelsConfig:
    vision: str
    ocr: str
    approval: str
    ocr_render_dpi: int
    rag_generate: str
    rag_light: str
    rag_judge: str
    ocr_max_workers: int = 3
    # Vertex AI Ranking API model used when retrieval.use_reranker is true.
    rerank: str = "semantic-ranker-default@latest"


@dataclass(frozen=True)
class ExcelConfig:
    """Transition-period Excel ledger sync (decision 15).

    SQLite is the system source of truth; Excel is a detachable, human-owned
    business ledger we sync into. ``enabled=false`` disconnects the sync entirely
    (the core pipeline never depends on it). ``path`` is the ledger workbook.
    """
    enabled: bool
    path: pathlib.Path | None


@dataclass(frozen=True)
class Config:
    chunking: ChunkingConfig
    router: RouterConfig
    paths: PathsConfig
    weaviate: WeaviateConfig
    retrieval: RetrievalConfig
    mineru: MineruConfig
    models: ModelsConfig
    excel: ExcelConfig


def _resolve(p: str) -> pathlib.Path:
    path = pathlib.Path(p)
    return path if path.is_absolute() else (_PROJECT_ROOT / path).resolve()


@lru_cache(maxsize=1)
def load_config(config_path: str | None = None) -> Config:
    """Load and cache the package config. Pass ``config_path`` to override."""
    path = pathlib.Path(config_path) if config_path else _CONFIG_PATH
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    return Config(
        chunking=ChunkingConfig(**raw["chunking"]),
        router=RouterConfig(**raw["router"]),
        paths=PathsConfig(
            storage_dir=_resolve(raw["paths"]["storage_dir"]),
            sqlite_path=_resolve(raw["paths"]["sqlite_path"]),
            mineru_out=_resolve(raw["paths"]["mineru_out"]),
        ),
        weaviate=WeaviateConfig(**raw["weaviate"]),
        retrieval=RetrievalConfig(**raw["retrieval"]),
        mineru=MineruConfig(**raw["mineru"]),
        models=ModelsConfig(**raw["models"]),
        excel=_excel_config(raw.get("excel") or {}),
    )


def _excel_config(raw: dict) -> ExcelConfig:
    path = raw.get("path")
    return ExcelConfig(
        enabled=bool(raw.get("enabled", False)),
        path=_resolve(path) if path else None,
    )
