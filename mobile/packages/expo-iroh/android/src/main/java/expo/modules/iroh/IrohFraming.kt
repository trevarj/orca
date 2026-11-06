package expo.modules.iroh

internal object IrohFraming {
  const val MAX_PAYLOAD = 1_048_576

  fun header(length: Int): ByteArray {
    require(length in 0..MAX_PAYLOAD) { "iroh_frame_too_large" }
    return byteArrayOf((length ushr 24).toByte(), (length ushr 16).toByte(), (length ushr 8).toByte(), length.toByte())
  }

  fun length(header: ByteArray): Int {
    require(header.size == 4) { "iroh_invalid_frame_header" }
    var length = 0
    for (byte in header) length = (length shl 8) or (byte.toInt() and 0xff)
    require(length in 0..MAX_PAYLOAD) { "iroh_frame_too_large" }
    return length
  }
}
