#!/usr/bin/env node
/**
 * Proves the built `lib/` is self-contained: copy it into a fresh temp directory
 * (whose parent chain has no `node_modules`), import both entries, and assert the
 * bundle only reaches `node:*`.
 *
 * This is the property that lets a `link:` install load without the checkout's
 * dependencies. Run it after `pnpm run build`; CI can run `pnpm run check-bundle`.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const work = mkdtempSync(join(tmpdir(), 'dsh-bridge-bundle-'))

try {
  cpSync(join(packageRoot, 'lib'), join(work, 'lib'), { recursive: true })
  cpSync(join(packageRoot, 'package.json'), join(work, 'package.json'))

  const specifiers = new Set()
  for (const entry of ['index.js', 'invariant.js']) {
    const file = join(work, 'lib', entry)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) specifiers.add(match[1])
    await import(pathToFileURL(file).href)
  }

  const external = [...specifiers].filter((specifier) => !specifier.startsWith('node:'))
  if (external.length > 0) {
    console.error(`FAIL ${manifest.name}@${manifest.version}: bundle still imports ${external.join(', ')}`)
    process.exitCode = 1
  } else {
    console.log(
      `ok ${manifest.name}@${manifest.version}: no node_modules needed, imports ${[...specifiers].sort().join(', ')}`,
    )
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
