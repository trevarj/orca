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
