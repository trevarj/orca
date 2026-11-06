// Length-prefixed framing for the iroh mobile transport.
// Wire: 4-byte big-endian u32 length + payload. Max frame 1 MiB.

export const IROH_MOBILE_RPC_ALPN = 'orca-mobile-rpc/1'
export const IROH_MAX_FRAME_BYTES = 1024 * 1024
export const IROH_LENGTH_PREFIX_BYTES = 4

export function encodeLengthPrefixedFrame(payload: Uint8Array): Buffer {
  if (payload.byteLength > IROH_MAX_FRAME_BYTES) {
    throw new Error(`iroh frame exceeds ${IROH_MAX_FRAME_BYTES} bytes`)
  }
  const out = Buffer.allocUnsafe(IROH_LENGTH_PREFIX_BYTES + payload.byteLength)
  out.writeUInt32BE(payload.byteLength, 0)
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(
    out,
    IROH_LENGTH_PREFIX_BYTES
  )
  return out
}

export type FrameDecoderCallbacks = {
  onFrame: (payload: Uint8Array) => void
  onOversize: (declaredLength: number) => void
}

// Incremental decoder for a single bi-stream. Rejects declared lengths above the cap.
export function createFrameDecoder(callbacks: FrameDecoderCallbacks): {
  feed: (chunk: Uint8Array) => void
  reset: () => void
} {
  const header = Buffer.allocUnsafe(IROH_LENGTH_PREFIX_BYTES)
  let headerBytes = 0
  let payload: Uint8Array | null = null
  let payloadBytes = 0

  return {
    feed(chunk: Uint8Array): void {
      let offset = 0
      while (offset < chunk.byteLength) {
        if (payload === null) {
          const count = Math.min(IROH_LENGTH_PREFIX_BYTES - headerBytes, chunk.byteLength - offset)
          header.set(chunk.subarray(offset, offset + count), headerBytes)
          headerBytes += count
          offset += count
          if (headerBytes < IROH_LENGTH_PREFIX_BYTES) {
            return
          }
          const length = header.readUInt32BE(0)
          headerBytes = 0
          if (length > IROH_MAX_FRAME_BYTES) {
            callbacks.onOversize(length)
            return
          }
          // Allocate once per bounded frame, not once per network fragment.
          payload = new Uint8Array(length)
        }
        const count = Math.min(payload.byteLength - payloadBytes, chunk.byteLength - offset)
        payload.set(chunk.subarray(offset, offset + count), payloadBytes)
        payloadBytes += count
        offset += count
        if (payloadBytes === payload.byteLength) {
          const complete = payload
          payload = null
          payloadBytes = 0
          callbacks.onFrame(complete)
        }
      }
    },
    reset(): void {
      headerBytes = 0
      payload = null
      payloadBytes = 0
    }
  }
}

// Why: WS text frames (JSON/base64) are ASCII; sealed binary frames are
// high-entropy, so sniffing recovers the WS text/binary flag without spending
// a wire tag — the orca-mobile-rpc/1 frame is length + payload on purpose.
export function decodeIrohFramePayload(payload: Uint8Array): string | Uint8Array {
  for (let i = 0; i < payload.byteLength; i++) {
    const byte = payload[i]!
    if (byte > 0x7e || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)) {
      return payload
    }
  }
  return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString('utf8')
}

export function encodeIrohFramePayload(
  data: string | Uint8Array | Buffer,
  _binary?: boolean
): Uint8Array {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data)
  }
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  return data
}
