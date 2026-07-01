"""File No. rule formatting + File Name composition."""
from __future__ import annotations

from contract_rag.registry import file_no
from contract_rag.storage import db


# --- File Name composition (fixed order: File No.-Contract No.-Request Description) --- #

def test_compose_file_name_order():
    assert file_no.compose_file_name("F-1", "JSEGRCXS20260003", "Egypt paper edge-protector contract") == \
        "F-1-JSEGRCXS20260003-Egypt paper edge-protector contract"


def test_compose_file_name_omits_blank_description():
    assert file_no.compose_file_name("F-1", "C-1", None) == "F-1-C-1"


def test_compose_file_name_requires_file_no_and_id():
    assert file_no.compose_file_name(None, "C-1", "x") is None
    assert file_no.compose_file_name("F-1", None, "x") is None


# --- File No. rule formatting: {prefix}{year}{seq:03d} ---------------------- #

def test_format_default_is_year_plus_seq():
    assert file_no.format_file_no(2026, 1, "default") == "2026001"


def test_format_chinabuy_gets_cn_prefix():
    assert file_no.format_file_no(2026, 1, "chinabuy") == "CN2026001"


def test_format_pd_category():
    assert file_no.format_file_no(2026, 12, "PD") == "PD2026012"


def test_unknown_category_falls_back_to_default_prefix():
    assert file_no.format_file_no(2026, 7, "nonexistent") == "2026007"


# --- rule store (front-end setter) + per-(category, year) sequence ---------- #

def test_set_and_get_rules_round_trip(tmp_path):
    dbp = tmp_path / "t.db"
    db.init_db(dbp)
    file_no.set_file_no_rules({"chinabuy": {"prefix": "CN"}}, db_path=dbp)
    assert file_no.get_file_no_rules(db_path=dbp)["chinabuy"] == {"prefix": "CN"}


def test_next_seq_increments_per_category_per_year(tmp_path):
    dbp = tmp_path / "t.db"
    db.init_db(dbp)
    assert file_no.next_seq("default", 2026, db_path=dbp) == 1  # empty -> 001
    file_no.assign_file_no("C-1", category="default", year=2026, db_path=dbp)  # 2026001
    file_no.assign_file_no("C-2", category="default", year=2026, db_path=dbp)  # 2026002
    assert db.get_contract("C-2", dbp)["file_no"] == "2026002"
    # a different category keeps its own counter
    assert file_no.assign_file_no("C-3", category="chinabuy", year=2026, db_path=dbp) == "CN2026001"
    # a new year resets
    assert file_no.next_seq("default", 2027, db_path=dbp) == 1


def test_assign_file_no_persists_to_contract(tmp_path):
    dbp = tmp_path / "t.db"
    db.init_db(dbp)
    db.upsert_contract("C-1", db_path=dbp, counterparty="x")
    assigned = file_no.assign_file_no("C-1", category="chinabuy", year=2026, seq=9, db_path=dbp)
    assert assigned == "CN2026009"
    assert db.get_contract("C-1", dbp)["file_no"] == "CN2026009"
