#!/usr/bin/env python3
"""Install the pinned upstream relay binary as the existing unprivileged user."""
import hashlib
import io
import json
from pathlib import Path
import platform
import subprocess
import tarfile
import urllib.request

VERSION = "2.11.7"
SHA256 = "727b91701a392de6ebc5027509f548bf39979e5216340d0faed8fa5e69c84f8b"
URL = f"https://github.com/caddyserver/caddy/releases/download/v{VERSION}/caddy_{VERSION}_linux_amd64.tar.gz"
if platform.system() != "Linux" or platform.machine() != "x86_64":
    raise RuntimeError("This pinned relay binary requires x86_64 Linux")
directory = Path("/opt/radio-max/relay/bin")
directory.mkdir(mode=0o755, exist_ok=True)
with urllib.request.urlopen(URL, timeout=60) as response:
    archive = response.read(100_000_001)
if len(archive) > 100_000_000 or hashlib.sha256(archive).hexdigest() != SHA256:
    raise RuntimeError("Pinned archive hash mismatch")
with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
    member = tar.getmember("caddy")
    if not member.isfile():
        raise RuntimeError("Expected a regular Caddy binary")
    binary = tar.extractfile(member).read()
target = directory / f"caddy-{VERSION}"
temporary = directory / f".caddy-{VERSION}.next"
temporary.write_bytes(binary)
temporary.chmod(0o755)
version = subprocess.check_output([str(temporary), "version"], text=True).strip()
if not version.startswith("v" + VERSION + " "):
    raise RuntimeError("Unexpected Caddy version")
temporary.replace(target)
print(json.dumps({"version": VERSION, "archiveSha256": SHA256,
                  "binarySha256": hashlib.sha256(binary).hexdigest(), "path": str(target)}))
