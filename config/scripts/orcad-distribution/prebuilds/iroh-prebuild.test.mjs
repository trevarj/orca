import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  fetchIrohBuildInput,
  IROH_BUILD_IDENTITY,
  IROH_PREBUILD_FILES,
  verifyIrohPrebuild
} from './iroh-prebuild.mjs'

const dirs = []

/** Allocates an isolated slot/cache directory removed after each test. */
function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'iroh-prebuild-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Makes only the ELF64 little-endian header the verifier needs; not a loadable addon. */
function elf64(machine) {
  const bytes = Buffer.alloc(64)
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  bytes.writeUInt16LE(3, 16)
  bytes.writeUInt16LE(machine, 18)
  bytes.writeUInt32LE(1, 20)
  bytes.writeUInt16LE(64, 52)
  return bytes
}

/** Writes real native bytes and a detached manifest identity so rejection cases can mutate either. */
function fixture(slot = 'linux-x64-glibc') {
  const slotDir = temp()
  const relative = IROH_PREBUILD_FILES[slot]
  const native = join(slotDir, relative)
  mkdirSync(dirname(native), { recursive: true })
  writeFileSync(native, elf64(slot === 'linux-x64-glibc' ? 62 : 183))
  const entry = {
    files: { [relative]: createHash('sha256').update(readFileSync(native)).digest('hex') },
    iroh: structuredClone(IROH_BUILD_IDENTITY)
  }
  return { slotDir, slot, entry, version: '1.1.0', relative, native }
}

/** Serves actual build-input bytes over loopback and always closes its socket. */
async function withBuildInput(bytes, run) {
  const requests = []
  const server = createServer((request, response) => {
    requests.push(request.url)
    response.end(bytes)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    await run(`http://127.0.0.1:${server.address().port}/input.tar.xz`, requests)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
}

describe('verifyIrohPrebuild', () => {
  it.each([
    ['linux-x64-glibc', 'iroh/iroh.linux-x64-gnu.node'],
    ['linux-arm64-glibc', 'iroh/iroh.linux-arm64-gnu.node']
  ])('accepts matching identity, hash and ELF architecture for %s', (slot, relative) => {
    const input = fixture(slot)
    expect(IROH_PREBUILD_FILES[slot]).toBe(relative)
    expect(verifyIrohPrebuild(input)).toBe(input.native)
  })

  it.each([
    ['absent identity', (entry) => delete entry.iroh],
    ['stale SDK', (entry) => (entry.iroh.sdkVersion = '1.0.0')],
    ['stale source', (entry) => (entry.iroh.sourceRevision = 'old-source')],
    ['stale compiler', (entry) => (entry.iroh.compilerVersion = '1.90.0')],
    ['stale recipe', (entry) => (entry.iroh.recipe = 'old-recipe')],
    ['missing source hash', (entry) => delete entry.iroh.sourceArchiveSha256],
    ['extra identity field', (entry) => (entry.iroh.untrusted = true)],
    [
      'changed compiler archive hash',
      (entry) => (entry.iroh.compilerArchives['x86_64-unknown-linux-gnu'].rustc = '0'.repeat(64))
    ]
  ])('rejects %s rather than trusting matching native bytes', (_label, change) => {
    const input = fixture()
    change(input.entry)
    expect(() => verifyIrohPrebuild(input)).toThrow(/iroh.*identity/i)
  })

  it('rejects an installed SDK version that differs from the build identity', () => {
    expect(() => verifyIrohPrebuild({ ...fixture(), version: '1.2.0' })).toThrow(/iroh.*version/i)
  })

  it('rejects a missing native file', () => {
    const input = fixture()
    rmSync(input.native)
    expect(() => verifyIrohPrebuild(input)).toThrow(/missing iroh native file/i)
  })

  it('requires a recorded native hash', () => {
    const input = fixture()
    delete input.entry.files[input.relative]
    expect(() => verifyIrohPrebuild(input)).toThrow(/iroh.*sha256/i)
  })

  it('rejects corrupt native bytes even when their ELF header is intact', () => {
    const input = fixture()
    const bytes = readFileSync(input.native)
    bytes[63] = 1
    writeFileSync(input.native, bytes)
    expect(() => verifyIrohPrebuild(input)).toThrow(/iroh.*sha256/i)
  })

  it.each([
    ['wrong machine', (bytes) => bytes.writeUInt16LE(183, 18)],
    ['not ELF', (bytes) => (bytes[0] = 0)],
    ['ELF32', (bytes) => (bytes[4] = 1)],
    ['big endian', (bytes) => (bytes[5] = 2)],
    ['truncated header', (bytes) => bytes.subarray(0, 20)]
  ])('rejects %s even with a matching hash', (_label, change) => {
    const input = fixture()
    const bytes = readFileSync(input.native)
    const changed = change(bytes)
    writeFileSync(input.native, Buffer.isBuffer(changed) ? changed : bytes)
    input.entry.files[input.relative] = createHash('sha256')
      .update(readFileSync(input.native))
      .digest('hex')
    expect(() => verifyIrohPrebuild(input)).toThrow(/iroh.*architecture/i)
  })

  it('requires a regular native file, not a directory', () => {
    const input = fixture()
    rmSync(input.native)
    mkdirSync(input.native)
    expect(() => verifyIrohPrebuild(input)).toThrow(/iroh/i)
  })

  it.each(['darwin-arm64', 'linux-x64-musl', 'linux-x64-glibc217', 'win32-x64'])(
    'refuses an explicitly requested unsupported slot %s',
    (slot) => {
      expect(() => verifyIrohPrebuild({ ...fixture(), slot })).toThrow(
        /unsupported iroh prebuild slot/i
      )
    }
  )
})

describe('fetchIrohBuildInput', () => {
  it('downloads pinned bytes, reuses a verified cache and rehashes a changed cache', async () => {
    const bytes = Buffer.from('official source or Rust archive fixture')
    const destination = join(temp(), 'cache', 'input.tar.xz')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    await withBuildInput(bytes, async (url, requests) => {
      await fetchIrohBuildInput({ url, destination, sha256 })
      expect(readFileSync(destination)).toEqual(bytes)
      expect(requests).toHaveLength(1)
      await fetchIrohBuildInput({ url, destination, sha256 })
      expect(requests).toHaveLength(1)
      writeFileSync(destination, 'tampered cache')
      await fetchIrohBuildInput({ url, destination, sha256 })
      expect(requests).toHaveLength(2)
      expect(readFileSync(destination)).toEqual(bytes)
      expect(readdirSync(dirname(destination))).toEqual([basename(destination)])
    })
  })

  it.each([false, true])(
    'rejects untrusted downloaded bytes (existing cache: %s)',
    async (cached) => {
      const destination = join(temp(), 'input.tar.xz')
      if (cached) {
        writeFileSync(destination, 'untrusted cache')
      }
      const sha256 = createHash('sha256').update('trusted bytes').digest('hex')
      await withBuildInput(Buffer.from('wrong archive'), async (url, requests) => {
        await expect(fetchIrohBuildInput({ url, destination, sha256 })).rejects.toThrow(
          /iroh build input.*sha256 mismatch/i
        )
        expect(requests).toHaveLength(1)
        if (!cached) {
          expect(existsSync(destination)).toBe(false)
        }
        expect(
          readdirSync(dirname(destination)).filter((file) => file !== basename(destination))
        ).toEqual([])
      })
    }
  )
})
