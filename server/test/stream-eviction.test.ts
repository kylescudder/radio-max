import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Station } from '../src/station.ts'
import { StreamLimits } from '../src/stream-limits.ts'

test('server-side slow-listener eviction returns its admission slot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'radio-eviction-'))
  mkdirSync(join(root, 'main'))
  writeFileSync(join(root, 'main', 'fixture.mp3'), Buffer.alloc(128_000))
  const gate = new StreamLimits(1, 1, 100)
  const admitted = gate.admit('slow')
  if (!admitted.ok) throw new Error('Expected first slot')
  const station = new Station(
    { id: 'main', name: 'Test' },
    root,
    128,
    16000,
    'http://example.invalid',
    () => {}
  )
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c
      }
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 0 })
  )
  controller.enqueue(new Uint8Array(2_000_001))
  let closed = false
  try {
    station.start()
    station.addListener({
      controller,
      icyMetaInt: 0,
      bytesSinceMeta: 0,
      lastMetaTitle: '',
      onClose: () => {
        closed = true
        admitted.release()
      }
    })
    for (let n = 0; n < 20 && !closed; n++) await Bun.sleep(50)
    expect(closed).toBe(true)
    expect(station.snapshot().listeners).toBe(0)
    expect(gate.admit('new-player').ok).toBe(true)
  } finally {
    station.stop()
    await stream.cancel()
    rmSync(root, { recursive: true, force: true })
  }
})
