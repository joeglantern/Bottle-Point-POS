// A shop's own colour in place of Bottle Point's brass, and the colours a
// logo suggests. The till's accents all come from a handful of CSS variables
// (styles.css); this writes them for the shop's colour, for the dark and the
// light theme, keeping text readable on both.

const BG = { dark: '#09090a', light: '#f4f0e7' }
const PAPER = { dark: '#101011', light: '#fffdf8' }

const hexToRgb = hex => {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const rgbToHex = ([r, g, b]) => '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h = 0, s = 0
  const l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    h /= 6
  }
  return [h, s, l]
}
function hslToRgb([h, s, l]) {
  if (s === 0) return [l * 255, l * 255, l * 255]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const f = t => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255]
}
const withLightness = (hex, l) => {
  const [h, s] = rgbToHsl(hexToRgb(hex))
  return rgbToHex(hslToRgb([h, s, Math.max(0, Math.min(1, l))]))
}
const lightness = hex => rgbToHsl(hexToRgb(hex))[2]

function luminance(hex) {
  const c = hexToRgb(hex).map(v => {
    v /= 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}

// Move the colour lighter (dark theme) or darker (light theme) until text in
// it is easy to read on the page.
function readableOn(hex, theme) {
  let l = lightness(hex)
  let out = hex
  for (let i = 0; i < 40; i++) {
    if (contrast(out, BG[theme]) >= 4.6 && contrast(out, PAPER[theme]) >= 4.5) return out
    l += theme === 'dark' ? 0.025 : -0.025
    out = withLightness(hex, l)
  }
  return theme === 'dark' ? '#f1ede4' : '#17140f'
}

export function brandVars(accent, theme) {
  const rgb = hexToRgb(accent)
  const l = lightness(accent)
  const onAccent = contrast('#111111', accent) >= contrast('#ffffff', accent) ? '#111111' : '#ffffff'
  return {
    '--gold': accent,
    '--gold-hi': withLightness(accent, Math.min(0.92, l + 0.16)),
    '--gold-deep': withLightness(accent, Math.max(0.05, l - 0.12)),
    '--gold-lo': theme === 'dark' ? withLightness(accent, Math.max(0.12, l - 0.22)) : withLightness(accent, Math.min(0.8, l + 0.15)),
    '--gold-text': readableOn(accent, theme),
    '--gold-rgb': rgb.join(', '),
    '--on-gold': onAccent,
    '--glow': `rgba(${rgb.join(', ')}, ${theme === 'dark' ? 0.13 : 0.16})`
  }
}

// Writes the shop's colour for both themes, or puts brass back (null).
export function applyBrand(accent) {
  let el = document.getElementById('bp-brand')
  if (!accent || !/^#[0-9a-f]{6}$/i.test(accent)) {
    el?.remove()
    return
  }
  if (!el) {
    el = document.createElement('style')
    el.id = 'bp-brand'
    document.head.appendChild(el)
  }
  const block = vars => Object.entries(vars).map(([k, v]) => `${k}: ${v};`).join(' ')
  el.textContent = `:root { ${block(brandVars(accent, 'dark'))} } :root[data-theme="light"] { ${block(brandVars(accent, 'light'))} }`
}

// The colours a logo suggests, most prominent first. Near white, near black
// and grey are skipped: they make poor accents.
export async function paletteFrom(src, max = 6) {
  const img = await loadImage(src)
  const size = 72
  const canvas = document.createElement('canvas')
  const scale = Math.min(1, size / Math.max(img.naturalWidth, img.naturalHeight))
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const bins = new Map()
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue
    const rgb = [data[i], data[i + 1], data[i + 2]]
    const [, s, l] = rgbToHsl(rgb)
    if (l > 0.92 || l < 0.08 || s < 0.18) continue
    const key = rgb.map(v => v >> 4).join(',')
    const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0, s }
    bin.n++
    bin.r += rgb[0]; bin.g += rgb[1]; bin.b += rgb[2]
    bins.set(key, bin)
  }
  const ranked = [...bins.values()]
    .map(b => ({ hex: rgbToHex([b.r / b.n, b.g / b.n, b.b / b.n]), score: b.n * (0.6 + b.s) }))
    .sort((a, b) => b.score - a.score)
  const picked = []
  for (const c of ranked) {
    const [r, g, b] = hexToRgb(c.hex)
    if (picked.every(p => { const [x, y, z] = hexToRgb(p); return Math.hypot(r - x, g - y, b - z) > 48 })) picked.push(c.hex)
    if (picked.length >= max) break
  }
  return picked
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('That image could not be read.'))
    img.src = src
  })
}

// Shrinks a chosen file to a logo the server accepts (at most 512 pixels a
// side, under 64 KB), keeping transparency.
export async function logoFromFile(file) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Choose a PNG, JPEG or WebP image.')
  // read as a data: address; the site's security policy does not allow blob: images
  const url = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('That file could not be read.'))
    reader.readAsDataURL(file)
  })
  {
    const img = await loadImage(url)
    for (const side of [512, 384, 256, 192]) {
      const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
      for (const [type, q] of [['image/webp', 0.9], ['image/png', undefined], ['image/webp', 0.75]]) {
        const data = canvas.toDataURL(type, q)
        if (!data.startsWith('data:' + type)) continue
        if ((data.length - data.indexOf(',') - 1) * 0.75 <= 64_000) return data
      }
    }
    throw new Error('That image is too detailed to use as a logo. Try a simpler or smaller file.')
  }
}
