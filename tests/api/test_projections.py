from datetime import date
from contract_rag.api import projections as pj


def test_derive_status():
    today = date(2026, 6, 3)
    assert pj.derive_status(None, None, today) == "pending"
    assert pj.derive_status("2026-01-01", None, today) == "pending"
    assert pj.derive_status("2026-01-01", "2026-05-01", today) == "expired"
    assert pj.derive_status("2026-01-01", "2027-01-01", today) == "active"


def test_format_size():
    assert pj.format_size(8_598_323) == "8.2 MB"
    assert pj.format_size(None) == "—"


def test_format_ts():
    assert pj.format_ts("2026-04-12T09:22:05+00:00") == "2026-04-12 09:22"
    assert pj.format_ts(None) == ""


def test_to_contract_row_derives_fields():
    today = date(2026, 6, 3)
    contract = {
        "contract_id": "JSUS2026004", "counterparty": "OC", "amount": 147664.05,
        "currency": "USD", "project_name": "UD", "contract_type": "Supply",
        "petitioner": "Wang Li", "petition_date": "2026-04-12", "file_no": "2026004",
        "effective_date": "2026-04-15", "expiration_date": "2027-04-14",
        "department": "UD", "brief_description": "x", "status": "active",
        "page_count": 14, "created_at": "2026-04-12T09:22:00+00:00",
    }
    row = pj.to_contract_row(contract, signed_pdf_size=8_598_323, today=today)
    assert row["file_name"] == "2026004-JSUS2026004-UD"
    assert row["pages"] == 14
    assert row["size"] == "8.2 MB"
    assert row["archived_at"] == "2026-04-12 09:22"
    assert row["status"] == "active"


def test_derive_yearly_amount():
    # N>0 months annualizes; 24 months of 24000 -> 12000/year.
    assert pj.derive_yearly_amount(24000, 24) == 12000.0
    assert pj.derive_yearly_amount(147664.05, 12) == 147664.05
    # one-time (0) and unspecified (None) do not annualize.
    assert pj.derive_yearly_amount(24000, 0) is None
    assert pj.derive_yearly_amount(24000, None) is None
    # no amount -> nothing to annualize.
    assert pj.derive_yearly_amount(0, 12) is None


def test_to_contract_row_term_months_and_yearly():
    today = date(2026, 6, 3)
    base = {
        "contract_id": "X", "amount": 24000, "currency": "USD",
        "created_at": "2026-04-12T09:22:00+00:00",
    }
    term = pj.to_contract_row({**base, "term_months": 24}, signed_pdf_size=None, today=today)
    assert term["term_months"] == 24
    assert term["yearly_amount"] == 12000.0

    once = pj.to_contract_row({**base, "term_months": 0}, signed_pdf_size=None, today=today)
    assert once["term_months"] == 0
    assert once["yearly_amount"] is None

    unset = pj.to_contract_row(base, signed_pdf_size=None, today=today)
    assert unset["term_months"] is None
    assert unset["yearly_amount"] is None


def test_to_config_state():
    rules = {"default": {"prefix": ""}, "chinabuy": {"prefix": "CN"}}
    cfg = pj.to_config_state(file_no_rules=rules, year=2026)
    assert cfg["ragEnabled"] is False
    examples = {r["category"]: r["example"] for r in cfg["fileNoRules"]}
    assert examples["default"] == "2026001"
    assert examples["chinabuy"] == "CN2026001"
    assert cfg["contractVersions"] == []
    assert pj.to_config_state(file_no_rules=rules, year=2026,
                              contract_versions=["Purchase Contract"])["contractVersions"] == ["Purchase Contract"]


def test_apply_contract_query_filters_and_sorts():
    today = date(2026, 6, 3)
    rows = [
        {"contract_id": "A", "counterparty": "Foo", "project_name": "p", "amount": 10,
         "department": "UD", "petition_date": "2026-01-01", "effective_date": "2026-01-01",
         "expiration_date": "2027-01-01", "status": "active"},
        {"contract_id": "B", "counterparty": "Bar", "project_name": "p", "amount": 50,
         "department": "PD", "petition_date": "2025-01-01", "effective_date": "2025-01-01",
         "expiration_date": "2027-01-01", "status": "active"},
    ]
    out = pj.apply_contract_query(rows, q="foo", department="all", status="all", year="all", sort=None, today=today)
    assert [r["contract_id"] for r in out] == ["A"]
    out2 = pj.apply_contract_query(rows, q=None, department="all", status="all", year="2025", sort="amount_desc", today=today)
    assert [r["contract_id"] for r in out2] == ["B"]
