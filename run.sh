#!/bin/zsh
# Phone-friendly gallery of ComfyUI renders: port 8189, visible on the home network.
# Settings (GALLERY_ROOT, COMFY_URL, GALLERY_CACHE) come from the environment or a local .env file.
cd "${0:A:h}"
[[ -f .env ]] && set -a && source .env && set +a
exec .venv/bin/python -m uvicorn app:app --host "${GALLERY_HOST:-0.0.0.0}" --port "${GALLERY_PORT:-8189}"
