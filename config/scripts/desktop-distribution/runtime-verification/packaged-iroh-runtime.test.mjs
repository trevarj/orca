import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { copyScriptWithLocalModules } from '../../test-fixtures/script-copy-closure/script-module-dependencies.mjs'

const require = createRequire(import.meta.url)
const {
  assertPackagedIrohNativeVariantInstalled,
  prunePackagedIrohNapi
} = require('../../../packaged-runtime-node-modules.cjs')

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
