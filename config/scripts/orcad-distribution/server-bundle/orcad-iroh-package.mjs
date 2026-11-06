import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { ORCAD_IROH_DIR } from '../../../../src/shared/orcad-artifacts.ts'

export function stageOrcadIroh(root, outputDir, target) {
  if (target !== 'linux-x64-glibc') {
    return
  }
  try {
    const require = createRequire(join(root, 'package.json'))
    const packagePath = require.resolve('@number0/iroh/package.json')
    const sourceDir = dirname(packagePath)
    const metadata = JSON.parse(readFileSync(packagePath, 'utf8'))
    const nativePackagePath = createRequire(packagePath).resolve(
      '@number0/iroh-linux-x64-gnu/package.json'
    )
    const nativeMetadata = JSON.parse(readFileSync(nativePackagePath, 'utf8'))
    if (typeof nativeMetadata.main !== 'string' || !nativeMetadata.main) {
      throw new Error('@number0/iroh-linux-x64-gnu/package.json declares no native main')
    }
    const destination = join(outputDir, ORCAD_IROH_DIR)
    mkdirSync(destination, { recursive: true })
    // Keep the loader's explicit CJS exports for dynamic import's named exports.
    copyFileSync(join(sourceDir, 'index.js'), join(destination, 'index.js'))
    copyFileSync(
      join(dirname(nativePackagePath), nativeMetadata.main),
      join(destination, 'iroh.linux-x64-gnu.node')
    )
    // Published 1.1.0 points at nonexistent iroh-js/index.js; normalize only the staged copy.
    writeFileSync(
      join(destination, 'package.json'),
      `${JSON.stringify({ ...metadata, main: 'index.js' }, null, 2)}\n`
    )
  } catch (cause) {
    throw new Error(
      `Cannot stage Orcad ${target} Iroh from installed @number0/iroh and @number0/iroh-linux-x64-gnu: ${cause.message}`,
      { cause }
    )
  }
}
