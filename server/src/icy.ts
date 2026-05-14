const META_BLOCK_SIZE = 16;
const encoder = new TextEncoder();

export function buildMetaBlock(title: string): Uint8Array {
  const payload = `StreamTitle='${title.replace(/'/g, "")}';`;
  const payloadBytes = encoder.encode(payload);
  const units = Math.ceil(payloadBytes.length / META_BLOCK_SIZE);
  const block = new Uint8Array(1 + units * META_BLOCK_SIZE);
  block[0] = units;
  block.set(payloadBytes, 1);
  return block;
}

export const EMPTY_META_BLOCK = new Uint8Array([0]);
