// The GNU SDK shipped by npm exceeds Orca's glibc floor; build only those existing slots from pinned source.
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative as relativePath, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  download,
  sha256File
} from '../../node-runtime/archive-identity/update-node-runtime-pin.mjs'

const require = createRequire(import.meta.url)
const {
  ELF_MACHINE_BY_ARCH,
  readElfMachine
} = require('../../native-build/linux/verify-linux-glibc-floor.cjs')

/** Only normal GNU slots replace the npm native addon; all other platform payloads stay unchanged. */
export const IROH_PREBUILD_FILES = Object.freeze({
  'linux-x64-glibc': 'iroh/iroh.linux-x64-gnu.node',
  'linux-arm64-glibc': 'iroh/iroh.linux-arm64-gnu.node'
})

/** Change the recipe identity whenever its source, compiler, inputs, or build command changes. */
export const IROH_BUILD_IDENTITY = Object.freeze({
  sdkVersion: '1.1.0',
  sourceRevision: '16221a5286fd201c00fab6e9a316285a05492b39',
  sourceArchiveSha256: 'aaeaabe52301fea4bf60646b1a5effd8be123d0a1a2c127f5faa919fb64ee881',
  compilerVersion: '1.91.1',
  compilerArchiveDate: '2025-11-10',
  compilerArchives: Object.freeze({
    'x86_64-unknown-linux-gnu': Object.freeze({
      cargo: '8d17d5a4734e684228adee4ea4a75da94eb7f71993804adf29f344709e65fe09',
      rustc: '4b4c596fc5268435c310a79c2e231a5a3567572c930ac0740ef9e147e83baf4e',
      'rust-std': '2023ed689529516d7bd5533738ca6d205b2561f8d51947dabeeb39dd51a024c9'
    }),
    'aarch64-unknown-linux-gnu': Object.freeze({
      cargo: '827692e153382eadc39b6f1262e20ed9671e1c0abf2fb14b5095816d2b295a15',
      rustc: 'b9040293bc84d8b48cb859dcd0e95955c13ea29e3e637c7556bf7f0c12972217',
      'rust-std': '6aed0726a0fe50cbd488f6c5dd7a053c17ff57b8b361d14bcd216ea9939fb531'
    })
  }),
  recipe: 'cargo-locked-release-strip-symbols-gcc-v1'
})

/** Rehash cached inputs and publish downloads only after their pinned checksum passes. */
export async function fetchIrohBuildInput({ url, destination, sha256 }) {
  if (existsSync(destination) && (await sha256File(destination)) === sha256) {
    return destination
  }
  mkdirSync(dirname(destination), { recursive: true })
  const partial = `${destination}.partial-${process.pid}`
  try {
    await download(url, partial)
    const actual = await sha256File(partial)
    if (actual !== sha256) {
      throw new Error(
        `[orcad-prebuilds] iroh build input sha256 mismatch for ${url}: ${actual}, expected ${sha256}`
      )
    }
    renameSync(partial, destination)
    return destination
  } finally {
    rmSync(partial, { force: true })
  }
}

/** Refuse absent, stale, corrupt, or wrong-architecture SDK bytes before a consumer copies them. */
export function verifyIrohPrebuild({ slotDir, slot, entry, version }) {
  const relative = Object.hasOwn(IROH_PREBUILD_FILES, slot) ? IROH_PREBUILD_FILES[slot] : null
  if (!relative) {
    throw new Error(`[orcad-prebuilds] unsupported iroh prebuild slot: ${slot}`)
  }
  if (!isDeepStrictEqual(entry?.iroh, IROH_BUILD_IDENTITY)) {
    throw new Error(`[orcad-prebuilds] ${slot}: stale or missing iroh build identity`)
  }
  if (version !== IROH_BUILD_IDENTITY.sdkVersion) {
    throw new Error(
      `[orcad-prebuilds] ${slot}: iroh SDK version ${version} does not match ${IROH_BUILD_IDENTITY.sdkVersion}`
    )
  }
  const source = join(slotDir, ...relative.split('/'))
  if (!existsSync(source) || !lstatSync(source).isFile()) {
    throw new Error(`[orcad-prebuilds] ${slot}/${relative}: missing iroh native file`)
  }
  const expected = entry.files?.[relative]
  const bytes = readFileSync(source)
  if (
    !/^[a-f0-9]{64}$/.test(expected ?? '') ||
    createHash('sha256').update(bytes).digest('hex') !== expected
  ) {
    throw new Error(
      `[orcad-prebuilds] ${slot}/${relative}: iroh sha256 does not match the manifest`
    )
  }
  const arch = slot === 'linux-x64-glibc' ? 'x64' : 'arm64'
  if (
    bytes.length < 64 ||
    !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    readElfMachine(source) !== ELF_MACHINE_BY_ARCH[arch]
  ) {
    throw new Error(
      `[orcad-prebuilds] ${slot}/${relative}: iroh architecture must be ELF64 ${arch}`
    )
  }
  return source
}

