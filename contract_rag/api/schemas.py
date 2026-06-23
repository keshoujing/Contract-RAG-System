"""Pydantic request models (input validation at the HTTP boundary)."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class PageTagsRequest(BaseModel):
    """Per-page role map {page_no(str): "approval"|"contract"|"other"}."""

    tags: dict[str, Literal["approval", "contract", "other"]]


class ConfirmRequest(BaseModel):
    """User-confirmed registration fields submitted from the wizard.

    ``fields`` carries the (possibly edited) approval fields keyed by contract
    column names, including ``contract_id``. The backend merges these over the
    stored raw extraction so fields the form does not surface are not lost.
    """

    fields: dict[str, object]
    effective_date: str | None = None
    expiration_date: str | None = None
    category: str = "default"
    overwrite: bool = False


class ResolveRequest(BaseModel):
    resolutions: dict[str, object]


class PatchContractRequest(BaseModel):
    """Editable contract fields. Unknown/derived keys (file_name, pages, status, ...) are ignored."""

    model_config = ConfigDict(extra="ignore")

    counterparty: str | None = None
    project_name: str | None = None
    department: str | None = None
    petitioner: str | None = None
    contract_type: str | None = None
    amount: float | None = None
    term_months: int | None = None
    currency: str | None = None
    effective_date: str | None = None
    expiration_date: str | None = None
    brief_description: str | None = None


class BatchRequest(BaseModel):
    ids: list[str]
    action: Literal["export", "delete"]


class ConfigPatchRequest(BaseModel):
    """Runtime config toggles from the settings page (camelCase to match the UI)."""

    model_config = ConfigDict(extra="ignore")

    ragEnabled: bool | None = None
    excelEnabled: bool | None = None
    backupEnabled: bool | None = None
    lockCheckEnabled: bool | None = None


class QuerySource(BaseModel):
    contract_id: str = ""
    chunk_type: str = ""
    page_start: int | None = None
    page_end: int | None = None
    page: int | None = None          # single jump target for the verify popup
    section_path: str = ""
    bbox: list[float] | None = None  # page-space highlight region, None if absent
    content: str = ""


class QueryRequest(BaseModel):
    question: str = Field(min_length=1)
    contract_id: str | None = None
    conversation_id: str | None = None
    scope_type: Literal["all", "contract", "supplier"] = "all"
    scope_value: str | None = None


class FeedbackRequest(BaseModel):
    """A user 👍/👎 on an assistant answer (the gold-flywheel signal)."""

    score: Literal["up", "down"]
    comment: str | None = None


class QueryResponse(BaseModel):
    question: str
    answer: str
    conversation_id: str | None = None
    # Assistant message id of this answer — the target for 👍/👎 feedback.
    message_id: str | None = None
    # True once the conversation hits the message cap (retrieval.history_max_messages):
    # the UI warns and forces a new conversation so older turns never drop from context.
    conversation_full: bool = False
    # §5 unified evidence: each item is kind=clause|record; clause carries
    # page/bbox for the verify popup. Polymorphic, so list[dict].
    evidence: list[dict] = []
    # Deprecated (pre-agent one-shot fields); kept optional for back-compat.
    question_class: str = ""
    sources: list[QuerySource] = []
