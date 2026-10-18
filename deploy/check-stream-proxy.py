#!/usr/bin/env python3
"""Exercise real client limits through two proxies without publishing a port."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
IMAGE = os.environ.get("RADIO_MAX_TEST_IMAGE", "radio-max:ci")
CADDY = "caddy:2.11.7@sha256:8dc9fa87b36b25303d1c67d2a09f5824b7f3bfd72cb052f246e5da2133fe29a8"
name = "radio-limits-" + secrets.token_hex(5)
env = {**os.environ, "RADIO_MAX_RELAY_TOKEN": secrets.token_hex(32)}
created = []

def command(*args, **kwargs):
    result = subprocess.run(["docker", *args], capture_output=True, text=True, env=env, **kwargs)
    if result.returncode:
        details = result.stderr.replace(env["RADIO_MAX_RELAY_TOKEN"], "[redacted]")[-1200:]
        raise RuntimeError("Isolated proxy check failed: docker " + args[0] + " (exit " + str(result.returncode) + "): " + details)
    return result.stdout.strip()

command("network", "create", name)
try:
    (ROOT / "state").mkdir(mode=0o700, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="proxy-check-", dir=ROOT / "state") as folder:
        config = Path(folder) / "Caddyfile"
        if "--public-edge" in sys.argv:
            text = (ROOT / "deploy/relay/Caddyfile.public").read_text().replace(
                "    admin off\n", "    admin off\n    auto_https off\n", 1).replace(
                "\napi.radio-max.kylescudder.co.uk {", "\nhttp://127.0.0.1:18081 {").replace(
                "\nhttp://api.radio-max.kylescudder.co.uk {", "\nhttp://127.0.0.1:18082 {")
        else:
            text = (ROOT / "deploy/relay/Caddyfile").read_text() + "\n" + \
                "http://127.0.0.1:18081 {\n reverse_proxy 127.0.0.1:8080\n}\n"
        config.write_text(text.replace("radio-max-origin.tail4a869e.ts.net:8080", name + "-app:8080"))
        shared = ["--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                  "--memory", "256m", "--cpus", "0.5", "--tmpfs", "/tmp:size=64m,exec"]
        created.append(name + "-app")
        command("run", "-d", "--name", name + "-app", "--network", name, *shared,
                "-e", "RADIO_MAX_RELAY_TOKEN", "-e", "STREAM_HOSTS=127.0.0.1,radio-max",
                "-e", "DASHBOARD_ORIGIN=https://radio-max.kylescudder.co.uk", IMAGE)
        created.append(name + "-proxy")
        command("run", "-d", "--name", name + "-proxy", "--network", name, *shared,
                "--user", "1000:1000", "-e", "RADIO_MAX_RELAY_TOKEN",
                "--tmpfs", "/config:size=1m,mode=1777", "--tmpfs", "/data:size=1m,mode=1777",
                "-v", str(config) + ":/etc/caddy/Caddyfile:ro", CADDY,
                "sh", "-c", "cp /usr/bin/caddy /tmp/caddy && exec /tmp/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile")
        result = command("run", "--rm", "--network", "container:" + name + "-proxy", *shared,
                         "-e", "VERIFY_BASE_URL=http://127.0.0.1:18081",
                         "-v", str(ROOT / "deploy/relay/verify-limits.ts") + ":/checks/verify-limits.ts:ro",
                         IMAGE, "bun", "/checks/verify-limits.ts", timeout=45)
        identity_check = '''
import {strict as assert} from "node:assert";
const url="http://BACKEND:8080/radio/main";
const denied=await fetch(url,{method:"HEAD",headers:{Host:"radio-max"}});
assert.equal(denied.status,403);
const allowed=await fetch(url,{method:"HEAD",headers:{Host:"radio-max",
"X-Radio-Max-Relay-Token":process.env.RADIO_MAX_RELAY_TOKEN,
"X-Radio-Max-Client-IP":"192.0.2.99"}});
assert.equal(allowed.status,200);
'''.replace("BACKEND", name + "-app")
        command("run", "--rm", "--network", name, *shared, "-e", "RADIO_MAX_RELAY_TOKEN",
                IMAGE, "bun", "-e", identity_check, timeout=15)
        checks = json.loads(result)
        checks["privateOriginRequiresRelayToken"] = True
        if "--public-edge" not in sys.argv:
            acceptance = command("exec", "-e", "VERIFY_EXCLUSIVE=true", name + "-app",
                                 "bun", "/app/deploy/verify.ts", timeout=30)
            checks["tokenEnabledContainerAcceptance"] = json.loads(acceptance)["passed"]
        print(json.dumps(checks))
except Exception:
    if created:
        logs = subprocess.run(["docker", "logs", "--tail", "25", created[-1]], capture_output=True, text=True)
        safe = (logs.stdout + logs.stderr).replace(env["RADIO_MAX_RELAY_TOKEN"], "[redacted]")
        print(safe[-2500:], file=sys.stderr)
    raise
finally:
    for container in reversed(created):
        subprocess.run(["docker", "rm", "-f", "-v", container], capture_output=True)
    subprocess.run(["docker", "network", "rm", name], capture_output=True)
