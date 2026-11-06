import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeOs from 'node:os'

const { handleMock, networkInterfacesMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  networkInterfacesMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: handleMock },
  shell: { openExternal: vi.fn() }
}))

vi.mock('qrcode', () => ({
  default: {
    create: vi.fn().mockReturnValue({ modules: { size: 21 } }),
    toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,qr')
  }
}))

vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  networkInterfaces: networkInterfacesMock
}))

vi.mock('../runtime/windows-default-route-interfaces', () => ({
  getWindowsDefaultRouteInterfaceNames: vi.fn().mockResolvedValue(new Set())
}))

import { registerMobileHandlers } from './mobile'

describe('registerMobileHandlers iroh pairing', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    // No interfaces: iroh dials by key, so the offer must not need an address.
    networkInterfacesMock.mockReset().mockReturnValue({})
    handleMock.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
  })

  it.each([undefined, '100.64.1.20'])(
    'pairs Iroh without LAN setup (address: %s)',
    async (address) => {
      const createMobilePairingOffer = vi.fn().mockResolvedValue({
        available: true,
        pairingUrl: 'orca://pair#iroh',
        endpoint: `iroh://${'a'.repeat(64)}`,
        deviceId: 'mobile-iroh',
        connectionMode: 'iroh'
      })

      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The handler reads only the pairing offer and network bind host.
      registerMobileHandlers({
        createMobilePairingOffer,
        getNetworkExposureBindHost: () => '0.0.0.0'
      } as never)
      const result = await handlers.get('mobile:getPairingQR')?.(null, {
        address,
        connectionMode: 'iroh'
      })

      expect(createMobilePairingOffer).toHaveBeenCalledWith(
        expect.objectContaining({ address: null, connectionMode: 'iroh' })
      )
      expect(networkInterfacesMock).not.toHaveBeenCalled()
      expect(result).toMatchObject({ available: true, endpoint: `iroh://${'a'.repeat(64)}` })
    }
  )
})
