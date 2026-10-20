#!/usr/bin/env python3
"""Switch a local release on the host, restoring the previous image on failed checks."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]


def atomic_write(path, data):
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=".release-")
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(data)
        os.chmod(name, 0o600)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def run(*args, capture=False):
    return subprocess.run(args, cwd=ROOT, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None)


def deploy(image):
    expected = os.environ.get("DEPLOY_HOSTNAME")
    if not expected or run("hostname", capture=True).stdout.strip().split(".")[0] != expected or ROOT != Path("/Users/kyle/platform/apps/radio-max"):
        raise RuntimeError("This command is scoped to radio-max on the host")
    state = ROOT / "state"
    state.mkdir(mode=0o700, exist_ok=True)
    with (state / "deploy.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        _deploy(image)


def _deploy(image):
    if not re.fullmatch(r"(?:[a-z0-9./_-]+@sha256:[a-f0-9]{64}|radio-max:[a-zA-Z0-9_.-]+)", image):
        raise ValueError("Use a GHCR digest or a unique local radio-max release tag")
    if image.endswith((":latest", ":main", ":master")):
        raise ValueError("Mutable image tags are not releases")
    run("docker", "image", "inspect", image, "--format", "{{.Id}}", capture=True)
    env_path = ROOT / ".env"
    previous = env_path.read_text() if env_path.exists() else None
    values = [line for line in (previous or "").splitlines() if not line.startswith("RADIO_MAX_IMAGE=")]
    values.append("RADIO_MAX_IMAGE=" + image)
    state = ROOT / "state"
    atomic_write(env_path, "\n".join(values) + "\n")
    compose = ("docker", "compose")
    try:
        run(*compose, "config", "--quiet")
        run(*compose, "up", "-d", "--wait", "--wait-timeout", "90")
        result = run(*compose, "exec", "-T", "web", "bun", "/app/deploy/verify.ts", capture=True)
        verification = json.loads(result.stdout)
    except Exception:
        if previous is not None:
            atomic_write(env_path, previous)
            run(*compose, "up", "-d", "--wait", "--wait-timeout", "90")
            run(*compose, "exec", "-T", "web", "bun", "/app/deploy/verify.ts")
            print("Candidate rejected; previous release restored and verified.", flush=True)
        else:
            # Use the candidate's env while removing only this Compose project.
            run(*compose, "down")
            env_path.unlink(missing_ok=True)
            print("Initial candidate rejected and removed.", flush=True)
        raise
    record = {
        "acceptedAt": datetime.now(timezone.utc).isoformat(),
        "image": image,
        "imageId": run("docker", "image", "inspect", image, "--format", "{{.Id}}", capture=True).stdout.strip(),
        "publicRoutingChanged": False,
        "verification": verification,
    }
    atomic_write(state / "deployment.json", json.dumps(record, indent=2) + "\n")
    print(json.dumps(record, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image")
    deploy(parser.parse_args().image)
