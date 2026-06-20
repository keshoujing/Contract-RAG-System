"""Unit tests for CUAD demo metadata extraction (pure parts only).

The Gemini extraction call is the I/O boundary (integration); these cover the
JSON parse + the filename->contract_type derivation.
"""
import pytest

from contract_rag.ingest import cuad_metadata as cm


def test_parse_keeps_known_fields_and_coerces_amount():
    raw = ('{"counterparty":"Acme Corp","amount":"$1,250.50","currency":"USD",'
           '"effective_date":"2020-01-01","junk":"x"}')
    out = cm.parse_cuad_metadata(raw)
    assert out["counterparty"] == "Acme Corp"
    assert out["amount"] == 1250.50
    assert out["currency"] == "USD"
    assert out["effective_date"] == "2020-01-01"
    assert "junk" not in out


def test_parse_defaults_missing_and_null_to_none():
    out = cm.parse_cuad_metadata('{"counterparty":null}')
    assert out["counterparty"] is None
    assert out["amount"] is None
    assert out["brief_description"] is None  # missing key -> None


def test_parse_stringifies_nonstring_scalar():
    assert cm.parse_cuad_metadata('{"project_name":123}')["project_name"] == "123"


def test_parse_raises_on_garbage():
    with pytest.raises(ValueError):
        cm.parse_cuad_metadata("not json at all")


def test_contract_type_from_filename():
    assert cm.contract_type_from_filename(
        "ACCURAYINC_09_01_2010-EX-10.31-DISTRIBUTOR_AGREEMENT") == "Distribution"
    assert cm.contract_type_from_filename("FOO-EX-10.1-SERVICES_AGREEMENT") == "Services"
    assert cm.contract_type_from_filename("FOO-EX-10.1-SERVICING_AGREEMENT") == "Services"
    assert cm.contract_type_from_filename("FOO-EX-10.1-MANUFACTURING_AGREEMENT") == "Manufacturing"
    assert cm.contract_type_from_filename("FOO_RANDOMDOC") == "Other"
