#!/usr/bin/env bash
# Interactive launcher: ask whether to load the demo corpus, then bring the
# stack up. "No" starts with an empty database (upload your own contracts).
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env.docker ]; then
  echo "First run: copy .env.docker.example -> .env.docker and fill in your Vertex"
  echo "credentials (and drop your service-account JSON in ./.secrets/), then re-run."
  exit 1
fi

read -r -p "Load the demo corpus (100 CUAD contracts)? [Y/n] " ans
case "${ans:-Y}" in
  [nN]*)
    echo "→ Starting with an EMPTY database. Upload contracts via the UI to populate it."
    DEMO_DATA=0 docker compose up --build
    ;;
  *)
    echo "→ Loading the demo corpus into Weaviate on startup…"
    DEMO_DATA=1 docker compose up --build
    ;;
esac
