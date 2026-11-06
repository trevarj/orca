import {
  closeTestStores,
  testState,
  createStore,
  writeDataFile,
  readDataFile
} from './persistence-test-harness'
// Settle unrelated migrations first; only a debounced save proves the repair marked its own state dirty.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PersistedState } from '../../shared/persisted-state-types'
import { getDefaultWorkspaceSession } from '../../shared/constants'

const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: loadUserSshConfigMock,
  sshConfigHostsToTargets: sshConfigHostsToTargetsMock
}))
const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => false
  }
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

async function settledProfile(): Promise<PersistedState> {
  writeDataFile({
    schemaVersion: 1,
    repos: [],
    worktreeMeta: {},
    settings: {},
    ui: {},
    githubCache: { pr: {}, issue: {} },
    workspaceSession: getDefaultWorkspaceSession()
  })
  const store = await createStore()
  await store.flushPendingOrThrowAsync()
  await closeTestStores()
  return readDataFile() as PersistedState
}

async function reloadAndSettleWrites(): Promise<PersistedState> {
  vi.useFakeTimers()
  try {
    const store = await createStore()
    vi.advanceTimersByTime(5000)
    await store.waitForPendingWrite()
  } finally {
    vi.useRealTimers()
  }
  return readDataFile() as PersistedState
}

describe('load-time normalization durability', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('persists the legacy search-tab explorer view repair', async () => {
    const settled = await settledProfile()
    delete (settled.ui as Record<string, unknown>).rightSidebarExplorerView
    settled.ui.rightSidebarTab = 'search'
    writeDataFile(settled)

    const persisted = await reloadAndSettleWrites()

    expect(persisted.ui.rightSidebarExplorerView).toBe('search')
  })

  it('persists a repaired notification settings block', async () => {
    const settled = await settledProfile()
    settled.settings.notifications = {
      ...settled.settings.notifications,
      enabled: 'false' as unknown as boolean
    }
    writeDataFile(settled)

    const persisted = await reloadAndSettleWrites()

    expect(persisted.settings.notifications.enabled).toBe(true)
  })

  it.each([
    { saved: 'https://private-user:private-token@relay.example/', expected: null },
    { saved: 'https://relay.example/private', expected: null },
    { saved: 42, expected: null },
    { saved: ' HTTPS://Relay.Example:443 ', expected: 'https://relay.example/' }
  ])('persists loaded iroh relay repair for $saved', async ({ saved, expected }) => {
    const settled = await settledProfile()
    settled.settings.mobileIrohRelayUrl = saved as never
    writeDataFile(settled)

    const persisted = await reloadAndSettleWrites()

    expect(persisted.settings.mobileIrohRelayUrl).toBe(expected)
  })
})
