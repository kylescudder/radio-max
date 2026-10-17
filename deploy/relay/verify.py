#!/usr/bin/env python3
"""Run on the edge host: test the relay on a spare loopback port before cutover."""
import json
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request

with tempfile.TemporaryDirectory(prefix="relay-check-", dir="/opt/radio-max/relay") as directory:
    directory = Path(directory)
    config = directory / "Caddyfile"
    config.write_text(Path("/opt/radio-max/relay/Caddyfile").read_text().replace(
        "\nhttp://:8080 {", "\nhttp://127.0.0.1:18080 {"))
    with (directory / "log").open("w") as log:
        process = subprocess.Popen([
            "/usr/bin/caddy", "run", "--config", str(config), "--adapter", "caddyfile",
        ], stdout=log, stderr=log)
        try:
            for attempt in range(30):
                if process.poll() is not None:
                    raise RuntimeError("Candidate relay exited before readiness")
                try:
                    response = urllib.request.urlopen("http://127.0.0.1:18080/healthz", timeout=2)
                    if response.read() == b"ok":
                        break
                except OSError as error:
                    last_error = str(error)
                    time.sleep(.2)
            else:
                log.flush()
                details = (directory / "log").read_text()[-2500:]
                raise RuntimeError("Candidate relay never became ready: " + last_error + "\n" + details)
            request = urllib.request.Request("http://127.0.0.1:18080/radio/main", method="HEAD")
            response = urllib.request.urlopen(request, timeout=5)
            assert response.status == 200
            assert response.headers["icy-br"] == "128"
            assert response.headers["icy-sr"] == "48000"
            decoded = subprocess.run([
                "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-icy", "1",
                "-i", "http://127.0.0.1:18080/radio/main", "-t", "8", "-f", "null", "-",
            ], capture_output=True, text=True, timeout=30)
            if decoded.returncode:
                raise RuntimeError("Audio decoding failed: " + decoded.stderr[-1000:])
            javascript = '''
const ws=new WebSocket("ws://127.0.0.1:18080/api/ws",{
  headers:{Origin:"https://radio-max-preview.kylescudder.co.uk"}});
const timer=setTimeout(()=>process.exit(1),8000);
ws.onmessage=e=>{const d=JSON.parse(e.data);if(d.type==="state"&&d.stations[0].id==="main"){
  clearTimeout(timer);ws.close();process.exit(0)}};
'''
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
