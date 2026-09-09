import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const SOURCE = '/Users/asani/Documents/RANDOM/ANTICODE'

// ---------------------------------------------------------------------------
// 1. App icon — macOS grid: 824x824 content centred on a 1024x1024 canvas.
//
// The logo's rounded square spans x 248.6..1405.3, y 296..1452.7 (1156.7^2)
// inside a 1653.9x1748.8 viewBox. Crop to that square plus room for the
// 25-unit stroke, then render at the Apple icon size.
// ---------------------------------------------------------------------------

const ICON_SIDE = 824
const CANVAS = 1024
// Stroke-safe square centred on (826.95, 874.35).
const CROP = '233.6 281 1186.7 1186.7'

const anticodeSvg = await readFile(path.join(SOURCE, 'ANTICODE LOGO.svg'), 'utf8')
const sizedSvg = anticodeSvg.replace(
  'viewBox="0 0 1653.9 1748.8"',
  `width="${ICON_SIDE}" height="${ICON_SIDE}" viewBox="${CROP}"`
)

const inner = await sharp(Buffer.from(sizedSvg))
  .resize(ICON_SIDE, ICON_SIDE)
  .png()
  .toBuffer()

await sharp({
  create: {
    width: CANVAS,
    height: CANVAS,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 }
  }
})
  .composite([{ input: inner, left: (CANVAS - ICON_SIDE) / 2, top: (CANVAS - ICON_SIDE) / 2 }])
  .png()
  .toFile('build/icon.png')

console.log(`build/icon.png  ${CANVAS}x${CANVAS}, konten ${ICON_SIDE}x${ICON_SIDE}`)

// ---------------------------------------------------------------------------
// 2. Open-chat logo — detect the ink bounds by rasterising at 1:1, trimming
// the transparent border, then rewriting the viewBox to hug the artwork.
// ---------------------------------------------------------------------------

const chatSource = await readFile(path.join(SOURCE, 'OPEN CHAT LOGO.svg'), 'utf8')
const rendered = await sharp(
  Buffer.from(chatSource.replace('viewBox="0 0 1080 1080"', 'width="1080" height="1080"'))
)
  .png()
  .toBuffer()

const { info } = await sharp(rendered)
  .trim({ threshold: 0 })
  .toBuffer({ resolveWithObject: true })

const PAD = 8
// sharp reports negative offsets: the distance cropped from each edge.
const left = Math.abs(info.trimOffsetLeft) - PAD
const top = Math.abs(info.trimOffsetTop) - PAD
const width = info.width + PAD * 2
const height = info.height + PAD * 2
console.log(
  `bounds: x=${left} y=${top} w=${info.width} h=${info.height}`
)

const chatCropped = chatSource.replace(
  'viewBox="0 0 1080 1080"',
  `width="${width}" height="${height}" viewBox="${left} ${top} ${width} ${height}"`
)
const assetPath = 'src/renderer/src/assets/open-chat-logo.svg'
await writeFile(assetPath, chatCropped)
console.log(`${assetPath}  ${width}x${height}`)
