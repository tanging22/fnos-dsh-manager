#!/usr/bin/env node
/**
 * Generate the fnOS icon set from the whale artwork.
 *
 * Source: assets-src/deepseek-whale.png (512x512, the DeepSeek whale-girl
 * artwork the user picked). Everything else is derived from it:
 *
 *   ui/images/icon_{64,128,256}.png   — per-size suite icons referenced by
 *                                       ui/config ("images/icon_{0}.png")
 *   ICON.PNG / ICON_256.PNG          — package-root icons fnOS requires
 *   ui/assets/icon.png               — the web panel favicon / brand mark
 *
 * A native image binding would need a build toolchain on the NAS and CI, so
 * this is a tiny dependency-free PNG pipeline on node:zlib instead:
 *
 *   inflate -> defilter -> box-average downscale -> re-encode
 *
 * The committed PNGs were produced by this exact pipeline, so CI regenerates
 * byte-identical icons from the same source.
 */

import { deflateSync, inflateSync } from 'node:zlib'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// Two icon sources:
//   assets-src/deepseek-whale.png  — the cheerful winking whale-girl →
//       manager/dashboard icon (ui/images/icon_*.png, ICON.PNG, ICON_256.PNG,
//       ui/assets/icon.png)
//   assets-src/dsh-web.png         — the "天青色瞪眼鱼" artwork →
//       DeepSeek harness web desktop icon (ui/images/web_icon_*.png)
const SOURCES = {
  console: join(ROOT, 'assets-src', 'deepseek-whale.png'),
  web: join(ROOT, 'assets-src', 'dsh-web.png'),
}
const IMAGES_DIR = join(ROOT, 'ui', 'images')
const SIZES = [64, 128, 256]

/* ----------------------------------------------------------------- decode */

function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')

  const idat = []
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0

  let offset = 8
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)

    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }

  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth} (need 8)`)
  if (colorType !== 6) throw new Error(`unsupported color type ${colorType} (need RGBA)`)
  if (interlace !== 0) throw new Error('interlaced PNG is not supported')

  const stride = width * 4
  const raw = inflateSync(Buffer.concat(idat))
  const pixels = Buffer.alloc(width * height * 4)

  let position = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[position]
    position += 1
    const row = raw.subarray(position, position + stride)
    position += stride

    const out = y * stride
    for (let x = 0; x < stride; x += 1) {
      const value = row[x]
      const left = x >= 4 ? pixels[out + x - 4] : 0
      const up = y > 0 ? pixels[out - stride + x] : 0
      const upperLeft = x >= 4 && y > 0 ? pixels[out - stride + x - 4] : 0

      if (filter === 0) {
        pixels[out + x] = value
      } else if (filter === 1) {
        pixels[out + x] = (value + left) & 0xff
      } else if (filter === 2) {
        pixels[out + x] = (value + up) & 0xff
      } else if (filter === 3) {
        pixels[out + x] = (value + ((left + up) >> 1)) & 0xff
      } else if (filter === 4) {
        const p = left + up - upperLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upperLeft)
        pixels[out + x] = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upperLeft)
      } else {
        throw new Error(`unsupported filter ${filter}`)
      }
    }
  }

  return { width, height, pixels }
}

/* ---------------------------------------------------------------- resample */

/**
 * Box-average downscale: every destination pixel averages the source pixels
 * that fall inside it. For exact power-of-two halving steps from 512 this is
 * identical to a perfect 2x2 average and keeps the whale-girl lines crisp.
 */
function resizeBoxAverage({ width, height, pixels }, size) {
  const out = Buffer.alloc(size * size * 4)
  const xRatio = width / size
  const yRatio = height / size

  for (let y = 0; y < size; y += 1) {
    const srcY0 = Math.floor(y * yRatio)
    const srcY1 = Math.max(srcY0 + 1, Math.floor((y + 1) * yRatio))
    for (let x = 0; x < size; x += 1) {
      const srcX0 = Math.floor(x * xRatio)
      const srcX1 = Math.max(srcX0 + 1, Math.floor((x + 1) * xRatio))

      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let count = 0
      for (let sy = srcY0; sy < srcY1; sy += 1) {
        for (let sx = srcX0; sx < srcX1; sx += 1) {
          const p = (sy * width + sx) * 4
          r += pixels[p]
          g += pixels[p + 1]
          b += pixels[p + 2]
          a += pixels[p + 3]
          count += 1
        }
      }

      const o = (y * size + x) * 4
      out[o] = Math.round(r / count)
      out[o + 1] = Math.round(g / count)
      out[o + 2] = Math.round(b / count)
      out[o + 3] = Math.round(a / count)
    }
  }

  return out
}

/* ----------------------------------------------------------------- encode */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // truecolor with alpha

  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ------------------------------------------------------------------- main */

function renderSet(sourceFile, { sizes = SIZES, stem = 'icon', rootIcon = false } = {}) {
  const source = decodePng(readFileSync(sourceFile))
  if (source.width !== source.height) {
    throw new Error(`${sourceFile} is ${source.width}x${source.height}, need square`)
  }

  mkdirSync(IMAGES_DIR, { recursive: true })
  const outputs = []
  for (const size of sizes) {
    const png = encodePng(size, resizeBoxAverage(source, size))
    const target = join(IMAGES_DIR, `${stem}_${size}.png`)
    writeFileSync(target, png)
    outputs.push({ target, size, bytes: png.length })
    console.log(`wrote ${target} (${size}x${size}, ${png.length} bytes)`)
  }

  if (!rootIcon) return outputs

  /* fnOS wants package-level icons at the archive root, both sizes. */
  const icon64 = encodePng(64, resizeBoxAverage(source, 64))
  writeFileSync(join(ROOT, 'ICON.PNG'), icon64)
  console.log(`wrote ${join(ROOT, 'ICON.PNG')} (64x64, ${icon64.length} bytes)`)

  const icon256 = encodePng(256, resizeBoxAverage(source, 256))
  writeFileSync(join(ROOT, 'ICON_256.PNG'), icon256)
  writeFileSync(join(ROOT, 'ui', 'assets', 'icon.png'), icon256)
  console.log(`wrote ICON_256.PNG + ui/assets/icon.png (256x256, ${icon256.length} bytes)`)

  return outputs
}

/* Manager/dashboard icon: the winking whale-girl, drives the package icon too. */
renderSet(SOURCES.console, { stem: 'icon', rootIcon: true })

/* DeepSeek harness web icon: the "天青色瞪眼鱼" artwork, no package icons. */
renderSet(SOURCES.web, { stem: 'web_icon', rootIcon: false })
