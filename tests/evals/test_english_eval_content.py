from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]

ENGLISH_ONLY_FILES = [
    ROOT / "contract_rag/retrieval/graph.py",
    *sorted((ROOT / "evals").glob("dataset_*.jsonl")),
    *sorted((ROOT / "tests/retrieval").glob("test_*.py")),
    *sorted((ROOT / "tests/evals").glob("test_*.py")),
]


def test_legacy_eval_prompt_files_are_english_only():
    offenders: list[str] = []
    for path in ENGLISH_ONLY_FILES:
        text = path.read_text(encoding="utf-8")
        for line_no, line in enumerate(text.splitlines(), start=1):
            if any("\u4e00" <= char <= "\u9fff" for char in line):
                offenders.append(f"{path.relative_to(ROOT)}:{line_no}: {line.strip()}")

    assert offenders == []
