#!/bin/sh
# Backend entrypoint: prepare the corpus (demo vs empty) before serving.
set -e

if [ "${DEMO_DATA:-1}" = "0" ]; then
  # Empty mode: drop the baked CUAD ledger so init_db() recreates empty tables.
  rm -f /app/contract_rag.db
fi

# Load the demo snapshot or reset Weaviate to empty (retries until Weaviate is up).
python -m scripts.init_corpus

exec "$@"
