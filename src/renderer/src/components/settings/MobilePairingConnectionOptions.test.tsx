// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { StrictMode, useSyncExternalStore } from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileRelayStatusDetail } from '../../../../shared/mobile-relay-status'
import type {
  OrcaCloudSignInProgress,
  OrcaProfileAuthStatus
} from '../../../../shared/orca-profiles'
import { MobilePairingConnectionOptions } from './MobilePairingConnectionOptions'

type MobileRelayStoreState = {
  orcaProfileAuthStatus: OrcaProfileAuthStatus | null
  orcaProfileSignInProgress?: OrcaCloudSignInProgress | null
  connectCurrentOrcaProfile: () => Promise<null>
  fetchOrcaProfileAuthStatus: () => Promise<OrcaProfileAuthStatus | null>
  settings: { mobileIrohRelayUrl: string | null }
  updateSettingsOrThrow: (patch: { mobileIrohRelayUrl: string | null }) => Promise<void>
}

const mocks = vi.hoisted(() => ({
  state: {} as MobileRelayStoreState,
  listeners: new Set<() => void>()
}))

// Use a subscribable mock so auth rereads reach the mounted tree rather than disappear into mutable selector state.
vi.mock('../../store', () => ({
  useAppStore: (selector: (state: MobileRelayStoreState) => unknown) =>
    useSyncExternalStore(
      (onStoreChange) => {
        mocks.listeners.add(onStoreChange)
        return () => mocks.listeners.delete(onStoreChange)
      },
      () => selector(mocks.state)
    )
}))

function publishStoreState(next: MobileRelayStoreState): void {
  mocks.state = next
  mocks.listeners.forEach((listener) => listener())
}

