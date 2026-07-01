from contract_rag.storage import db
from contract_rag.registry.contract_versions import get_contract_versions, set_contract_versions


def test_seed_defaults_when_unset(tmp_path):
    dbp = tmp_path / "t.db"
    db.init_db(dbp)
    versions = get_contract_versions(db_path=dbp)
    assert "Supply Agreement" in versions


def test_set_then_get_roundtrip(tmp_path):
    dbp = tmp_path / "t.db"
    db.init_db(dbp)
    set_contract_versions(["Purchase Contract", "Sales Contract"], db_path=dbp)
    assert get_contract_versions(db_path=dbp) == ["Purchase Contract", "Sales Contract"]


def test_set_dedupes_and_drops_blanks(tmp_path):
    dbp = tmp_path / "t.db"
    db.init_db(dbp)
    set_contract_versions(["Purchase Contract", "Purchase Contract", "  ", "Sales Contract"], db_path=dbp)
    assert get_contract_versions(db_path=dbp) == ["Purchase Contract", "Sales Contract"]
