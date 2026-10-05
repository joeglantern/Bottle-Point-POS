import { useEffect, useRef } from 'react'

// USB and Bluetooth barcode scanners behave like a keyboard: they type the
// code very quickly and finish with Enter. People type far slower than that,
// so the gap between keys tells a scan apart from typing.
const MAX_GAP_MS = 35
const MIN_LENGTH = 6

export function useBarcodeScanner(onScan, enabled = true) {
  const buf = useRef('')
  const last = useRef(0)
  const cb = useRef(onScan)
  cb.current = onScan

  useEffect(() => {
    if (!enabled) return
    const onKey = e => {
      const now = performance.now()
      const gap = now - last.current
      last.current = now

      if (e.key === 'Enter') {
        const code = buf.current
        buf.current = ''
        if (code.length >= MIN_LENGTH) {
          e.preventDefault()
          e.stopPropagation()
          // the scanner also typed into whatever input had focus, clean it up
          const el = document.activeElement
          if (el && el.tagName === 'INPUT' && el.value.endsWith(code)) {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
            setter.call(el, el.value.slice(0, -code.length))
            el.dispatchEvent(new Event('input', { bubbles: true }))
          }
          cb.current(code)
        }
        return
      }

      if (e.key.length !== 1) return
      if (gap > MAX_GAP_MS) buf.current = ''
      buf.current += e.key
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [enabled])
}

export const cameraScanSupported = () => typeof window !== 'undefined' && 'BarcodeDetector' in window
