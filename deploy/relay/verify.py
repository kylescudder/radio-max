#!/usr/bin/env python3
"""Run on the edge host: test the relay on a spare loopback port before cutover."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request

with tempfile.TemporaryDirectory(prefix="relay-check-", dir="/opt/radio-max/relay") as directory:
    directory = Path(directory)
    config = directory / "Caddyfile"
    source_config = Path(os.environ.get("RELAY_CONFIG", "/opt/radio-max/relay/Caddyfile"))
    config.write_text(source_config.read_text().replace(
        "\nhttp://:8080 {", "\nhttp://127.0.0.1:18080 {"))
    with (directory / "log").open("w") as log:
        token = Path(os.environ.get("RELAY_TOKEN_FILE", "/opt/radio-max/relay/secrets/origin-token")).read_text().strip()
        process = subprocess.Popen([
            os.environ.get("CADDY_BINARY", "/opt/radio-max/relay/bin/caddy-2.11.7"),
            "run", "--config", str(config), "--adapter", "caddyfile",
        ], stdout=log, stderr=log, env={**os.environ, "RADIO_MAX_RELAY_TOKEN": token})
        try:
            for attempt in range(30):
                if process.poll() is not None:
                    raise RuntimeError("Candidate relay exited before readiness")
                try:
                    response = urllib.request.urlopen("http://127.0.0.1:18080/healthz", timeout=2)
                    # Status only, so the relay works with old (text) and new (JSON) origins.
                    if response.status == 200:
                        break
                except OSError as error:
                    last_error = str(error)
                    time.sleep(.2)
            else:
                log.flush()
                details = (directory / "log").read_text()[-2500:]
                raise RuntimeError("Candidate relay never became ready: " + last_error + "\n" + details)
            request = urllib.request.Request("http://127.0.0.1:18080/radio/main", method="HEAD",
                                             headers={"X-Forwarded-For": "192.0.2.10"})
            response = urllib.request.urlopen(request, timeout=5)
            assert response.status == 200
            assert response.headers["icy-br"] == "128"
            assert response.headers["icy-sr"] == "48000"
            decoded = subprocess.run([
                "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-icy", "1",
                "-headers", "X-Forwarded-For: 192.0.2.10\r\n",
                "-i", "http://127.0.0.1:18080/radio/main", "-t", "8", "-f", "null", "-",
            ], capture_output=True, text=True, timeout=30)
            if decoded.returncode:
                raise RuntimeError("Audio decoding failed: " + decoded.stderr[-1000:])
            origin = os.environ.get("DASHBOARD_ORIGIN", "https://radio-max.kylescudder.co.uk")
            javascript = '''
const ws=new WebSocket("ws://127.0.0.1:18080/api/ws",{
  headers:{Origin:ORIGIN,"X-Forwarded-For":"192.0.2.10"}});
const timer=setTimeout(()=>process.exit(1),8000);
ws.onmessage=e=>{const d=JSON.parse(e.data);if(d.type==="state"&&d.stations[0].id==="main"){
  clearTimeout(timer);ws.close();process.exit(0)}};
'''.replace("ORIGIN", json.dumps(origin))
            subprocess.run(["/usr/local/bin/bun", "-e", javascript], check=True,
                           timeout=12, capture_output=True)
            print(json.dumps({"privateRelayHealth": True, "icyHeaders": True,
                              "decodedAudioSeconds": 8, "websocketState": True}))
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
