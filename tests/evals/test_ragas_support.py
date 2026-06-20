from evals.ragas_support import extract_scores, TokenCounter


class _FakeResult:
    # mimics a ragas EvaluationResult exposing a dict-like _repr_dict
    _repr_dict = {"faithfulness": 0.8563, "context_recall": 0.8}


def test_extract_scores_from_repr_dict():
    assert extract_scores(_FakeResult()) == {"faithfulness": 0.8563, "context_recall": 0.8}


class _Msg:
    def __init__(self, usage):
        self.usage_metadata = usage


class _Gen:
    def __init__(self, usage):
        self.message = _Msg(usage)


class _LLMResult:
    def __init__(self, usages):
        self.generations = [[_Gen(u)] for u in usages]


def test_token_counter_sums_usage():
    tc = TokenCounter()
    tc.on_llm_end(_LLMResult([
        {"input_tokens": 100, "output_tokens": 10},
        {"input_tokens": 50, "output_tokens": 5},
    ]))
    assert tc.input_tokens == 150
    assert tc.output_tokens == 15
    assert tc.calls == 1  # one on_llm_end call (one LLM round, 2 generations)
