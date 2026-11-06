import './rpc/unused-default-rpc-methods.test-fixture'
import type { Endpoint } from '@number0/iroh'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parsePairingCode } from '../../shared/pairing'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { readRuntimeMetadata } from './runtime-metadata'
import { STATUS_METHODS } from './rpc/methods/status'
import { sendRequest } from './runtime-rpc-test-harness'
import {
  authenticateMobileWsSession,
  createEncryptedWsResponseReader,
  sendEncryptedWsRequest,
  waitForWsClose
} from './runtime-rpc-mobile-ws-test-harness'

const ENDPOINT_ID = 'd'.repeat(64)

function controlledEndpoint(
  actualRelayUrl: string,
  online: Promise<void> = Promise.resolve(),
  closing: Promise<void> = Promise.resolve()
) {
  const accepted = Promise.withResolvers<null>()
  const onlineStarted = Promise.withResolvers<void>()
  const closeStarted = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<void>()
  const close = vi.fn(async () => {
    closeStarted.resolve()
    accepted.resolve(null)
    await closing
    closed.resolve()
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The double implements the endpoint operations consumed by IrohTransport, including online ownership and actual address hints.
  const endpoint = {
    online: async () => {
      onlineStarted.resolve()
      await online
    },
    id: () => ({ toString: () => ENDPOINT_ID }),
    acceptNext: () => accepted.promise,
    close,
    addr: () => ({ relayUrl: () => actualRelayUrl, directAddresses: () => [] })
  } as unknown as Endpoint
  return { endpoint, endpointId: ENDPOINT_ID, onlineStarted, closeStarted, closed, close }
}

describe('runtime Iroh home relay replacement', () => {
  it('publishes working local and WS endpoints while initial relay readiness is pending', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-iroh-relay-'))
    const online = Promise.withResolvers<void>()
    const initial = controlledEndpoint('https://unreachable.relay.test/', online.promise)
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      methods: STATUS_METHODS,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0,
      irohBindEndpoint: async () => initial
    })
    let startupSettled = false
    const startup = server.start().then(() => {
      startupSettled = true
    })
    try {
      await initial.onlineStarted.promise
      const turn = Promise.withResolvers<void>()
      setImmediate(turn.resolve)
      await turn.promise
      expect(startupSettled).toBe(true)
      await startup
      expect(server.getIrohStatus().bound).toBe(false)
      const metadata = readRuntimeMetadata(userDataPath)!
      expect(metadata.transports.map((transport) => transport.kind)).not.toContain('iroh')
      await expect(
        sendRequest(metadata.transports[0]!.endpoint, {
          id: 'cli-without-relay',
          authToken: metadata.authToken,
          method: 'status.get'
        })
      ).resolves.toMatchObject({ ok: true })
      const offer = server.createPairingOffer({ address: '127.0.0.1', scope: 'runtime' })
      if (!offer.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      const session = await authenticateMobileWsSession(offer.pairingUrl)
      session.ws.close()
      await waitForWsClose(session.ws)

      const pendingQr = server.createMobilePairingOffer({ connectionMode: 'iroh' })
      await server.stop()
      await expect(pendingQr).resolves.toMatchObject({
        available: false,
        reason: 'iroh_unavailable'
      })
      expect(initial.close).toHaveBeenCalledOnce()
    } finally {
      online.resolve()
      await startup
      await server.stop()
    }
  })

  it('refreshes actual QR hints without rotating credentials or disturbing authenticated WS and CLI', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-iroh-relay-'))
    const nextOnline = Promise.withResolvers<void>()
    const endpoints = [
      controlledEndpoint('https://reported-old.relay.test/'),
      controlledEndpoint('https://reported-new.relay.test/', nextOnline.promise)
    ]
    let binding = 0
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      methods: STATUS_METHODS,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0,
      irohRelayUrl: 'https://configured-old.relay.test/',
      irohBindEndpoint: async () => endpoints[binding++]!
    })
    await server.start()
    try {
      const registry = server.getDeviceRegistry()!
      const paired = registry.addDevice('Already paired phone', 'mobile')
      registry.updateLastSeen(paired.deviceId)
      const pairedBefore = registry.getDevice(paired.deviceId)
      const wiring = server.getMobileSocketWiring()
      const e2ee = server.getE2EEKeypair()
      const endpointSecret = readFileSync(join(userDataPath, 'orca-iroh-endpoint-secret.json'))
      const oldOffer = await server.createMobilePairingOffer({ connectionMode: 'iroh' })
      if (!oldOffer.available) {
        throw new Error('Initial Iroh pairing unavailable')
      }
      const oldCode = parsePairingCode(oldOffer.pairingUrl)!
      expect(oldCode.iroh?.relayUrl).toBe('https://reported-old.relay.test/')

      const wsOffer = server.createPairingOffer({ address: '127.0.0.1', scope: 'runtime' })
      if (!wsOffer.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      const session = await authenticateMobileWsSession(wsOffer.pairingUrl)
      const responses = createEncryptedWsResponseReader(session)
      try {
        const wsEndpoint = server.getWebSocketEndpoint()
        const metadata = readRuntimeMetadata(userDataPath)!
        const rebind = server.setIrohRelayUrl('https://configured-new.relay.test/')
        expect(server.getIrohStatus()).toEqual({ bound: false, endpointId: null, relayUrl: null })
        let qrSettled = false
        const freshOffer = server.createMobilePairingOffer({
          connectionMode: 'iroh',
          rotate: false
        })
        void freshOffer.then(() => {
          qrSettled = true
        })
        await endpoints[1]!.onlineStarted.promise
        expect(qrSettled).toBe(false)

        sendEncryptedWsRequest(session, { id: 'while-rebinding', method: 'status.get' })
        await expect(responses.next('while-rebinding')).resolves.toMatchObject({ ok: true })
        await expect(
          sendRequest(metadata.transports[0]!.endpoint, {
            id: 'cli-while-rebinding',
            authToken: metadata.authToken,
            method: 'status.get'
          })
        ).resolves.toMatchObject({ ok: true })

        nextOnline.resolve()
        await rebind
        const offer = await freshOffer
        if (!offer.available) {
          throw new Error('Replacement Iroh pairing unavailable')
        }
        const code = parsePairingCode(offer.pairingUrl)!
        expect(code.iroh).toEqual({
          endpointId: ENDPOINT_ID,
          relayUrl: 'https://reported-new.relay.test/'
        })
        expect(code.deviceToken).toBe(oldCode.deviceToken)
        expect(code.publicKeyB64).toBe(oldCode.publicKeyB64)
        expect(offer.deviceId).toBe(oldOffer.deviceId)
        expect(server.getIrohStatus()).toEqual({
          bound: true,
          endpointId: ENDPOINT_ID,
          relayUrl: 'https://reported-new.relay.test/'
        })
        expect(server.getDeviceRegistry()).toBe(registry)
        expect(registry.getDevice(paired.deviceId)).toEqual(pairedBefore)
        expect(server.getMobileSocketWiring()).toBe(wiring)
        expect(server.getE2EEKeypair()).toBe(e2ee)
        expect(readFileSync(join(userDataPath, 'orca-iroh-endpoint-secret.json'))).toEqual(
          endpointSecret
        )
        expect(server.getWebSocketEndpoint()).toBe(wsEndpoint)
        expect(readRuntimeMetadata(userDataPath)).toEqual(metadata)
        expect(session.ws.readyState).toBe(session.ws.OPEN)
        expect(endpoints[0]!.close).toHaveBeenCalledOnce()
        sendEncryptedWsRequest(session, { id: 'after-rebinding', method: 'status.get' })
        await expect(responses.next('after-rebinding')).resolves.toMatchObject({ ok: true })
      } finally {
        nextOnline.resolve()
        responses.dispose()
        session.ws.close()
        await waitForWsClose(session.ws)
      }
    } finally {
      nextOnline.resolve()
      await server.stop()
    }
  })

  it('applies a changed preference following a synchronous no-op update', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-iroh-relay-'))
    const endpoints = [
      controlledEndpoint('https://initial-actual.relay.test/'),
      controlledEndpoint('https://next-actual.relay.test/')
    ]
    let binding = 0
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      methods: [],
      userDataPath,
      enableWebSocket: true,
      wsPort: 0,
      irohRelayUrl: 'https://initial-setting.relay.test/',
      irohBindEndpoint: async () => endpoints[binding++]!
    })
    await server.start()
    await server.setIrohRelayUrl('https://initial-setting.relay.test/')
    try {
      const unchanged = server.setIrohRelayUrl('https://initial-setting.relay.test/')
      const changed = server.setIrohRelayUrl('https://next-setting.relay.test/')
      await Promise.all([unchanged, changed])
      expect(binding).toBe(2)
      expect(server.getIrohStatus()).toEqual({
        bound: true,
        endpointId: ENDPOINT_ID,
        relayUrl: 'https://next-actual.relay.test/'
      })
      const offer = await server.createMobilePairingOffer({ connectionMode: 'iroh' })
      if (!offer.available) {
        throw new Error('Replacement Iroh pairing unavailable')
      }
      expect(parsePairingCode(offer.pairingUrl)?.iroh?.relayUrl).toBe(
        'https://next-actual.relay.test/'
      )
    } finally {
      await server.stop()
    }
  })

  it('does not let an older held Iroh QR revoke a newer LAN pairing credential', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-iroh-relay-'))
    const nextOnline = Promise.withResolvers<void>()
    const endpoints = [
      controlledEndpoint('https://initial.relay.test/'),
      controlledEndpoint('https://next.relay.test/', nextOnline.promise)
    ]
    let binding = 0
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      methods: [],
      userDataPath,
      enableWebSocket: true,
      wsPort: 0,
      irohBindEndpoint: async () => endpoints[binding++]!
    })
    await server.start()
    await server.setIrohRelayUrl(null)
    try {
      const rebind = server.setIrohRelayUrl('https://next-setting.relay.test/')
      await endpoints[1]!.onlineStarted.promise
      const staleIroh = server.createMobilePairingOffer({ connectionMode: 'iroh' })
      const lanOffer = await server.createMobilePairingOffer({
        connectionMode: 'local-only',
        address: '127.0.0.1'
      })
      if (!lanOffer.available) {
        throw new Error('Newer LAN pairing unavailable')
      }
      const lanCode = parsePairingCode(lanOffer.pairingUrl)!
      const registry = server.getDeviceRegistry()!
      expect(registry.validateToken(lanCode.deviceToken)?.deviceId).toBe(lanOffer.deviceId)
      nextOnline.resolve()
      await rebind
      await expect(staleIroh).resolves.toMatchObject({ available: false })
      expect(registry.validateToken(lanCode.deviceToken)?.deviceId).toBe(lanOffer.deviceId)
      expect(registry.getMobilePairingConnectionMode(lanOffer.deviceId)).toBe('local-only')
      const session = await authenticateMobileWsSession(lanOffer.pairingUrl)
      session.ws.close()
      await waitForWsClose(session.ws)
    } finally {
      nextOnline.resolve()
      await server.stop()
    }
  })

  it('coalesces rapid changes and never publishes a superseded online completion', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-iroh-relay-'))
    const staleOnline = Promise.withResolvers<void>()
    const endpoints = [
      controlledEndpoint('https://initial.relay.test/'),
      controlledEndpoint('https://stale.relay.test/', staleOnline.promise),
      controlledEndpoint('https://latest-actual.relay.test/')
    ]
    let binding = 0
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      methods: [],
      userDataPath,
      enableWebSocket: true,
      wsPort: 0,
      irohBindEndpoint: async () => endpoints[binding++]!
    })
    await server.start()
    await server.setIrohRelayUrl(null)
    try {
      const firstChange = server.setIrohRelayUrl('https://first.relay.test/')
      await endpoints[1]!.onlineStarted.promise
      const offer = server.createMobilePairingOffer({ connectionMode: 'iroh' })
      const skippedChange = server.setIrohRelayUrl('https://skipped.relay.test/')
      const latestChange = server.setIrohRelayUrl('https://latest.relay.test/')
      await Promise.all([firstChange, skippedChange, latestChange])
      expect(binding).toBe(3)
      expect(endpoints[1]!.close).toHaveBeenCalledOnce()
      const qr = await offer
      if (!qr.available) {
        throw new Error('Latest Iroh pairing unavailable')
      }
      expect(parsePairingCode(qr.pairingUrl)?.iroh?.relayUrl).toBe(
        'https://latest-actual.relay.test/'
      )
      staleOnline.resolve()
      await endpoints[1]!.closed.promise
      expect(server.getIrohStatus().relayUrl).toBe('https://latest-actual.relay.test/')
      expect(endpoints[2]!.close).not.toHaveBeenCalled()
    } finally {
      staleOnline.resolve()
      await server.stop()
    }
  })

  it('fails closed on an explicit relay error, rejects invalid changes, and can recover', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-iroh-relay-'))
    const failedOnline = Promise.withResolvers<void>()
    const endpoints = [
      controlledEndpoint('https://initial.relay.test/'),
      controlledEndpoint('https://unavailable.relay.test/', failedOnline.promise),
      controlledEndpoint('https://recovered.relay.test/')
    ]
    let binding = 0
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      methods: [],
      userDataPath,
      enableWebSocket: true,
      wsPort: 0,
      irohBindEndpoint: async () => endpoints[binding++]!
    })
    await server.start()
    try {
      const initial = await server.createMobilePairingOffer({ connectionMode: 'iroh' })
      if (!initial.available) {
        throw new Error('Initial Iroh pairing unavailable')
      }
      const invalid = 'https://user:secret@relay.test/private'
      let validationMessage = ''
      try {
        server.setIrohRelayUrl(invalid)
      } catch (error) {
        validationMessage = error instanceof Error ? error.message : String(error)
      }
      expect(validationMessage).not.toBe('')
      expect(validationMessage).not.toContain('secret')
      expect(validationMessage).not.toContain(invalid)
      expect(server.getIrohStatus().bound).toBe(true)
      const change = server.setIrohRelayUrl('https://unavailable.relay.test/')
      await endpoints[1]!.onlineStarted.promise
      failedOnline.reject(new Error('Relay unavailable'))
      await change
      expect(binding).toBe(2)
      expect(endpoints[1]!.close).toHaveBeenCalledOnce()
      expect(server.getIrohStatus()).toEqual({ bound: false, endpointId: null, relayUrl: null })
      await expect(
        server.createMobilePairingOffer({ connectionMode: 'iroh' })
      ).resolves.toMatchObject({
        available: false,
        reason: 'iroh_unavailable'
      })
      expect(server.getDeviceRegistry()?.getPendingDevice('mobile')?.deviceId).toBe(
        initial.deviceId
      )
      await server.setIrohRelayUrl(null)
      const recovered = await server.createMobilePairingOffer({
        connectionMode: 'iroh',
        rotate: false
      })
      if (!recovered.available) {
        throw new Error('Recovered Iroh pairing unavailable')
      }
      expect(parsePairingCode(recovered.pairingUrl)?.deviceToken).toBe(
        parsePairingCode(initial.pairingUrl)?.deviceToken
      )
      expect(server.getIrohStatus().relayUrl).toBe('https://recovered.relay.test/')
    } finally {
      await server.stop()
    }
  })

  it('joins an owned endpoint close during supersession and shutdown', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-iroh-relay-'))
    const pendingOnline = Promise.withResolvers<void>()
    const pendingClose = Promise.withResolvers<void>()
    const endpoints = [
      controlledEndpoint('https://initial.relay.test/'),
      controlledEndpoint('https://closing.relay.test/', pendingOnline.promise, pendingClose.promise)
    ]
    let binding = 0
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      methods: [],
      userDataPath,
      enableWebSocket: true,
      wsPort: 0,
      irohBindEndpoint: async () => endpoints[binding++]!
    })
    await server.start()
    await server.setIrohRelayUrl(null)
    const firstChange = server.setIrohRelayUrl('https://closing-setting.relay.test/')
    await endpoints[1]!.onlineStarted.promise
    const latestChange = server.setIrohRelayUrl('https://latest-setting.relay.test/')
    await endpoints[1]!.closeStarted.promise
    let changeSettled = false
    let shutdownSettled = false
    void latestChange.then(() => {
      changeSettled = true
    })
    const shutdown = server.stop()
    void shutdown.then(() => {
      shutdownSettled = true
    })
    try {
      // Allow shutdown and supersession continuations to run while native close remains held.
      const turn = Promise.withResolvers<void>()
      setImmediate(turn.resolve)
      await turn.promise
      expect(changeSettled).toBe(false)
      expect(shutdownSettled).toBe(false)
      expect(endpoints[1]!.close).toHaveBeenCalledOnce()
      expect(server.getIrohStatus()).toEqual({ bound: false, endpointId: null, relayUrl: null })
      pendingClose.resolve()
      await Promise.all([firstChange, latestChange, shutdown])
      expect(changeSettled).toBe(true)
      expect(shutdownSettled).toBe(true)
      expect(endpoints[1]!.close).toHaveBeenCalledOnce()
      expect(binding).toBe(2)
    } finally {
      pendingOnline.resolve()
      pendingClose.resolve()
      await server.stop()
    }
  })

  it('fences shutdown during bind, closes late ownership, and releases settings listeners once', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-iroh-relay-'))
    const pendingBind = Promise.withResolvers<{ endpoint: Endpoint; endpointId: string }>()
    const bindStarted = Promise.withResolvers<void>()
    const late = controlledEndpoint('https://late.relay.test/')
    const listeners = new Set<() => void>()
    let stopped = 0
    let binds = 0
    const settingsChanged = () => {
      void server.setIrohRelayUrl('https://new.relay.test/')
    }
    listeners.add(settingsChanged)
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      methods: STATUS_METHODS,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0,
      irohBindEndpoint: () => {
        binds += 1
        bindStarted.resolve()
        return pendingBind.promise
      },
      onStop: () => {
        stopped += 1
        listeners.delete(settingsChanged)
      }
    })
    const start = server.start()
    await bindStarted.promise
    await start
    const metadata = readRuntimeMetadata(userDataPath)!
    const request = {
      id: 'while-native-bind-pending',
      authToken: metadata.authToken,
      method: 'status.get'
    }
    await expect(sendRequest(metadata.transports[0]!.endpoint, request)).resolves.toMatchObject({
      ok: true
    })
    await server.stop()
    expect(listeners.size).toBe(0)
    expect(stopped).toBe(1)
    // Shutdown leaves shared discovery metadata intact but must close the advertised listeners.
    expect(readRuntimeMetadata(userDataPath)).toEqual(metadata)
    await expect(sendRequest(metadata.transports[0]!.endpoint, request)).rejects.toBeInstanceOf(
      Error
    )
    expect(server.getWebSocketEndpoint()).toBeNull()
    expect(server.getIrohStatus()).toEqual({ bound: false, endpointId: null, relayUrl: null })
    pendingBind.resolve(late)
    await late.closed.promise
    expect(late.close).toHaveBeenCalledOnce()
    await server.setIrohRelayUrl('https://after-stop.relay.test/')
    await server.stop()
    expect(binds).toBe(1)
    expect(stopped).toBe(1)
  })
})
