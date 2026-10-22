// Incremental CRC-32 (same as backend/src/storage/zipStream.js), used to
// confirm the downloaded ZIP is byte-for-byte what the server sent.

const TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes, previous = 0) {
  let crc = (previous ^ 0xffffffff) >>> 0
  for (let index = 0; index < bytes.length; index++) crc = TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export const crcHex = (value) => value.toString(16).padStart(8, '0')
