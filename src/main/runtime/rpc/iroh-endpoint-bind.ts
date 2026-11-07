import type { Endpoint, RelayMode } from '@number0/iroh'

type IrohModuleLoadReason =
  | 'MODULE_NOT_FOUND'
  | 'ERR_MODULE_NOT_FOUND'
  | 'ERR_DLOPEN_FAILED'
  | 'unsupported-api'
  | 'unknown'

/** Keep permanent SDK failures actionable without retaining potentially sensitive causes. */
export class IrohModuleLoadError extends Error {
  readonly reason: IrohModuleLoadReason

  /** Expose only known import codes or the explicit API compatibility stage. */
  constructor(cause: unknown, stage: 'import' | 'api' = 'import') {
    const code = cause instanceof Error && 'code' in cause ? cause.code : undefined
    const reason =
      stage === 'api'
        ? 'unsupported-api'
        : code === 'MODULE_NOT_FOUND' ||
            code === 'ERR_MODULE_NOT_FOUND' ||
            code === 'ERR_DLOPEN_FAILED'
          ? code
          : 'unknown'
    super(
      `Iroh SDK could not be loaded (${reason}); install a compatible native module and restart`
    )
    this.name = 'IrohModuleLoadError'
    this.reason = reason
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
  } catch (cause) {
    throw new IrohModuleLoadError(cause)
  }
  if (
    typeof sdk.Endpoint?.bind !== 'function' ||
    typeof sdk.RelayMode?.customFromUrls !== 'function'
  ) {
    throw new IrohModuleLoadError(undefined, 'api')
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
