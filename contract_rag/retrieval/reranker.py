"""Vertex AI Ranking API reranker (managed cross-encoder).

Replaces the old local ``bge-reranker-v2-m3`` cross-encoder, which OOM'd on long
table chunks (it padded the batch to the longest sequence — see
``memory/retrieval_eval.md`` 四点五坑3). This calls Google's managed
``semantic-ranker`` over the Discovery Engine ``rank`` endpoint instead: no local
model, no OOM, multilingual (Chinese query ↔ English clause verified).

Used only when ``retrieval.use_reranker`` is true; ``retrieve()`` pulls the k
candidates from Weaviate and hands them here to be re-scored down to top_n.

Auth: a service-account OAuth token via ADC (``GOOGLE_APPLICATION_CREDENTIALS``);
the SA needs the ``Discovery Engine Editor`` role. Project = ``VERTEX_PROJECT_ID``.

The deterministic glue (``_build_records`` / ``_request_payload`` / ``_reorder``)
is unit-tested; the live ``_rank_via_api`` call runs through integration only,
matching the project's convention for live Vertex calls.
"""
from __future__ import annotations

import os
from functools import lru_cache

from dotenv import load_dotenv
from langchain_core.documents import Document

from contract_rag.config import load_config

load_dotenv()

# The ranking API exposes a single built-in config under the `global` location;
# `default_ranking_config` always exists and needs no provisioning.
_LOCATION = "global"
_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]


def _default_model() -> str:
    return load_config().models.rerank


def _build_records(docs: list[Document]) -> list[dict]:
    """Project Documents to rank-API records. The list index is the record id so
    the response can be mapped back to the original Document."""
    return [{"id": str(i), "content": d.page_content} for i, d in enumerate(docs)]


def _request_payload(query: str, records: list[dict], model: str, top_n: int | None) -> dict:
    payload = {"model": model, "query": query, "records": records}
    if top_n is not None:
        payload["topN"] = top_n
    return payload


def _reorder(docs: list[Document], ranked: list[dict], top_n: int | None) -> list[Document]:
    """Re-sort ``docs`` by the API's relevance scores (descending), mapping each
    record id back to its Document. Records with an out-of-range or non-integer
    id are dropped; result is truncated to ``top_n`` when given."""
    ordered = sorted(ranked, key=lambda r: r.get("score", 0.0), reverse=True)
    out: list[Document] = []
    for rec in ordered:
        try:
            idx = int(rec.get("id"))
        except (TypeError, ValueError):
            continue
        if 0 <= idx < len(docs):
            out.append(docs[idx])
    return out[:top_n] if top_n is not None else out


@lru_cache(maxsize=1)
def _session():
    """Authorized requests session (token auto-refreshed). Built once, lazily, so
    importing this module stays offline-safe and unit tests never touch auth."""
    import google.auth
    from google.auth.transport.requests import AuthorizedSession

    creds, _ = google.auth.default(scopes=_SCOPES)
    return AuthorizedSession(creds)


def _endpoint(project: str) -> str:
    return (
        f"https://discoveryengine.googleapis.com/v1/projects/{project}"
        f"/locations/{_LOCATION}/rankingConfigs/default_ranking_config:rank"
    )


def _rank_via_api(payload: dict) -> list[dict]:
    """POST the rank request and return the ranked records. Network boundary."""
    project = os.getenv("VERTEX_PROJECT_ID")
    if not project:
        raise RuntimeError("VERTEX_PROJECT_ID not set; cannot call the Ranking API.")
    resp = _session().post(_endpoint(project), json=payload, timeout=60)
    if resp.status_code != 200:
        raise RuntimeError(f"Ranking API returned {resp.status_code}: {resp.text[:500]}")
    return resp.json().get("records", [])


def rerank(
    query: str,
    docs: list[Document],
    *,
    top_n: int | None = None,
    model: str | None = None,
) -> list[Document]:
    """Re-rank ``docs`` against ``query`` via the Vertex Ranking API, returning the
    top_n most relevant (or all, ranked, when ``top_n`` is None). Empty input
    short-circuits without a network call."""
    if not docs:
        return []
    records = _build_records(docs)
    payload = _request_payload(query, records, model or _default_model(), top_n)
    ranked = _rank_via_api(payload)
    return _reorder(docs, ranked, top_n)
