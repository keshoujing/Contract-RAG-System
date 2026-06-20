"""Pure helpers shared by the Gemini-Vision image classifier and the scanned-page
OCR provider: response-text extraction and tolerant JSON-block parsing.

These are split out (and unit-tested offline) because the only untestable part
of a Gemini call is the network round-trip; everything around it — encoding the
prompt response and parsing structured output — is deterministic.
"""
from __future__ import annotations

import pytest

from contract_rag.ingest.vision import extract_text, parse_json_block


# --- extract_text: LangChain message.content is either str or list-of-blocks ---

def test_extract_text_from_plain_string() -> None:
    assert extract_text("hello") == "hello"


def test_extract_text_joins_text_blocks() -> None:
    content = [{"type": "text", "text": "abc"}, {"type": "text", "text": "def"}]
    assert extract_text(content) == "abcdef"


def test_extract_text_ignores_non_text_blocks() -> None:
    content = [{"type": "image_url", "image_url": {}}, {"type": "text", "text": "x"}]
    assert extract_text(content) == "x"


# --- parse_json_block: Gemini wraps JSON in ```json fences (or prose) ---

def test_parse_plain_json_object() -> None:
    assert parse_json_block('{"valid": true, "type": "table"}') == {"valid": True, "type": "table"}


def test_parse_json_in_fenced_block() -> None:
    raw = '```json\n{"valid": false, "type": "logo"}\n```'
    assert parse_json_block(raw) == {"valid": False, "type": "logo"}


def test_parse_json_with_surrounding_prose() -> None:
    raw = 'Here is the result:\n{"a": 1}\nHope that helps.'
    assert parse_json_block(raw) == {"a": 1}


def test_parse_malformed_raises_valueerror() -> None:
    with pytest.raises(ValueError):
        parse_json_block("not json at all")
