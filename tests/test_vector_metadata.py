from contract_rag.ingest.chunker import Chunk
from contract_rag.storage import vector_store


def test_contract_vector_metadata_reads_file_no_and_contract_number(monkeypatch):
    monkeypatch.setattr(vector_store.db, "get_contract", lambda cid: {
        "contract_id": cid,
        "file_no": "2026004",
        "contract_number": "JSUS2026004",
        "raw_extraction": '{"contract_number": "JSUS2026004"}',
    })

    assert vector_store._contract_vector_metadata("2026004") == {
        "file_no": "2026004",
        "contract_number": "JSUS2026004",
    }


def test_chunk_properties_include_file_no_and_contract_number(monkeypatch):
    monkeypatch.setattr(vector_store, "_contract_vector_metadata",
                        lambda cid: {"file_no": "F-1", "contract_number": "C-1"})
    chunk = Chunk(
        chunk_id="c1", contract_id="ROW-1", chunk_type="clause",
        content="Net 30.", page_start=1, page_end=1,
        section_path=["Payment"],
    )

    props = vector_store._chunk_properties(chunk)

    assert props["contract_id"] == "ROW-1"
    assert props["file_no"] == "F-1"
    assert props["contract_number"] == "C-1"


def test_chunk_properties_include_bbox(monkeypatch):
    monkeypatch.setattr(vector_store, "_contract_vector_metadata",
                        lambda cid: {"file_no": "", "contract_number": ""})
    chunk = Chunk(
        chunk_id="c1", contract_id="ROW-1", chunk_type="table",
        content="<table>", page_start=2, page_end=2,
        section_path=["Pricing"], bbox=[10.0, 20.0, 30.0, 40.0],
    )

    assert vector_store._chunk_properties(chunk)["bbox"] == [10.0, 20.0, 30.0, 40.0]


def test_chunk_properties_bbox_none_becomes_empty_list(monkeypatch):
    # Weaviate NUMBER_ARRAY can't store None; a bbox-less chunk maps to [].
    monkeypatch.setattr(vector_store, "_contract_vector_metadata",
                        lambda cid: {"file_no": "", "contract_number": ""})
    chunk = Chunk(
        chunk_id="c1", contract_id="ROW-1", chunk_type="clause",
        content="Net 30.", page_start=1, page_end=1,
        section_path=["Payment"], bbox=None,
    )

    assert vector_store._chunk_properties(chunk)["bbox"] == []
