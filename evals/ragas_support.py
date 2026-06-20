"""Shared RAGAS wiring for the eval runners: judge, run config, score + token extraction."""
from __future__ import annotations

from langchain_core.callbacks import BaseCallbackHandler
from ragas import RunConfig
from ragas.embeddings import LangchainEmbeddingsWrapper
from ragas.llms import LangchainLLMWrapper

from contract_rag.config import load_config
from contract_rag.llm import LLM


def build_judge():
    """(judge_llm, judge_emb) at temperature=0. The judge must return plain-string
    content — gemini-3-flash-preview returns list-blocks RAGAS can't parse, so
    models.rag_judge pins gemini-2.5-flash (see memory/retrieval_eval.md)."""
    judge_model = load_config().models.rag_judge
    judge_llm = LangchainLLMWrapper(LLM().get_custom_chat_object(judge_model, temperature=0))
    judge_emb = LangchainEmbeddingsWrapper(LLM().get_embedding_object())
    return judge_llm, judge_emb


def default_run_config() -> RunConfig:
    # timeout=300: answer_correctness runs several sequential LLM calls + embeddings
    # per case; under load that can legitimately need >90s, and a shorter cap aborts
    # it -> NaN (observed). 300s is the value the first clean baseline ran at and got
    # real correctness scores. Kills are handled by the runner's per-config cache
    # (resume), NOT by a short timeout. Raw Vertex handles 12-way concurrency with no
    # 429 (probed), so max_workers=4 is safe. max_retries/max_wait keep RAGAS defaults.
    return RunConfig(timeout=300, max_workers=4)


def extract_scores(result) -> dict:
    raw = dict(result._repr_dict) if hasattr(result, "_repr_dict") else dict(result)
    return {k: float(v) for k, v in raw.items()}


class TokenCounter(BaseCallbackHandler):
    """Sums LangChain usage_metadata across all LLM calls (best-effort token count)."""

    def __init__(self):
        self.input_tokens = 0
        self.output_tokens = 0
        self.calls = 0

    def on_llm_end(self, response, **kwargs):
        self.calls += 1
        for gen_list in getattr(response, "generations", []):
            for gen in gen_list:
                msg = getattr(gen, "message", None)
                usage = getattr(msg, "usage_metadata", None) if msg is not None else None
                if usage:
                    self.input_tokens += usage.get("input_tokens", 0)
                    self.output_tokens += usage.get("output_tokens", 0)
