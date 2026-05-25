/**
 * Normalize the various shapes the renderer can receive a binary IPC payload as.
 *
 * Electron's structured clone over the contextBridge has historically delivered
 * the same Node Buffer as a Uint8Array, an ArrayBuffer, or a plain object with
 * numeric keys depending on the Electron version and the payload's backing
 * store. We need a Uint8Array so the Blob constructor gets an actual TypedArray
 * view (Blob silently produces 0 bytes for non-TypedArray inputs — which then
 * makes <img> go blank with no error).
 *
 * Returns null when the input can't be coerced to a byte view.
 *
 * Pure function, no DOM dependencies — safe to import from anywhere.
 */
export function normalizeFrameData(data: unknown): Uint8Array | null {
  if (data == null) return null
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  // Last-resort: plain object with numeric keys. Older Electron versions emit
  // this shape for small payloads from main → renderer.
  try {
    const vals = Object.values(data as Record<string, unknown>)
    if (vals.length > 0 && typeof vals[0] === 'number') {
      return new Uint8Array(vals as number[])
    }
  } catch { /* not iterable */ }
  return null
}
