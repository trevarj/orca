import { createHash } from 'node:crypto'
import {
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  IROH_BUILD_IDENTITY,
  IROH_PREBUILD_FILES
} from '../../orcad-distribution/prebuilds/iroh-prebuild.mjs'
import { ensureLinuxIrohPrebuild } from '../../orcad-distribution/prebuilds/ensure-linux-iroh-prebuild.mjs'
import { copyScriptWithLocalModules } from '../../test-fixtures/script-copy-closure/script-module-dependencies.mjs'

const require = createRequire(import.meta.url)
const {
  assertPackagedIrohNativeVariantInstalled,
  prunePackagedIrohNapi,
  stagePackagedIrohNative
} = require('../../../packaged-runtime-node-modules.cjs')

const roots = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** Minimal ELF64 shared-object header; fixtures are inspected, never loaded. */
function nativeBytes(arch, marker = 'floor prebuild') {
  const header = Buffer.alloc(64)
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  header.writeUInt16LE(3, 16)
  header.writeUInt16LE(arch === 'x64' ? 62 : 183, 18)
  header.writeUInt32LE(1, 20)
  header.writeUInt16LE(64, 52)
  return Buffer.concat([header, Buffer.from(marker)])
}

/** Copy an SDK install separately from its manifest-backed native floor artifact. */
async function stagingFixture(arch, { installedNative = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'orca-iroh-staging-'))
  roots.push(root)
  const resourcesDir = join(root, 'resources')
  const sourceModules = join(root, 'source/node_modules')
  const nodeModulesDir = join(resourcesDir, 'node_modules')
  const sourceLoader = join(sourceModules, '@number0/iroh')
  const loaderDir = join(nodeModulesDir, '@number0/iroh')
  const packageName = `@number0/iroh-linux-${arch}-gnu`
  const nativeName = `iroh.linux-${arch}-gnu.node`
  const sourceNative = join(sourceModules, packageName)
  const nativeDir = join(nodeModulesDir, packageName)
  const metadata = {
    name: '@number0/iroh',
    version: '1.1.0',
    main: 'iroh-js/index.js',
    optionalDependencies: {
      '@number0/iroh-linux-x64-gnu': '1.1.0',
      '@number0/iroh-linux-arm64-gnu': '1.1.0'
    }
  }
  await mkdir(sourceLoader, { recursive: true })
  await writeFile(join(sourceLoader, 'package.json'), JSON.stringify(metadata))
  await writeFile(join(sourceLoader, 'index.js'), `module.exports = require('${packageName}');\n`)
  const installedBytes = nativeBytes(arch, 'too-new npm native')
  if (installedNative) {
    await mkdir(sourceNative, { recursive: true })
    await writeFile(
      join(sourceNative, 'package.json'),
      JSON.stringify({ name: packageName, version: '1.1.0', main: nativeName })
    )
    await writeFile(join(sourceNative, nativeName), installedBytes)
  }
  await cp(sourceModules, nodeModulesDir, { recursive: true })
  // Hardlinks expose accidental writes through a copied pnpm store file.
  await rm(join(loaderDir, 'package.json'))
  await link(join(sourceLoader, 'package.json'), join(loaderDir, 'package.json'))
  if (installedNative) {
    await rm(join(nativeDir, nativeName))
    await link(join(sourceNative, nativeName), join(nativeDir, nativeName))
  }
  const prebuildsDir = join(root, 'prebuilds')
  const slot = `linux-${arch}-glibc`
  const relative = IROH_PREBUILD_FILES[slot]
  const artifact = join(prebuildsDir, slot, relative)
  const bytes = nativeBytes(arch)
  await mkdir(dirname(artifact), { recursive: true })
  await writeFile(artifact, bytes)
  const entry = {
    platform: 'linux',
    arch,
    libc: 'glibc',
    glibc: '2.28',
    napi: 8,
    iroh: { ...IROH_BUILD_IDENTITY },
    files: { [relative]: createHash('sha256').update(bytes).digest('hex') }
  }
  const manifest = {
    schemaVersion: 2,
    module: 'node-pty',
    version: '1.0.0',
    napi: 8,
    slots: { [slot]: entry }
  }
  const writeManifest = () =>
    writeFile(join(prebuildsDir, 'manifest.json'), JSON.stringify(manifest))
  await writeManifest()
  const registryFetch = vi.fn(() => {
    throw new Error('Packaging must not fetch npm packages')
  })
  vi.stubGlobal('fetch', registryFetch)
  return {
    root,
    resourcesDir,
    nodeModulesDir,
    sourceLoader,
    loaderDir,
    sourceNative,
    nativeDir,
    packageName,
    nativeName,
    metadata,
    installedBytes,
    prebuildsDir,
    slot,
    relative,
    artifact,
    bytes,
    entry,
    manifest,
    writeManifest,
    registryFetch
  }
}

