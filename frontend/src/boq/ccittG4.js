// CCITT Group 4 (ITU-T T.6, "/CCITTFaxDecode /K -1") decoder.
//
// Office scanners (Canon, Ricoh, ...) store the sharp black text layer of a
// scanned page this way, on top of a blurred colour background. The BOQ
// Check screen decodes it so the real scan can be shown next to each row,
// without a PDF library. Output: Uint8Array of width × height, 1 = black.

// Run-length code tables from ITU-T T.4 (terminating 0–63, make-up 64+).
const WHITE_CODES = [
  '00110101', '000111', '0111', '1000', '1011', '1100', '1110', '1111', '10011', '10100', '00111', '01000', '001000', '000011', '110100', '110101',
  '101010', '101011', '0100111', '0001100', '0001000', '0010111', '0000011', '0000100', '0101000', '0101011', '0010011', '0100100', '0011000', '00000010', '00000011', '00011010',
  '00011011', '00010010', '00010011', '00010100', '00010101', '00010110', '00010111', '00101000', '00101001', '00101010', '00101011', '00101100', '00101101', '00000100', '00000101', '00001010',
  '00001011', '01010010', '01010011', '01010100', '01010101', '00100100', '00100101', '01011000', '01011001', '01011010', '01011011', '01001010', '01001011', '00110010', '00110011', '00110100',
]
const WHITE_MAKEUP = [
  '11011', '10010', '010111', '0110111', '00110110', '00110111', '01100100', '01100101', '01101000', '01100111', '011001100', '011001101', '011010010', '011010011',
  '011010100', '011010101', '011010110', '011010111', '011011000', '011011001', '011011010', '011011011', '010011000', '010011001', '010011010', '011000', '010011011',
]
const BLACK_CODES = [
  '0000110111', '010', '11', '10', '011', '0011', '0010', '00011', '000101', '000100', '0000100', '0000101', '0000111', '00000100', '00000111', '000011000',
  '0000010111', '0000011000', '0000001000', '00001100111', '00001101000', '00001101100', '00000110111', '00000101000', '00000010111', '00000011000', '000011001010', '000011001011', '000011001100', '000011001101', '000001101000', '000001101001',
  '000001101010', '000001101011', '000011010010', '000011010011', '000011010100', '000011010101', '000011010110', '000011010111', '000001101100', '000001101101', '000011011010', '000011011011', '000001010100', '000001010101', '000001010110', '000001010111',
  '000001100100', '000001100101', '000001010010', '000001010011', '000000100100', '000000110111', '000000111000', '000000100111', '000000101000', '000001011000', '000001011001', '000000101011', '000000101100', '000001011010', '000001100110', '000001100111',
]
const BLACK_MAKEUP = [
  '0000001111', '000011001000', '000011001001', '000001011011', '000000110011', '000000110100', '000000110101', '0000001101100', '0000001101101', '0000001001010', '0000001001011', '0000001001100', '0000001001101', '0000001110010',
  '0000001110011', '0000001110100', '0000001110101', '0000001110110', '0000001110111', '0000001010010', '0000001010011', '0000001010100', '0000001010101', '0000001011010', '0000001011011', '0000001100100', '0000001100101',
]
const EXTENDED_MAKEUP = ['00000001000', '00000001100', '00000001101', '000000010010', '000000010011', '000000010100', '000000010101', '000000010110', '000000010111', '000000011100', '000000011101', '000000011110', '000000011111']

// Lookup keyed by (length << 16 | code value).
function buildTable(terminating, makeup) {
  const table = new Map()
  const add = (code, run) => table.set((code.length << 16) | parseInt(code, 2), run)
  terminating.forEach((code, run) => add(code, run))
  makeup.forEach((code, index) => add(code, (index + 1) * 64))
  EXTENDED_MAKEUP.forEach((code, index) => add(code, 1792 + index * 64))
  return table
}
const WHITE = buildTable(WHITE_CODES, WHITE_MAKEUP)
const BLACK = buildTable(BLACK_CODES, BLACK_MAKEUP)

const MODES = new Map([
  ['1', 'V0'], ['011', 'VR1'], ['010', 'VL1'], ['001', 'H'], ['0001', 'P'],
  ['000011', 'VR2'], ['000010', 'VL2'], ['0000011', 'VR3'], ['0000010', 'VL3'],
].map(([code, mode]) => [(code.length << 16) | parseInt(code, 2), mode]))
const VERTICAL = { V0: 0, VR1: 1, VL1: -1, VR2: 2, VL2: -2, VR3: 3, VL3: -3 }

export function decodeG4(data, width, height) {
  const out = new Uint8Array(width * height)
  const totalBits = data.length * 8
  let bit = 0
  const readBit = () => {
    const value = (data[bit >> 3] >> (7 - (bit & 7))) & 1
    bit++
    return value
  }
  const readCode = (table, maxLength) => {
    let code = 0
    for (let length = 1; length <= maxLength && bit < totalBits; length++) {
      code = (code << 1) | readBit()
      const value = table.get((length << 16) | code)
      if (value !== undefined) return value
    }
    return null
  }
  const readRun = (table) => {
    let total = 0
    for (;;) {
      const run = readCode(table, 13)
      if (run === null) return null
      total += run
      if (run < 64) return total
    }
  }

  let reference = [width, width] // all-white line above the first row
  for (let row = 0; row < height; row++) {
    const changes = []
    let a0 = -1
    let color = 0 // 0 white, 1 black
    let pointer = 0
    while (a0 < width) {
      const mode = readCode(MODES, 7)
      if (mode === null) return out // end of data (EOFB) or a damaged stream
      while (pointer > 0 && reference[pointer - 1] > a0) pointer--
      let i = pointer
      while (i < reference.length && (reference[i] <= a0 || (i & 1) !== color)) i++
      pointer = i
      const b1 = i < reference.length ? reference[i] : width
      const b2 = i + 1 < reference.length ? reference[i + 1] : width
      if (mode === 'P') {
        a0 = b2
      } else if (mode === 'H') {
        const start = a0 < 0 ? 0 : a0
        const first = readRun(color ? BLACK : WHITE)
        const second = readRun(color ? WHITE : BLACK)
        if (first === null || second === null) return out
        const a1 = Math.min(width, start + first)
        const a2 = Math.min(width, a1 + second)
        changes.push(a1, a2)
        a0 = a2
      } else {
        const a1 = Math.max(0, Math.min(width, b1 + VERTICAL[mode]))
        changes.push(a1)
        a0 = a1
        color ^= 1
      }
    }
    // Paint the black runs: changes alternate white→black, black→white.
    const offset = row * width
    for (let k = 0; k < changes.length; k += 2) {
      const start = changes[k]
      const end = k + 1 < changes.length ? changes[k + 1] : width
      out.fill(1, offset + start, offset + Math.min(end, width))
    }
    reference = changes.concat([width, width])
  }
  return out
}
