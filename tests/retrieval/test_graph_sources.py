from langchain_core.documents import Document

from contract_rag.retrieval import graph


def _doc(content, **meta):
    return Document(page_content=content, metadata=meta)


def test_doc_to_source_maps_metadata():
    # Stored bbox is MinerU's [x0, y0, x1, y1] on a fixed 0–1000 page canvas;
    # the source projection emits the front-end's [x, y, w, h] in 0–1 fractions.
    d = _doc(
        "Net 30 days.",
        contract_id="2026004", chunk_type="clause",
        page_start=3, page_end=3, section_path="4 Payment",
        bbox=[66, 386, 931, 421],
    )
    assert graph._doc_to_source(d) == {
        "contract_id": "2026004",
        "file_no": "",
        "contract_number": "",
        "chunk_type": "clause",
        "page_start": 3,
        "page_end": 3,
        "page": 3,
        "section_path": "4 Payment",
        "bbox": [0.066, 0.386, 0.865, 0.035],
        "content": "Net 30 days.",
    }


def test_doc_to_source_bbox_absent_is_none():
    # No bbox in metadata (multi-element clause, or legacy chunk) -> None;
    # `page` mirrors page_start for the verify-popup jump.
    src = graph._doc_to_source(_doc("x", contract_id="c", page_start=1, page_end=1))
    assert src["page"] == 1
    assert src["bbox"] is None


def test_doc_to_source_bbox_empty_list_is_none():
    # Weaviate NUMBER_ARRAY stores bbox-less chunks as [] (can't store None).
    src = graph._doc_to_source(_doc("x", contract_id="c", page_start=1, page_end=1, bbox=[]))
    assert src["bbox"] is None


def test_doc_to_source_bbox_degenerate_is_none():
    # A zero-area / inverted box (x1<=x0 or y1<=y0) is not a drawable highlight.
    src = graph._doc_to_source(_doc("x", contract_id="c", page_start=1, page_end=1, bbox=[5, 5, 5, 5]))
    assert src["bbox"] is None


def test_doc_to_source_bbox_clamped_to_page():
    # Out-of-canvas coords are clamped so the highlight stays on the page.
    src = graph._doc_to_source(_doc("x", contract_id="c", page_start=1, page_end=1, bbox=[900, 900, 1200, 1100]))
    x, y, w, h = src["bbox"]
    assert (x, y) == (0.9, 0.9)
    assert x + w <= 1.0 and y + h <= 1.0


def test_answer_with_sources_clause_path(monkeypatch):
    docs = [_doc("Net 30 days.", contract_id="2026004", chunk_type="clause",
                 page_start=3, page_end=3, section_path="4 Payment")]
    monkeypatch.setattr(graph, "classify_query", lambda q: "clause")
    monkeypatch.setattr(graph, "retrieve", lambda q, **kw: docs)

    class _FakeOut:
        content = "Net 30."

    class _FakeChat:
        def invoke(self, _prompt):
            return _FakeOut()

    monkeypatch.setattr(graph.LLM, "get_custom_chat_object",
                        lambda self, model, temperature=None: _FakeChat())

    res = graph.answer_with_sources("付款账期？", contract_id="2026004")
    assert res.question_class == "clause"
    assert res.answer == "Net 30."
    assert res.contexts == ["Net 30 days."]
    assert res.sources[0]["contract_id"] == "2026004"


def test_answer_with_sources_entity_path_has_no_contexts(monkeypatch):
    monkeypatch.setattr(graph, "classify_query", lambda q: "entity")
    monkeypatch.setattr(graph, "entity_lookup", lambda q: "买方是 China Jushi USA。")
    monkeypatch.setattr(graph.db, "list_contracts",
                        lambda: [{"contract_id": "2026004"}])

    res = graph.answer_with_sources("谁是买方？")
    assert res.question_class == "entity"
    assert res.contexts == []
    assert res.sources == [{"contract_id": "2026004"}]


def test_ragresult_diagnostics_defaults_empty():
    res = graph.RAGResult("q", "clause", "a", ["ctx"], [{"contract_id": "x"}])
    assert res.diagnostics == {}
