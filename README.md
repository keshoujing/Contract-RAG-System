# Contract RAG

Contract RAG is a Python project for building a retrieval-augmented generation workflow over contract documents. It uses LangChain, Chroma, and Gemini/Vertex AI compatible Google Generative AI models for document embeddings and chat responses.

## Features

- Load contract documents locally.
- Store and query document embeddings with Chroma.
- Use Gemini embeddings and chat models through `langchain-google-genai`.
- Keep private contracts, generated vector stores, and API credentials out of Git.

## Project Structure

```text
.
├── main.py
├── pyproject.toml
├── src/
│   ├── database.py
│   ├── llm.py
│   ├── pdf_parser.py
│   └── helper/
│       └── singleton.py
└── uv.lock
```

## Requirements

- Python 3.12+
- `uv`
- Google/Vertex AI credentials with access to the configured Gemini models

## Setup

```bash
uv sync
```

Create a local `.env` file:

```bash
VERTEX_API_KEY=your_api_key
VERTEX_PROJECT_ID=your_project_id
```

Put local contract PDFs in the project directory or another private data folder. PDF files and the generated `chroma_db/` directory are ignored by Git by default.

## Run

```bash
uv run python main.py
```

## Notes

This repository intentionally excludes private contract PDFs, notebook outputs, local vector databases, and environment files. Rebuild the local Chroma database from your own documents when running the project on a new machine.
