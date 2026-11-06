#!/usr/bin/env bash
set -euo pipefail
analysis_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$analysis_dir"
unset PYTHONPATH PYTHONHOME
exec "$analysis_dir/.venv/bin/python" server.py "$@"
