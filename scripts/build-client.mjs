#!/usr/bin/env node
/**
 * Build the browser half as a DSH client-module bundle.
 *
 * The Host serves `lib/client.js`; the factory receives the platform
 * `require` and resolves React from the shared module table.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..')
const ENTRY = resolve(PACKAGE_ROOT, 'src/client/index.tsx')
const OUT_DIR = resolve(PACKAGE_ROOT, 'lib')
const OUT_FILE = resolve(OUT_DIR, 'client.js')

const result = await build({
  entryPoints: [ENTRY],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  logLevel: 'silent',
})

const body = result.outputFiles?.[0]?.text
if (body === undefined) throw new Error('esbuild produced no client bundle')

const wrapped = `window.__ModuleLoader__.load({
  id: "dsh-ultracode",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${body}
    return module.exports;
  }
});
`

await mkdir(OUT_DIR, { recursive: true })
await writeFile(OUT_FILE, wrapped, 'utf8')
console.log(`built ${OUT_FILE}`)
