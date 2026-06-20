"""Weaviate connection host/port are env-configurable (localhost locally,
`weaviate` service in Docker)."""
import contract_rag.storage.vector_store as vs


def test_weaviate_host_defaults_to_localhost(monkeypatch):
    monkeypatch.delenv("WEAVIATE_HOST", raising=False)
    assert vs._weaviate_host() == "localhost"


def test_weaviate_host_reads_env(monkeypatch):
    monkeypatch.setenv("WEAVIATE_HOST", "weaviate")
    assert vs._weaviate_host() == "weaviate"


def test_weaviate_port_default_and_env(monkeypatch):
    monkeypatch.delenv("WEAVIATE_PORT", raising=False)
    assert vs._weaviate_port() == 8080
    monkeypatch.setenv("WEAVIATE_PORT", "9090")
    assert vs._weaviate_port() == 9090
