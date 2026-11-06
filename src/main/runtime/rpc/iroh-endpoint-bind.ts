import type { Endpoint, RelayMode } from '@number0/iroh'

export class IrohModuleLoadError extends Error {
  constructor(cause: unknown) {
    super('Iroh SDK could not be loaded; install a compatible native module and restart', {
      cause
    })
    this.name = 'IrohModuleLoadError'
  }
}

/** Lazily load the SDK and bind the selected relay; return null if already aborted. */
export async function bindIrohEndpoint(
  secretKey: number[],
  alpn: number[],
  relayUrl: string | null,
  signal: AbortSignal
): Promise<Endpoint | null> {
  // Why: static imports would load the native addon even in processes that never bind.
  let sdk: { Endpoint: typeof Endpoint; RelayMode: typeof RelayMode }
  try {
    sdk = await import('@number0/iroh')
    if (
      typeof sdk.Endpoint?.bind !== 'function' ||
      typeof sdk.RelayMode?.customFromUrls !== 'function'
    ) {
      throw new TypeError('Iroh SDK does not expose the required endpoint and relay APIs')
    }
  } catch (cause) {
    throw new IrohModuleLoadError(cause)
  }
  if (signal.aborted) {
    return null
  }
  return sdk.Endpoint.bind(
    { secretKey, alpns: [alpn] },
    relayUrl ? sdk.RelayMode.customFromUrls([relayUrl]) : undefined
  )
}

/** Read bounded pairing hints, returning null if the native endpoint is unavailable. */
export function readIrohEndpointDialHints(
  endpoint: Endpoint
): { relayUrl: string | null; directAddresses: string[] } | null {
  try {
    const addr = endpoint.addr()
    return {
      relayUrl: addr.relayUrl() ?? null,
      // Why: cap to keep the QR payload small; iroh ranks LAN addrs first.
      directAddresses: addr.directAddresses().slice(0, 8)
    }
  } catch {
    return null
  }
}