it.each(['x64', 'arm64'])(
  'accepts a verified GNU %s cache for foreign-host packaging without fetching build inputs',
  async (arch) => {
    const f = await stagingFixture(arch)
    await ensureLinuxIrohPrebuild({
      arch,
      root: join(f.root, 'source'),
      prebuildsDir: f.prebuildsDir,
      platform: 'darwin',
      hostArch: arch
    })
    await stagePackagedIrohNative(f.resourcesDir, 'linux', arch, f.prebuildsDir)
    expect(await readFile(join(f.nativeDir, f.nativeName))).toEqual(f.bytes)
    expect(f.registryFetch).not.toHaveBeenCalled()
  }
)

it.each(['missing', 'stale', 'corrupt'])(
  'refuses %s foreign-host build inputs even when the npm native is installed',
  async (damage) => {
    const f = await stagingFixture('arm64', { installedNative: true })
    if (damage === 'missing') {
      await rm(f.prebuildsDir, { recursive: true })
    } else if (damage === 'stale') {
      f.entry.iroh.sourceRevision = 'stale'
      await f.writeManifest()
    } else {
      await writeFile(f.artifact, nativeBytes('arm64', 'tampered cache'))
    }
    await expect(
      ensureLinuxIrohPrebuild({
        arch: 'arm64',
        root: join(f.root, 'source'),
        prebuildsDir: f.prebuildsDir,
        platform: 'linux',
        hostArch: 'x64'
      })
    ).rejects.toThrow(/linux-arm64-glibc.*native Linux arm64 runner/)
    expect(await readFile(join(f.sourceNative, f.nativeName))).toEqual(f.installedBytes)
    expect(f.registryFetch).not.toHaveBeenCalled()
  }
)

it('refuses an invalid custom prebuild directory instead of producing into a different cache', async () => {
  const f = await stagingFixture('x64')
  await rm(f.artifact)
  await expect(
    ensureLinuxIrohPrebuild({
      arch: 'x64',
      root: join(f.root, 'source'),
      prebuildsDir: f.prebuildsDir,
      platform: 'linux',
      hostArch: 'x64'
    })
  ).rejects.toThrow(/ORCAD_PREBUILDS_DIR.*linux-x64-glibc/)
  await expect(readFile(f.artifact)).rejects.toThrow(/ENOENT/)
  expect(f.registryFetch).not.toHaveBeenCalled()
})

it('requires Docker to provision a missing native-host cache before staging can proceed', async () => {
  const f = await stagingFixture('x64', { installedNative: true })
  const root = join(f.root, 'source')
  const prebuildsDir = join(root, 'out', 'orcad-prebuilds')
  await expect(
    ensureLinuxIrohPrebuild({
      arch: 'x64',
      root,
      prebuildsDir,
      platform: 'linux',
      hostArch: 'x64',
      run: () => ({ error: new Error('Docker is not installed') })
    })
  ).rejects.toThrow(/linux-x64-glibc.*requires working Docker/)
  await expect(
    stagePackagedIrohNative(f.resourcesDir, 'linux', 'x64', prebuildsDir)
  ).rejects.toThrow(/missing.*identity/)
  expect(await readFile(join(f.nativeDir, f.nativeName))).toEqual(f.installedBytes)
  expect(f.registryFetch).not.toHaveBeenCalled()
})

