from langchain_google_genai import GoogleGenerativeAIEmbeddings
from langchain_google_genai import ChatGoogleGenerativeAI
import os

from dotenv import load_dotenv
load_dotenv()
from contract_rag.config import load_config


class _PerItemGoogleEmbeddings(GoogleGenerativeAIEmbeddings):
    """Vertex-safe embeddings.

    The stock ``embed_documents`` packs many texts into one
    ``client.models.embed_content(contents=[...])`` call. On the Vertex
    ``gemini-embedding-2`` endpoint that returns ONE vector for the whole
    request, not one per item — so a 50-chunk contract silently collapses to
    ~3 vectors (one per 20k-token batch) and retrieval breaks.
    (Verified 2026-05-28; see memory/embedding_pitfalls.md.)

    Forcing ``batch_size=1`` makes each request a single item, which the
    endpoint embeds correctly. One HTTP call per chunk is fine for our
    batch-ingestion path (contracts are tens–hundreds of chunks, not latency
    sensitive). ``WeaviateVectorStore.add_documents`` calls ``embed_documents``
    with no ``batch_size`` kwarg, so the default must be safe here.
    """

    def embed_documents(self, texts, *, batch_size: int = 1, **kwargs):
        return super().embed_documents(texts, batch_size=batch_size, **kwargs)


class LLM:
    """LLM client wrapper.

    Kept as a plain class (no ``@singleton`` decorator) so that tests can
    monkeypatch methods directly on the class object
    (``monkeypatch.setattr(LLM, "get_custom_chat_object", ...)``).
    ``LLM()`` is cheap — it only reads two env vars — so constructing a fresh
    instance per call site is acceptable.
    """

    def __init__(self):
        self.VERTEX_API_KEY = os.getenv("VERTEX_API_KEY")
        self.VERTEX_PROJECT_ID = os.getenv("VERTEX_PROJECT_ID")

    def get_embedding_object(self):
        return  _PerItemGoogleEmbeddings(
                    model="gemini-embedding-2",
                    project=self.VERTEX_PROJECT_ID,
                    google_api_key=self.VERTEX_API_KEY,
                    vertexai=True,
                )

    def get_chat_object(self):
        return ChatGoogleGenerativeAI(
                    model=load_config().models.rag_generate,
                    project=self.VERTEX_PROJECT_ID,
                    google_api_key=self.VERTEX_API_KEY,
                    vertexai=True,
                )

    def get_custom_chat_object(self, model, *, temperature=None):
        kwargs = {}
        if temperature is not None:
            kwargs["temperature"] = temperature
        return ChatGoogleGenerativeAI(
                    model=model,
                    project=self.VERTEX_PROJECT_ID,
                    google_api_key=self.VERTEX_API_KEY,
                    vertexai=True,
                    **kwargs,
                )