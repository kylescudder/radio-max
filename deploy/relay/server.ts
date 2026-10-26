// Entry point used by the existing radio-max.service (User=kyle). The edge
// relays HTTP, WebSockets and ICY bytes; broadcasting happens only on the host.
import { readFileSync } from 'node:fs'

const token = readFileSync(
  '/opt/radio-max/relay/secrets/origin-token',
  'utf8'
).trim()
if (!/^[a-f0-9]{64}$/i.test(token))
  throw new Error('Invalid private origin token')
const child = Bun.spawn(
  [
    '/opt/radio-max/relay/bin/caddy-2.11.7',
    'run',
    '--config',
    '/opt/radio-max/relay/Caddyfile',
    '--adapter',
    'caddyfile'
  ],
  {
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env, RADIO_MAX_RELAY_TOKEN: token }
  }
)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    try {
      child.kill(signal)
    } catch {
      /* child has already exited */
    }
  })
}
process.exit(await child.exited)