it.each([
  ['x64', 'x64'],
  ['x64', 1],
  ['arm64', 'arm64'],
  ['arm64', 3]
])(
  'stages GNU %s from a verified artifact without an installed target package (arch %s)',
  async (arch, electronArch) => {
    const f = await stagingFixture(arch)
    expect(f.manifest.version).not.toBe(f.metadata.version)
    await expect(readdir(f.nativeDir)).rejects.toThrow(/ENOENT/)
    expect(() =>
      assertPackagedIrohNativeVariantInstalled('linux', electronArch, f.nodeModulesDir)
    ).toThrow(f.packageName)

    await stagePackagedIrohNative(f.resourcesDir, 'linux', electronArch, f.prebuildsDir)

    expect(await readFile(join(f.nativeDir, f.nativeName))).toEqual(f.bytes)
    expect(JSON.parse(await readFile(join(f.nativeDir, 'package.json'), 'utf8'))).toMatchObject({
      name: f.packageName,
      version: f.metadata.version,
      main: basename(f.relative)
    })
    expect(JSON.parse(await readFile(join(f.loaderDir, 'package.json'), 'utf8'))).toEqual({
      ...f.metadata,
      main: 'index.js'
    })
    expect(await readFile(join(f.loaderDir, 'index.js'))).toEqual(
      await readFile(join(f.sourceLoader, 'index.js'))
    )
    expect(JSON.parse(await readFile(join(f.sourceLoader, 'package.json'), 'utf8'))).toEqual(
      f.metadata
    )
    await expect(readdir(f.sourceNative)).rejects.toThrow(/ENOENT/)
    expect(() =>
      assertPackagedIrohNativeVariantInstalled('linux', electronArch, f.nodeModulesDir)
    ).not.toThrow()
    expect(f.registryFetch).not.toHaveBeenCalled()
  }
)

it.each(['x64', 'arm64'])(
  'replaces copied GNU %s npm native bytes without mutating the source install',
  async (arch) => {
    const f = await stagingFixture(arch, { installedNative: true })
    expect(await readFile(join(f.nativeDir, f.nativeName))).toEqual(f.installedBytes)
    expect(f.installedBytes).not.toEqual(f.bytes)

    await stagePackagedIrohNative(f.resourcesDir, 'linux', arch, f.prebuildsDir)

    expect(await readFile(join(f.nativeDir, f.nativeName))).toEqual(f.bytes)
    expect(await readFile(join(f.sourceNative, f.nativeName))).toEqual(f.installedBytes)
    expect(JSON.parse(await readFile(join(f.sourceLoader, 'package.json'), 'utf8'))).toEqual(
      f.metadata
    )
    expect(() =>
      assertPackagedIrohNativeVariantInstalled('linux', arch, f.nodeModulesDir)
    ).not.toThrow()
    expect(f.registryFetch).not.toHaveBeenCalled()
  }
)

