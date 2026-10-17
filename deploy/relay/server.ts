// Entry point used by the existing radio-max.service (User=kyle). The edge
// relays HTTP, WebSockets and ICY bytes; broadcasting happens only on Herman.
const child = Bun.spawn([
  "/usr/bin/caddy", "run", "--config", "/opt/radio-max/relay/Caddyfile",
  "--adapter", "caddyfile",
], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    try { child.kill(signal); } catch { /* child has already exited */ }
  });
}
process.exit(await child.exited);
