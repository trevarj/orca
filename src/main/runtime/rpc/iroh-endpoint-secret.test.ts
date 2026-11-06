import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  IROH_ENDPOINT_SECRET_FILENAME,
  loadOrCreateIrohEndpointSecret
} from './iroh-endpoint-secret'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

describe('iroh endpoint secret', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('creates a 32-byte secret and reuses it on later loads', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-secret-'))
    dirs.push(userDataPath)

    const first = loadOrCreateIrohEndpointSecret(userDataPath)
    expect(first).toHaveLength(32)
    const second = loadOrCreateIrohEndpointSecret(userDataPath)
    expect(second).toEqual(first)

    const raw: { v?: unknown; secretKeyB64?: unknown } = JSON.parse(
      readFileSync(join(userDataPath, IROH_ENDPOINT_SECRET_FILENAME), 'utf8')
    )
    expect(raw.v).toBe(1)
    expect(Buffer.from(String(raw.secretKeyB64), 'base64')).toHaveLength(32)
  })

  it('never replaces an existing identity when its contents cannot be read', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-secret-'))
    dirs.push(userDataPath)
    const first = loadOrCreateIrohEndpointSecret(userDataPath)
    const file = join(userDataPath, IROH_ENDPOINT_SECRET_FILENAME)
    const original = readFileSync(file, 'utf8')
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('temporarily unreadable'), { code: 'EACCES' })
    })

    expect(() => loadOrCreateIrohEndpointSecret(userDataPath)).toThrow(
      'refusing to replace the identity'
    )
    expect(readFileSync(file, 'utf8')).toBe(original)
    expect(loadOrCreateIrohEndpointSecret(userDataPath)).toEqual(first)
  })
})