for (const arch of ['x64', 'arm64']) {
  it.each([
    [
      'prebuild directory',
      (f) => rm(f.prebuildsDir, { recursive: true }),
      /missing|manifest|not built/i
    ],
    ['manifest', (f) => rm(join(f.prebuildsDir, 'manifest.json')), /missing|manifest|not built/i],
    [
      'target slot',
      async (f) => {
        delete f.manifest.slots[f.slot]
        await f.writeManifest()
      },
      /missing|manifest|not built/i
    ],
    ['native file', (f) => rm(f.artifact), /missing|ENOENT|not.*exist/i],
    [
      'identity',
      async (f) => {
        delete f.entry.iroh
        await f.writeManifest()
      },
      /identity|stale/i
    ],
    [
      'stale identity',
      async (f) => {
        f.entry.iroh.sourceRevision = 'stale'
        await f.writeManifest()
      },
      /identity|stale/i
    ],
    [
      'SDK version',
      (f) =>
        writeFile(
          join(f.loaderDir, 'package.json'),
          JSON.stringify({
            ...f.metadata,
            version: '1.2.0',
            optionalDependencies: { [f.packageName]: '1.2.0' }
          })
        ),
      /version|stale/i
    ],
    [
      'target dependency declaration',
      (f) =>
        writeFile(
          join(f.loaderDir, 'package.json'),
          JSON.stringify({ ...f.metadata, optionalDependencies: {} })
        ),
      /dependency|declar|publish|version/i
    ],
    [
      'target dependency version',
      (f) =>
        writeFile(
          join(f.loaderDir, 'package.json'),
          JSON.stringify({ ...f.metadata, optionalDependencies: { [f.packageName]: '1.2.0' } })
        ),
      /version|match|dependency|declar/i
    ],
    [
      'native hash',
      async (f) => {
        f.entry.files[f.relative] = '0'.repeat(64)
        await f.writeManifest()
      },
      /hash|sha256/i
    ],
    [
      'native hash entry',
      async (f) => {
        delete f.entry.files[f.relative]
        await f.writeManifest()
      },
      /hash|sha256|missing/i
    ],
    [
      'native architecture',
      async (f) => {
        const bytes = nativeBytes(arch === 'x64' ? 'arm64' : 'x64')
        await writeFile(f.artifact, bytes)
        f.entry.files[f.relative] = createHash('sha256').update(bytes).digest('hex')
        await f.writeManifest()
      },
      /architecture|machine|ELF/i
    ]
  ])(
    `rejects invalid ${arch} %s rather than retaining copied npm native bytes`,
    async (_name, damage, error) => {
      const f = await stagingFixture(arch, { installedNative: true })
      await damage(f)
      await expect(
        stagePackagedIrohNative(f.resourcesDir, 'linux', arch, f.prebuildsDir)
      ).rejects.toThrow(error)
      expect(await readFile(join(f.nativeDir, f.nativeName))).toEqual(f.installedBytes)
      expect(await readFile(join(f.sourceNative, f.nativeName))).toEqual(f.installedBytes)
      expect(f.registryFetch).not.toHaveBeenCalled()
    }
  )
}

it.each([
  ['darwin', 'x64'],
  ['darwin', 'arm64'],
  ['win32', 'x64'],
  ['linux', 'arm'],
  ['linux', 'ia32'],
  ['linux', 2]
])(
  'leaves unsupported %s/%s resources unchanged without requiring SDK or prebuild paths',
  async (platform, arch) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-iroh-unsupported-'))
    roots.push(root)
    const resourcesDir = join(root, 'resources')
    await mkdir(resourcesDir)
    await writeFile(join(resourcesDir, 'untouched.node'), 'original native bytes')
    await stagePackagedIrohNative(resourcesDir, platform, arch, join(root, 'missing-prebuilds'))
    expect(await readdir(resourcesDir)).toEqual(['untouched.node'])
    expect(await readFile(join(resourcesDir, 'untouched.node'), 'utf8')).toBe(
      'original native bytes'
    )
  }
)

