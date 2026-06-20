from evals.dataset import GoldCase, load_dataset


def test_load_dataset_parses_jsonl(tmp_path):
    p = tmp_path / "ds.jsonl"
    p.write_text(
        '{"question": "Q1", "ground_truth": "A1", "contract_id": "2026004", "note": "n"}\n'
        '{"question": "Q2", "ground_truth": "A2", "contract_id": "2026004"}\n',
        encoding="utf-8",
    )
    cases = load_dataset(p)
    assert cases == [
        GoldCase(question="Q1", ground_truth="A1", contract_id="2026004", note="n"),
        GoldCase(question="Q2", ground_truth="A2", contract_id="2026004", note=""),
    ]


def test_load_dataset_rejects_missing_field(tmp_path):
    p = tmp_path / "bad.jsonl"
    p.write_text('{"question": "Q1", "contract_id": "2026004"}\n', encoding="utf-8")
    try:
        load_dataset(p)
        assert False, "expected ValueError"
    except ValueError as e:
        assert "ground_truth" in str(e)
