"""CUAD demo metadata: seed the ledger from contract TEXT (no approval page).

The production upload flow seeds the SQLite ``contracts`` row from a China-Jushi
approval form (``ingest/approval.py``). CUAD demo contracts have no such form, so
instead a flash LLM reads the contract's own text and emits the same ledger
fields. Mirrors ``approval.py``'s shape: a pure parser (``parse_cuad_metadata``)
plus a Gemini I/O boundary (``extract_cuad_metadata``). Demo-only.

``contract_type`` is not asked of the LLM — it is parsed deterministically from
the CUAD filename (which encodes the agreement title), reusing the same keyword
map used to curate the 100-contract sample.
"""
from __future__ import annotations

import logging
import re

from contract_rag.ingest.approval import _coerce_amount
from contract_rag.ingest.vision import extract_text, parse_json_block

logger = logging.getLogger(__name__)

# Ledger string fields we extract from contract text (subset of _CONTRACT_COLS
# that's actually derivable from a generic commercial contract).
_STR_FIELDS = (
    "counterparty",
    "currency",
    "project_name",
    "brief_description",
    "effective_date",
    "expiration_date",
)

# Filename agreement-title -> normalized contract_type (first match wins). Mirrors
# the curation map; ordered so specific types beat generic ones.
_TYPE_PATTERNS: tuple[tuple[str, str], ...] = (
    ("STRATEGIC_ALLIANCE|ALLIANCE", "Strategic Alliance"),
    ("JOINT_VENTURE", "Joint Venture"),
    ("CO[_-]?BRANDING", "Co-Branding"),
    ("DISTRIBUTOR|DISTRIBUTION", "Distribution"),
    ("RESELLER", "Reseller"),
    ("SUPPLY", "Supply"),
    ("MANUFACTUR", "Manufacturing"),
    ("OUTSOURC", "Outsourcing"),
    ("MAINTENANCE", "Maintenance"),
    ("HOSTING", "Hosting"),
    ("DEVELOPMENT", "Development"),
    ("CONSULTING", "Consulting"),
    ("TRANSPORT|LOGISTICS", "Transportation"),
    ("SERVIC", "Services"),  # catches SERVICE and SERVICING
    ("AGENCY", "Agency"),
    ("LICENS", "License"),
    ("ENDORSEMENT", "Endorsement"),
    ("SPONSORSHIP", "Sponsorship"),
    ("PROMOTION", "Promotion"),
    ("MARKETING", "Marketing"),
    ("FRANCHISE", "Franchise"),
    ("COLLABORAT", "Collaboration"),
    ("COOPERATION", "Cooperation"),
    ("AFFILIATE", "Affiliate"),
    ("INTELLECTUAL_PROPERTY|TRADEMARK", "IP"),
)


def contract_type_from_filename(stem: str) -> str:
    """Derive a normalized contract type from a CUAD filename stem."""
    upper = stem.upper()
    for pattern, label in _TYPE_PATTERNS:
        if re.search(pattern, upper):
            return label
    return "Other"


def parse_cuad_metadata(raw: str) -> dict:
    """Parse a Gemini metadata-extraction response into the fixed ledger shape.

    Unknown keys are dropped; ``amount`` is coerced to a float; missing/null
    string fields become ``None``. Raises ``ValueError`` on unparseable input.
    """
    data = parse_json_block(raw)
    out: dict = {}
    for key in _STR_FIELDS:
        value = data.get(key)
        out[key] = value if (value is None or isinstance(value, str)) else str(value)
    out["amount"] = _coerce_amount(data.get("amount"))
    return out


_PROMPT = """You are extracting structured metadata from the text of ONE
commercial contract (a U.S. SEC-filed agreement).

Return ONLY a JSON object with EXACTLY these keys (no prose, no code fence):
{
  "counterparty":      string | null,  // the primary OTHER contracting party (company name)
  "amount":            number | null,  // total contract value / fee if stated, no $ or commas; null if none
  "currency":          string | null,  // e.g. "USD"; infer from the amount symbol
  "project_name":      string | null,  // short title of the contract subject
  "brief_description": string | null,  // one concise sentence on what the contract is about
  "effective_date":    string | null,  // the agreement's effective date as YYYY-MM-DD
  "expiration_date":   string | null   // the end/expiration date as YYYY-MM-DD, null if perpetual/unstated
}

Rules:
- Use only facts present in the text; if a field isn't stated, use null.
- Preserve every digit of amounts and dates exactly.
- counterparty is a party to THIS contract, not a third party merely mentioned.

Contract text:
---
{text}
---"""

# Most contracts state parties / value / dates in the preamble + first articles;
# cap the text so the flash call stays cheap and within token limits.
_MAX_TEXT_CHARS = 8000


def extract_cuad_metadata(text: str, *, model: str | None = None) -> dict:
    """Extract ledger fields from contract ``text`` via the flash LLM (Vertex)."""
    from contract_rag.config import load_config
    from contract_rag.llm import LLM

    model = model or load_config().models.rag_light
    prompt = _PROMPT.replace("{text}", (text or "")[:_MAX_TEXT_CHARS])
    resp = LLM().get_custom_chat_object(model).invoke(prompt)
    fields = parse_cuad_metadata(extract_text(resp.content))
    logger.info("cuad metadata: counterparty=%s amount=%s", fields.get("counterparty"), fields.get("amount"))
    return fields
