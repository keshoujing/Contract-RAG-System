"""Unit tests for the Weaviate snapshot (portable BYO-vector dump).

Pure row<->object mapping only; the live export_collection / import_collection
(real Weaviate) run through integration, not the gate.
"""
import json

from contract_rag.storage import snapshot


class _FakeObj:
    def __init__(self, uuid, properties, vector):
        self.uuid = uuid
        self.properties = properties
        self.vector = vector


def test_object_to_row_serializes_props_and_extracts_named_vector():
    o = _FakeObj("u1", {"text": "clause text", "contract_id": "C1", "page_start": 3},
                 {"default": [0.1, 0.2, 0.3]})
    row = snapshot._object_to_row(o)
    assert row["uuid"] == "u1"
    assert row["vector"] == [0.1, 0.2, 0.3]
    assert json.loads(row["properties"]) == {"text": "clause text", "contract_id": "C1", "page_start": 3}


def test_object_to_row_handles_plain_list_vector():
    o = _FakeObj("u2", {"text": "x"}, [1.0, 2.0])
    assert snapshot._object_to_row(o)["vector"] == [1.0, 2.0]


def test_row_to_insert_roundtrips_object_to_row():
    o = _FakeObj("u1", {"text": "text", "bbox": [0.1, 0.2, 0.3, 0.4], "oversized": False},
                 {"default": [0.5, 0.6]})
    payload = snapshot._row_to_insert(snapshot._object_to_row(o))
    assert payload["uuid"] == "u1"
    assert payload["properties"] == {"text": "text", "bbox": [0.1, 0.2, 0.3, 0.4], "oversized": False}
    assert payload["vector"] == [0.5, 0.6]