vi.mock('../../i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

describe('MobilePairingConnectionOptions', () => {
  let statusListener: ((detail: MobileRelayStatusDetail) => void) | null
  const connect = vi.fn().mockResolvedValue(null)
  const fetchAuthStatus = vi.fn().mockResolvedValue(null)
  const getIrohStatus = vi.fn()
  const updateSettingsOrThrow = vi.fn()

  beforeEach(() => {
    statusListener = null
    connect.mockClear()
    fetchAuthStatus.mockClear()
    getIrohStatus.mockReset()
    getIrohStatus.mockResolvedValue({ bound: false, endpointId: null, relayUrl: null })
    updateSettingsOrThrow.mockReset().mockImplementation(async (patch) => {
      publishStoreState({ ...mocks.state, settings: { ...mocks.state.settings, ...patch } })
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        mobile: {
          getRelayStatus: vi.fn().mockResolvedValue({ status: 'registered' }),
          getIrohStatus,
          onRelayStatusChanged: vi.fn((listener: (detail: MobileRelayStatusDetail) => void) => {
            statusListener = listener
            return vi.fn()
          })
        },
        shell: { openUrl: vi.fn().mockResolvedValue(undefined) }
      }
    })
    mocks.state = {
      settings: { mobileIrohRelayUrl: null },
      updateSettingsOrThrow,
      orcaProfileAuthStatus: {
        activeProfileId: 'profile-1',
        configured: true,
        state: 'local',
        persistence: 'none'
      },
      connectCurrentOrcaProfile: connect,
      fetchOrcaProfileAuthStatus: fetchAuthStatus
    }
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('shows Sign in directly under Orca Relay, above LAN', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<MobilePairingConnectionOptions value="automatic" onChange={onChange} />)

    const relay = screen.getByRole('radio', { name: /Orca Relay/i })
    const lan = screen.getByRole('radio', { name: /^LAN\b/i })
    const signInPanel = screen.getByTestId('anywhere-sign-in-panel')
    const signIn = screen.getByRole('button', { name: 'Sign in for Relay' })
    expect(signInPanel).toBeVisible()
    expect(
      screen.getByText(/Signs this desktop in to Orca and routes the phone through Orca’s servers/)
    ).toBeVisible()
    expect(
      relay.compareDocumentPosition(signInPanel) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(signInPanel.compareDocumentPosition(lan) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Keep layout role-less: radiogroups own radios only, and extra labels would double-announce Sign in.
    const group = screen.getByRole('radiogroup')
    expect(within(group).queryAllByRole('group')).toHaveLength(0)
    expect(within(group).getAllByRole('radio')).toHaveLength(3)
    expect(signInPanel).not.toHaveAttribute('aria-label')
    expect(screen.queryByText(/not configured for this build/i)).toBeNull()

    await user.click(signIn)
    expect(connect).toHaveBeenCalledOnce()
  })

  it('greys out Sign in and offers Copy and Cancel while the browser wait is open', async () => {
    const user = userEvent.setup()
    const link = 'https://login.example/authorize?state=abc'
    const writeClipboardText = vi.fn().mockResolvedValue(undefined)
    const cancelSignIn = vi.fn().mockResolvedValue(undefined)
    Object.assign(window.api, { ui: { writeClipboardText }, orcaProfiles: { cancelSignIn } })
    render(<MobilePairingConnectionOptions value="automatic" onChange={vi.fn()} />)

    publishStoreState({ ...mocks.state, orcaProfileSignInProgress: { link } })
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Waiting for sign-in in your browser'
    )
    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Copy sign-in link' }))
    expect(writeClipboardText).toHaveBeenCalledWith(link)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(cancelSignIn).toHaveBeenCalledOnce()
  })

  it('hides Sign in when LAN is selected', () => {
    render(<MobilePairingConnectionOptions value="local-only" onChange={vi.fn()} />)
    expect(screen.queryByTestId('anywhere-sign-in-panel')).toBeNull()
    expect(screen.queryByRole('button', { name: /Sign in/i })).toBeNull()
  })

  it('shows Unavailable instead of a dead Sign in on unconfigured builds', () => {
    mocks.state = {
      ...mocks.state,
      orcaProfileAuthStatus: {
        activeProfileId: 'profile-1',
        configured: false,
        state: 'unconfigured',
        persistence: 'none'
      }
    }
    render(<MobilePairingConnectionOptions value="automatic" onChange={vi.fn()} />)

    expect(screen.queryByTestId('anywhere-sign-in-panel')).toBeNull()
    expect(screen.queryByRole('button', { name: /Sign in/i })).toBeNull()
    const relay = screen.getByRole('radio', { name: /Orca Relay/i })
    expect(relay).toHaveTextContent('Unavailable')
    expect(relay).toHaveTextContent(/isn’t available in this build/i)
  })

  it('keeps Relay unavailable and unselectable while LAN is selected', async () => {
    mocks.state = {
      ...mocks.state,
      orcaProfileAuthStatus: {
        activeProfileId: 'profile-1',
        configured: false,
        state: 'unconfigured',
        persistence: 'none'
      }
    }
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<MobilePairingConnectionOptions value="local-only" onChange={onChange} />)

    // Availability follows the build, not the selected path.
    const relay = screen.getByRole('radio', { name: /Orca Relay/i })
    expect(relay).toHaveTextContent('Unavailable')
    expect(relay).toHaveTextContent(/isn’t available in this build/i)
    expect(relay).toHaveAttribute('aria-disabled', 'true')

    await user.click(relay)
    expect(onChange).not.toHaveBeenCalled()

    screen.getByRole('radio', { name: /^LAN\b/i }).focus()
    await user.keyboard('{ArrowUp}')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('moves selection with the arrow keys as a radiogroup', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<MobilePairingConnectionOptions value="automatic" onChange={onChange} />)

    screen.getByRole('radio', { name: /Orca Relay/i }).focus()
    await user.keyboard('{ArrowDown}')
    expect(onChange).toHaveBeenCalledWith('local-only')
  })

  it('does not change path when arrow keys hit the Sign in control', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<MobilePairingConnectionOptions value="automatic" onChange={onChange} />)

    screen.getByRole('button', { name: 'Sign in for Relay' }).focus()
    await user.keyboard('{ArrowDown}')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('selects a path from the compact list', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<MobilePairingConnectionOptions value="local-only" onChange={onChange} />)

    expect(
      screen.getByText('Phone can be on cellular or any Wi‑Fi. Sign-in required for Relay only.')
    ).toBeVisible()
    expect(
      screen.getByText(
        'Phone must be on this Wi‑Fi or connected through Tailscale. No account needed.'
      )
    ).toBeVisible()

    await user.click(screen.getByRole('radio', { name: /Orca Relay/i }))
    expect(onChange).toHaveBeenCalledWith('automatic')
  })

  it('refreshes auth status when it is missing on mount', () => {
    mocks.state = {
      ...mocks.state,
      orcaProfileAuthStatus: null
    }
    render(<MobilePairingConnectionOptions value="automatic" onChange={vi.fn()} />)
    expect(fetchAuthStatus).toHaveBeenCalledOnce()
    expect(screen.getByTestId('anywhere-sign-in-panel')).toBeVisible()
  })

  it('shows relay status when signed in on Orca Relay', async () => {
    mocks.state = {
      ...mocks.state,
      orcaProfileAuthStatus: {
        activeProfileId: 'profile-1',
        configured: true,
        state: 'connected',
        persistence: 'encrypted'
      },
      connectCurrentOrcaProfile: connect,
      fetchOrcaProfileAuthStatus: fetchAuthStatus
    }
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<MobilePairingConnectionOptions value="automatic" onChange={onChange} />)

    await waitFor(() => expect(screen.getByText('Ready')).toBeVisible())
    expect(screen.queryByTestId('anywhere-sign-in-panel')).toBeNull()

    await user.click(screen.getByRole('radio', { name: /^LAN\b/i }))
    expect(onChange).toHaveBeenCalledWith('local-only')
    statusListener?.({ status: 'standby' })
  })

  it('names the assigned relay cell by host once the status carries one', async () => {
    mocks.state = {
      ...mocks.state,
      orcaProfileAuthStatus: {
        activeProfileId: 'profile-1',
        configured: true,
        state: 'connected',
        persistence: 'encrypted'
      }
    }
    render(<MobilePairingConnectionOptions value="automatic" onChange={vi.fn()} />)

    expect(screen.queryByTestId('relay-cell-line')).toBeNull()

    statusListener?.({ status: 'registered', cellUrl: 'https://c27.relay.example.test' })

    await waitFor(() =>
      expect(screen.getByTestId('relay-cell-line')).toHaveTextContent(
        'Relay cell: c27.relay.example.test'
      )
    )
    // Why: the line is a diagnostic, not an option; it must not join the group (Relay, LAN, Iroh).
    expect(within(screen.getByRole('radiogroup')).getAllByRole('radio')).toHaveLength(3)

    statusListener?.({ status: 'offline' })
    await waitFor(() => expect(screen.queryByTestId('relay-cell-line')).toBeNull())
  })

  it('shows a selectable Iroh option when the transport is bound', async () => {
    getIrohStatus.mockResolvedValue({ bound: true, endpointId: 'a'.repeat(64), relayUrl: null })
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<MobilePairingConnectionOptions value="local-only" onChange={onChange} />)

    await waitFor(() => expect(screen.getByRole('radio', { name: /Iroh/i })).toBeVisible())
    expect(
      screen.getByText(
        'Phone can be on cellular or any Wi‑Fi. No sign-in, no address setup. Direct P2P (hole-punched) with public relay fallback.'
      )
    ).toBeVisible()

    await user.click(screen.getByRole('radio', { name: /Iroh/i }))
    expect(onChange).toHaveBeenCalledWith('iroh')
  })

  it('keeps the home relay selector usable while Iroh is unavailable and reconciles external saves', async () => {
    getIrohStatus.mockResolvedValue({ bound: false, endpointId: null, relayUrl: null })
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<MobilePairingConnectionOptions value="local-only" onChange={onChange} />)

    const iroh = await screen.findByRole('radio', { name: /Iroh/i })
    expect(iroh).toHaveAttribute('aria-disabled', 'true')
    const selector = screen.getByRole('combobox', { name: 'Iroh home relay' })
    expect(selector).toBeEnabled()
    expect(screen.getByRole('radiogroup')).not.toContainElement(selector)

    await user.click(iroh)
    expect(onChange).not.toHaveBeenCalled()

    selector.focus()
    await user.keyboard('{ArrowDown}')
    await user.click(await screen.findByRole('option', { name: 'Europe' }))
    await waitFor(() =>
      expect(updateSettingsOrThrow).toHaveBeenCalledWith({
        mobileIrohRelayUrl: 'https://euc1-1.relay.n0.iroh.link./'
      })
    )
    expect(selector).toHaveTextContent('Europe')

    act(() => {
      publishStoreState({
        ...mocks.state,
        settings: { mobileIrohRelayUrl: 'https://other.example/' }
      })
    })
    expect(selector).toHaveTextContent('Custom HTTPS')
    expect(screen.getByRole('textbox', { name: 'Custom HTTPS relay origin' })).toHaveValue(
      'https://other.example/'
    )
    act(() => {
      publishStoreState({
        ...mocks.state,
        settings: { mobileIrohRelayUrl: 'https://aps1-1.relay.n0.iroh.link./' }
      })
    })
    expect(selector).toHaveTextContent('Asia (Singapore)')
    expect(screen.queryByRole('textbox', { name: 'Custom HTTPS relay origin' })).toBeNull()
    expect(updateSettingsOrThrow).toHaveBeenCalledOnce()
  })

  it('selects Custom by keyboard and saves only a valid HTTPS origin on Enter', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<MobilePairingConnectionOptions value="local-only" onChange={onChange} />)

    screen.getByRole('combobox', { name: 'Iroh home relay' }).focus()
    await user.keyboard('{ArrowDown}')
    await screen.findByRole('listbox')
    await user.keyboard('{End}{Enter}')
    const input = await screen.findByRole('textbox', { name: 'Custom HTTPS relay origin' })
    expect(updateSettingsOrThrow).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()

    for (const invalid of [
      'http://relay.example',
      'https://user:secret@relay.example',
      'https://relay.example/path',
      'https://relay.example?token=secret'
    ]) {
      await user.clear(input)
      await user.type(input, invalid)
      await user.click(screen.getByRole('button', { name: 'Save relay' }))
      expect(screen.getByRole('alert')).toBeVisible()
      expect(updateSettingsOrThrow).not.toHaveBeenCalled()
      expect(mocks.state.settings.mobileIrohRelayUrl).toBeNull()
    }

    await user.clear(input)
    await user.type(input, 'https://custom.example{Enter}')
    await waitFor(() =>
      expect(updateSettingsOrThrow).toHaveBeenCalledWith({
        mobileIrohRelayUrl: 'https://custom.example/'
      })
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the persisted preset after a rejected save and exposes a safe accessible error', async () => {
    mocks.state.settings.mobileIrohRelayUrl = 'https://euc1-1.relay.n0.iroh.link./'
    const save = Promise.withResolvers<void>()
    updateSettingsOrThrow.mockReturnValueOnce(save.promise)
    const user = userEvent.setup()
    render(<MobilePairingConnectionOptions value="local-only" onChange={vi.fn()} />)
    const selector = screen.getByRole('combobox', { name: 'Iroh home relay' })

    selector.focus()
    await user.keyboard('{ArrowDown}')
    await user.click(await screen.findByRole('option', { name: 'US West' }))
    expect(selector).toBeDisabled()
    await act(async () => save.reject(new Error('private backend failure: secret-token')))

    const error = await screen.findByRole('alert')
    expect(error).toBeVisible()
    expect(error).not.toHaveTextContent('secret-token')
    expect(error.textContent?.trim()).not.toBe('')
    expect(selector).toBeEnabled()
    expect(selector).toHaveTextContent('Europe')
    expect(mocks.state.settings.mobileIrohRelayUrl).toBe('https://euc1-1.relay.n0.iroh.link./')
  })

  it('resets Iroh availability on relay changes, ignores stale status and recovers on polling', async () => {
    vi.useFakeTimers()
    type IrohStatus = { bound: boolean; endpointId: string | null; relayUrl: string | null }
    const initial = Promise.withResolvers<IrohStatus>()
    getIrohStatus.mockReturnValueOnce(initial.promise)
    render(<MobilePairingConnectionOptions value="local-only" onChange={vi.fn()} />)
    await act(async () => {
      initial.resolve({ bound: true, endpointId: 'a'.repeat(64), relayUrl: null })
    })
    const iroh = screen.getByRole('radio', { name: /Iroh/i })
    expect(iroh).toHaveAttribute('aria-disabled', 'false')

    const stale = Promise.withResolvers<IrohStatus>()
    const current = Promise.withResolvers<IrohStatus>()
    getIrohStatus.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise)
    act(() => {
      publishStoreState({
        ...mocks.state,
        settings: { mobileIrohRelayUrl: 'https://euc1-1.relay.n0.iroh.link./' }
      })
    })
    expect(iroh).toHaveAttribute('aria-disabled', 'true')
    act(() => {
      publishStoreState({
        ...mocks.state,
        settings: { mobileIrohRelayUrl: 'https://aps1-1.relay.n0.iroh.link./' }
      })
    })
    await act(async () => {
      stale.resolve({ bound: true, endpointId: 'a'.repeat(64), relayUrl: null })
    })
    expect(iroh).toHaveAttribute('aria-disabled', 'true')
    await act(async () => {
      current.resolve({ bound: false, endpointId: null, relayUrl: null })
    })
    getIrohStatus.mockResolvedValue({
      bound: true,
      endpointId: 'b'.repeat(64),
      relayUrl: 'https://actual-relay.example/'
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(iroh).toHaveAttribute('aria-disabled', 'false')
  })

  it('does not overlap slow Iroh status requests that could overwrite a successful bind', async () => {
    vi.useFakeTimers()
    const status = Promise.withResolvers<{
      bound: boolean
      endpointId: string | null
      relayUrl: string | null
    }>()
    getIrohStatus.mockReturnValueOnce(status.promise)
    render(<MobilePairingConnectionOptions value="local-only" onChange={vi.fn()} />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000)
    })
    expect(getIrohStatus).toHaveBeenCalledOnce()
    await act(async () => {
      status.resolve({ bound: true, endpointId: 'a'.repeat(64), relayUrl: null })
    })
    expect(screen.getByRole('radio', { name: /Iroh/i })).toHaveAttribute('aria-disabled', 'false')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000)
    })
    expect(getIrohStatus).toHaveBeenCalledOnce()
  })

  it('navigates from the focused fallback when the selected Iroh path is unavailable', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<MobilePairingConnectionOptions value="iroh" onChange={onChange} />)
    const relay = screen.getByRole('radio', { name: /Orca Relay/i })
    expect(relay).toHaveAttribute('tabindex', '0')
    relay.focus()

    await user.keyboard('{ArrowDown}')

    expect(onChange).toHaveBeenCalledWith('local-only')
    expect(screen.getByRole('radio', { name: /^LAN\b/i })).toHaveFocus()
  })

  it('keeps LAN available while Relay is retrying', async () => {
    mocks.state = {
      ...mocks.state,
      orcaProfileAuthStatus: {
        activeProfileId: 'profile-1',
        configured: true,
        state: 'connected',
        persistence: 'encrypted'
      }
    }
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <MobilePairingConnectionOptions
        value="automatic"
        onChange={onChange}
        relayMintFailed
        relayMintRetrying
      />
    )

    expect(screen.getByText('Retrying')).toBeVisible()
    const relay = screen.getByRole('radio', { name: /Orca Relay/i })
    const lan = screen.getByRole('radio', { name: /^LAN\b/i })
    expect(relay).toHaveAttribute('aria-disabled', 'true')
    expect(lan).toHaveAttribute('aria-disabled', 'false')
    await user.click(lan)
    expect(onChange).toHaveBeenCalledWith('local-only')
  })

  it('skips Relay in keyboard navigation while Relay is retrying', async () => {
    getIrohStatus.mockResolvedValue({ bound: true, endpointId: 'a'.repeat(64), relayUrl: null })
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <MobilePairingConnectionOptions value="local-only" onChange={onChange} relayMintRetrying />
    )

    const iroh = screen.getByRole('radio', { name: /Iroh/i })
    await waitFor(() => expect(iroh).toHaveAttribute('aria-disabled', 'false'))
    screen.getByRole('radio', { name: /^LAN\b/i }).focus()
    await user.keyboard('{ArrowUp}')
    expect(onChange).toHaveBeenCalledWith('iroh')
  })

  it('re-reads a session revoked since startup and offers Sign in again', async () => {
    // A cached connected state must not hide sessions revoked since startup.
    const connectedState: MobileRelayStoreState = {
      ...mocks.state,
      orcaProfileAuthStatus: {
        activeProfileId: 'profile-1',
        configured: true,
        state: 'connected',
        persistence: 'encrypted'
      }
    }
    mocks.state = connectedState
    fetchAuthStatus.mockImplementation(async () => {
      const revoked: OrcaProfileAuthStatus = {
        activeProfileId: 'profile-1',
        configured: true,
        state: 'reconnect-required',
        persistence: 'encrypted'
      }
      publishStoreState({ ...connectedState, orcaProfileAuthStatus: revoked })
      return revoked
    })

    // StrictMode double-invokes the effect: a fetch keyed on what it writes would loop.
    render(
      <StrictMode>
        <MobilePairingConnectionOptions value="automatic" onChange={vi.fn()} />
      </StrictMode>
    )

    expect(await screen.findByRole('button', { name: 'Sign in again for Relay' })).toBeVisible()
    expect(fetchAuthStatus).toHaveBeenCalledTimes(2)
  })
})
