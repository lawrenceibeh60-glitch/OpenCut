export type Lut3D = {
  id: string
  size: number
  data: Float32Array
  domainMin: [number, number, number]
  domainMax: [number, number, number]
}

/** Parse the common .cube 3D LUT format. Red is the fastest-changing axis. */
export function parseCubeLut(source: string, id = 'custom-lut'): Lut3D {
  let size = 0
  let domainMin: [number, number, number] = [0, 0, 0]
  let domainMax: [number, number, number] = [1, 1, 1]
  const rows: number[][] = []
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const parts = line.split(/\s+/)
    const directive = parts[0].toUpperCase()
    if (directive === 'TITLE') continue
    if (directive === 'LUT_1D_SIZE') throw new Error('1D .cube LUTs are not supported; use a 3D LUT')
    if (directive === 'LUT_3D_SIZE') {
      const parsed = Number(parts[1])
      if (!Number.isInteger(parsed) || parsed < 2 || parsed > 64) throw new Error('3D LUT size must be an integer from 2 to 64')
      size = parsed
      continue
    }
    if (directive === 'DOMAIN_MIN' || directive === 'DOMAIN_MAX') {
      if (parts.length !== 4) throw new Error(directive + ' requires three numeric values')
      const values = parts.slice(1).map(Number)
      if (!values.every(Number.isFinite)) throw new Error(directive + ' contains an invalid number')
      if (directive === 'DOMAIN_MIN') domainMin = values as [number, number, number]
      else domainMax = values as [number, number, number]
      continue
    }
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(parts[0])) {
      if (parts.length !== 3) throw new Error('Each LUT data row must contain exactly three channels')
      const values = parts.map(Number)
      if (!values.every(Number.isFinite)) throw new Error('LUT data contains a non-finite value')
      rows.push(values)
      continue
    }
    throw new Error('Unsupported .cube directive: ' + parts[0])
  }
  if (!size) throw new Error('The .cube file is missing LUT_3D_SIZE')
  if (domainMin.some((value, index) => !Number.isFinite(value)) || domainMax.some((value, index) => !Number.isFinite(value) || domainMin[index] >= value)) throw new Error('LUT domain minimum must be lower than its maximum')
  const expected = size * size * size
  if (rows.length !== expected) throw new Error(`LUT data count mismatch: expected ${expected} RGB rows, found ${rows.length}`)
  const data = new Float32Array(expected * 4)
  rows.forEach((rgb, index) => {
    const offset = index * 4
    data[offset] = rgb[0]
    data[offset + 1] = rgb[1]
    data[offset + 2] = rgb[2]
    data[offset + 3] = 1
  })
  return { id, size, data, domainMin, domainMax }
}
