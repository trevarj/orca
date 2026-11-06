import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  assertPackagedIrohNativeVariantInstalled,
  createPackagedRuntimeNodeModuleResources,
  prunePackagedIrohNapi
} = require('../../../packaged-runtime-node-modules.cjs')

it('includes @number0/iroh and its platform subpackage in the packaged runtime closure', () => {
  const packagedTargets = createPackagedRuntimeNodeModuleResources().map((resource) => resource.to)
  expect(packagedTargets).toContain(join('node_modules', '@number0', 'iroh'))
  expect(
    packagedTargets.some((target) => target.startsWith(join('node_modules', '@number0', 'iroh-')))
  ).toBe(true)
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
