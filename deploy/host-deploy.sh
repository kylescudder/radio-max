#!/usr/bin/env bash
# Entry point for manual digest deploys; launchd runs host-deploy.py directly.
set -euo pipefail
exec python3 -B "$(dirname "$0")/host-deploy.py" "$@"
