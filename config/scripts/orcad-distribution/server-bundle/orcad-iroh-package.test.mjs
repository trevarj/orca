import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { COMPAT_SERVER_TARGETS, SERVER_TARGETS } from '../../../../src/shared/node-runtime-pin.ts'
import {
  ORCAD_IROH_DIR,
  ORCAD_IROH_LINUX_X64_GLIBC_ARTIFACTS,
  ORCAD_MOBILE_WEB_MANIFEST,
  ORCAD_SERVER_TARGET_FILENAME,
  orcadArtifactFilenames
} from '../../../../src/shared/orcad-artifacts.ts'
import { readOrcadArtifactIdentity } from '../../../../src/main/orcad/orcad-artifact-identity.ts'
import { computeOrcadFullVersion } from './orcad-artifact-version.mjs'
import { stageOrcadIroh } from './orcad-iroh-package.mjs'

const roots = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orcad-iroh-'))
  roots.push(root)
  const source = join(root, ORCAD_IROH_DIR)
  // Resolve the optional dependency from Iroh, as with pnpm's isolated package layout.
  const native = join(source, 'node_modules/@number0/iroh-linux-x64-gnu')
  mkdirSync(join(native, 'native'), { recursive: true })
  const metadata = {
    name: '@number0/iroh',
    version: '1.1.0',
    type: 'commonjs',
    main: 'iroh-js/index.js',
    license: 'MIT OR Apache-2.0',
    optionalDependencies: { '@number0/iroh-linux-x64-gnu': '1.1.0' }
  }
  writeFileSync(join(source, 'package.json'), JSON.stringify(metadata))
  writeFileSync(
    join(source, 'index.js'),
    "const binding = require('./iroh.linux-x64-gnu.node');\n" +
      'module.exports = binding;\nmodule.exports.Endpoint = binding.Endpoint;\n'
  )
  writeFileSync(join(native, 'package.json'), JSON.stringify({ main: 'native/declared.node' }))
  writeFileSync(
    join(native, 'native/declared.node'),
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0xff])
  )
  return { root, source, native, output: join(root, 'output'), metadata }
}

it('stages the unchanged loader and declared native main beside normalized package metadata', () => {
  const { root, source, native, output, metadata } = fixture()
  stageOrcadIroh(root, output, 'linux-x64-glibc')
  const staged = join(output, ORCAD_IROH_DIR)
  expect(readFileSync(join(staged, 'index.js'))).toEqual(readFileSync(join(source, 'index.js')))
  expect(readFileSync(join(staged, 'iroh.linux-x64-gnu.node'))).toEqual(
    readFileSync(join(native, 'native/declared.node'))
  )
  expect(JSON.parse(readFileSync(join(staged, 'package.json'), 'utf8'))).toEqual({
    ...metadata,
    main: 'index.js'
  })
  expect(JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))).toEqual(metadata)
  expect(existsSync(join(output, 'node_modules/@number0/iroh-linux-x64-gnu'))).toBe(false)
})

it.each([
  'package.json',
  'index.js',
  'node_modules/@number0/iroh-linux-x64-gnu/package.json',
  'node_modules/@number0/iroh-linux-x64-gnu/native/declared.node'
])('fails clearly when installed Iroh is missing %s', (missing) => {
  const { root, source, output } = fixture()
  rmSync(join(source, missing))
  expect(() => stageOrcadIroh(root, output, 'linux-x64-glibc')).toThrow(
    /Cannot stage Orcad linux-x64-glibc Iroh.*@number0\/iroh-linux-x64-gnu/
  )
})

it('rejects a native package without a declared main', () => {
  const { root, native, output } = fixture()
  writeFileSync(join(native, 'package.json'), '{}')
  expect(() => stageOrcadIroh(root, output, 'linux-x64-glibc')).toThrow('declares no native main')
})

it.each(
  [...SERVER_TARGETS, ...COMPAT_SERVER_TARGETS].filter((target) => target !== 'linux-x64-glibc')
)('leaves %s builds independent of installed Iroh packages', (target) => {
  const root = mkdtempSync(join(tmpdir(), 'orcad-no-iroh-'))
  roots.push(root)
  const output = join(root, 'output')
  stageOrcadIroh(root, output, target)
  expect(existsSync(output)).toBe(false)
})

it.each(ORCAD_IROH_LINUX_X64_GLIBC_ARTIFACTS)(
  'hashes the Iroh closure and rejects missing %s',
  async (filename) => {
    const target = 'linux-x64-glibc'
    const root = mkdtempSync(join(tmpdir(), 'orcad-iroh-version-'))
    roots.push(root)
    const pageAsset = 'out/mobile-web/index.html'
    for (const artifact of orcadArtifactFilenames(target, [pageAsset])) {
      const path = join(root, artifact)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(
        path,
        artifact === ORCAD_MOBILE_WEB_MANIFEST
          ? JSON.stringify({ assets: [{ path: 'index.html' }] })
          : artifact
      )
    }
    writeFileSync(join(root, ORCAD_SERVER_TARGET_FILENAME), `${target}\n`)
    const before = computeOrcadFullVersion(root, { target })
    writeFileSync(join(root, filename), 'updated Iroh artifact')
    const after = computeOrcadFullVersion(root, { target })
    expect(after).not.toBe(before)
    expect(await readOrcadArtifactIdentity(root)).toBe(after)
    rmSync(join(root, filename))
    expect(() => computeOrcadFullVersion(root, { target })).toThrow(filename)
    await expect(readOrcadArtifactIdentity(root)).rejects.toThrow(filename)
  }
)
