#!/usr/bin/env bash
# Shared entry point for launchd, systemd and manual digest deploys.
set -euo pipefail
exec python3 -B "$(dirname "$0")/herman-deploy.py" "$@"