/** Build the pinned SDK with the floor container's GCC and a verified, workspace-local Rust toolchain. */
export async function buildIrohPrebuild({ root, slot, workDir }) {
  if (!Object.hasOwn(IROH_PREBUILD_FILES, slot)) {
    throw new Error(`[orcad-prebuilds] unsupported iroh prebuild slot: ${slot}`)
  }
  const arch = slot === 'linux-x64-glibc' ? 'x64' : 'arm64'
  if (
    process.platform !== 'linux' ||
    process.arch !== arch ||
    !process.report?.getReport()?.header?.glibcVersionRuntime
  ) {
    throw new Error(`[orcad-prebuilds] ${slot}: iroh must be built on its native Linux GNU host`)
  }
  root = resolve(root)
  workDir = resolve(workDir)
  const workspacePath = relativePath(root, workDir)
  if (
    !workspacePath ||
    workspacePath === '..' ||
    workspacePath.startsWith(`..${sep}`) ||
    isAbsolute(workspacePath)
  ) {
    throw new Error('[orcad-prebuilds] iroh workDir must be inside the workspace')
  }
  const target = arch === 'x64' ? 'x86_64-unknown-linux-gnu' : 'aarch64-unknown-linux-gnu'
  const cacheDir = join(root, 'out', 'iroh-build-cache')
  const identity = IROH_BUILD_IDENTITY
  const sourceArchive = await fetchIrohBuildInput({
    url: `https://codeload.github.com/n0-computer/iroh-ffi/tar.gz/${identity.sourceRevision}`,
    destination: join(cacheDir, `iroh-ffi-${identity.sourceRevision}.tar.gz`),
    sha256: identity.sourceArchiveSha256
  })
  const components = []
  for (const [component, sha256] of Object.entries(identity.compilerArchives[target])) {
    const name = `${component}-${identity.compilerVersion}-${target}`
    const archive = await fetchIrohBuildInput({
      url: `https://static.rust-lang.org/dist/${identity.compilerArchiveDate}/${name}.tar.xz`,
      destination: join(cacheDir, `${name}.tar.xz`),
      sha256
    })
    components.push({ name, archive })
  }
  // All source/compiler archives are verified before any archive is extracted or installer executed.
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })
  const { runProcessSync } = await import('@orca/process-host')
  /** Propagate native build failures without a shell or process-wide environment changes. */
  function run(program, args, env = process.env) {
    const result = runProcessSync({
      program,
      args,
      cwd: workDir,
      env,
      stdio: 'inherit',
      timeoutMs: null
    })
    if (result.code !== 0) {
      throw new Error(`[orcad-prebuilds] iroh ${program} failed (status ${result.code})`)
    }
  }
  run('tar', ['-xzf', sourceArchive, '-C', workDir])
  const sourceDir = join(workDir, `iroh-ffi-${identity.sourceRevision}`)
  if (!existsSync(join(sourceDir, 'Cargo.lock'))) {
    throw new Error('[orcad-prebuilds] pinned iroh source is missing Cargo.lock')
  }
  const prefix = join(workDir, 'rust')
  for (const { name, archive } of components) {
    run('tar', ['-xJf', archive, '-C', workDir])
    // The official installer defaults to /usr/local and ldconfig; explicitly disable both global effects.
    run('bash', [join(workDir, name, 'install.sh'), `--prefix=${prefix}`, '--disable-ldconfig'])
  }
  const env = {
    ...process.env,
    PATH: `${join(prefix, 'bin')}${sep === '/' ? ':' : ';'}${process.env.PATH ?? ''}`,
    CARGO_HOME: join(workDir, 'cargo-home'),
    RUSTC: join(prefix, 'bin', 'rustc'),
    RUSTC_WRAPPER: '',
    RUSTC_WORKSPACE_WRAPPER: '',
    CC: 'gcc',
    [`CARGO_TARGET_${target.toUpperCase().replaceAll('-', '_')}_LINKER`]: 'gcc'
  }
  console.log(
    `[orcad-prebuilds] compiling iroh ${identity.sdkVersion} for ${slot} with Rust ${identity.compilerVersion} ...`
  )
  run(
    join(prefix, 'bin', 'cargo'),
    [
      'build',
      '--locked',
      '--release',
      '--manifest-path',
      join(sourceDir, 'iroh-js', 'Cargo.toml'),
      '--package',
      'number0_iroh',
      '--target',
      target,
      '--target-dir',
      join(workDir, 'target'),
      '--config',
      'profile.release.strip="symbols"'
    ],
    env
  )
  const source = join(workDir, 'target', target, 'release', 'libnumber0_iroh.so')
  if (!existsSync(source)) {
    throw new Error(`[orcad-prebuilds] iroh build did not produce ${source}`)
  }
  return { relative: IROH_PREBUILD_FILES[slot], source, identity }
}