it('collects installed Iroh optional dependency closures without requiring a host SDK variant', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-iroh-closure-')))
  try {
    copyScriptWithLocalModules(
      require.resolve('../../../packaged-runtime-node-modules.cjs'),
      join(root, 'config')
    )
    const writePackage = async (directory, metadata) => {
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'package.json'), JSON.stringify(metadata))
    }
    for (const name of [
      '@anthropic-ai/claude-agent-sdk',
      '@linear/sdk',
      '@orca/process-host',
      '@parcel/watcher',
      'electron-updater',
      'i18next',
      'jsonc-parser',
      'node-pty',
      'posthog-node',
      'proper-lockfile',
      'qrcode',
      'smol-toml',
      'ssh2',
      'tweetnacl',
      'ws',
      'yaml',
      'zod'
    ]) {
      await writePackage(join(root, 'node_modules', name), { name })
    }
    const loaderDir = join(root, 'node_modules', '@number0', 'iroh')
    const nativeDir = join(loaderDir, 'node_modules', '@number0', 'iroh-linux-x64-gnu')
    await writePackage(loaderDir, {
      name: '@number0/iroh',
      optionalDependencies: { '@number0/iroh-linux-x64-gnu': '1.1.0' }
    })
    await writePackage(nativeDir, {
      name: '@number0/iroh-linux-x64-gnu',
      dependencies: { 'native-session-state': '1.0.0' }
    })
    await writePackage(join(nativeDir, 'node_modules', 'native-session-state'), {
      name: 'native-session-state'
    })
    const { createPackagedRuntimeNodeModuleResources } = createRequire(join(root, 'package.json'))(
      './config/packaged-runtime-node-modules.cjs'
    )
    const resources = createPackagedRuntimeNodeModuleResources('linux')
    expect(
      resources
        .map((resource) => resource.to)
        .filter((target) => target.startsWith(join('node_modules', '@number0', 'iroh')))
    ).toEqual([
      join('node_modules', '@number0', 'iroh'),
      join('node_modules', '@number0', 'iroh-linux-x64-gnu')
    ])
    expect(
      resources.find((resource) => resource.to === join('node_modules', 'native-session-state'))
    ).toMatchObject({ from: join(nativeDir, 'node_modules', 'native-session-state') })

    await rm(nativeDir, { recursive: true })
    const withoutNative = createPackagedRuntimeNodeModuleResources('linux').map(
      (resource) => resource.to
    )
    expect(withoutNative).toContain(join('node_modules', '@number0', 'iroh'))
    expect(withoutNative).not.toContain(join('node_modules', '@number0', 'iroh-linux-x64-gnu'))
    expect(withoutNative).not.toContain(join('node_modules', 'native-session-state'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('prunes non-target @number0/iroh platform subpackages from packaged runtime resources', async () => {
  const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-iroh-napi-prune-'))
  try {
    const scopeDir = join(resourcesDir, 'node_modules', '@number0')
    await mkdir(join(scopeDir, 'iroh'), { recursive: true })
    await mkdir(join(scopeDir, 'iroh-darwin-arm64'), { recursive: true })
    await mkdir(join(scopeDir, 'iroh-linux-x64-gnu'), { recursive: true })
    await mkdir(join(scopeDir, 'iroh-linux-arm64-musl'), { recursive: true })
    await mkdir(join(scopeDir, 'iroh-win32-x64-msvc'), { recursive: true })

    prunePackagedIrohNapi(resourcesDir, 'darwin', 'arm64')

    await expect(readdir(scopeDir).then((entries) => entries.sort())).resolves.toEqual([
      'iroh',
      'iroh-darwin-arm64'
    ])
  } finally {
    await rm(resourcesDir, { recursive: true, force: true })
  }
})

it('requires the GNU Iroh binary and reports unsupported Darwin x64 without blocking packaging', async () => {
  const nodeModulesDir = await mkdtemp(join(tmpdir(), 'orca-iroh-native-'))
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const loaderDir = join(nodeModulesDir, '@number0', 'iroh')
    const nativeDir = join(nodeModulesDir, '@number0', 'iroh-linux-x64-gnu')
    await mkdir(loaderDir, { recursive: true })
    await writeFile(
      join(loaderDir, 'package.json'),
      JSON.stringify({
        version: '1.1.0',
        optionalDependencies: {
          '@number0/iroh-linux-x64-gnu': '1.1.0',
          '@number0/iroh-linux-x64-musl': '1.1.0'
        }
      })
    )
    expect(() => assertPackagedIrohNativeVariantInstalled('linux', 'x64', nodeModulesDir)).toThrow(
      '@number0/iroh-linux-x64-gnu'
    )
    await mkdir(nativeDir, { recursive: true })
    await writeFile(
      join(nativeDir, 'package.json'),
      JSON.stringify({ main: 'iroh.linux-x64-gnu.node' })
    )
    expect(() => assertPackagedIrohNativeVariantInstalled('linux', 'x64', nodeModulesDir)).toThrow(
      'native .node binary'
    )
    await writeFile(join(nativeDir, 'iroh.linux-x64-gnu.node'), '')
    expect(() =>
      assertPackagedIrohNativeVariantInstalled('linux', 'x64', nodeModulesDir)
    ).not.toThrow()
    expect(() =>
      assertPackagedIrohNativeVariantInstalled('darwin', 'x64', nodeModulesDir)
    ).not.toThrow()
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('Iroh is unavailable on darwin/x64')
    )
  } finally {
    warning.mockRestore()
    await rm(nodeModulesDir, { recursive: true, force: true })
  }
})
