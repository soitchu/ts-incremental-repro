#!/usr/bin/env node
// Repro: a composite project replays cached diagnostics forever, even though every
// input version recorded in its own .tsbuildinfo matches the file on disk.
//
//   node repro.mjs [path-to-compiler]     default: node_modules/.bin/tsgo
//
// Exit 0 = compiler recovered (correct). Exit 1 = compiler replayed a stale error.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const compiler = resolve(process.argv[2] ?? 'node_modules/.bin/tsgo')
const buildInfo = resolve(root, 'b/dist/tsconfig.tsbuildinfo')
const aSource = resolve(root, 'a/src/index.ts')

const WITH_BAR = 'export const foo = 1\nexport const bar = 2\n'
const WITHOUT_BAR = 'export const foo = 1\n'

function build(...args) {
  try {
    return {
      ok: true,
      out: execFileSync(compiler, ['-b', 'tsconfig.sln.json', ...args], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    }
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

function readBuildInfo() {
  const parsed = JSON.parse(readFileSync(buildInfo, 'utf8'))
  return parsed.program ?? parsed
}

function findDtsIndex(info) {
  const index = info.fileNames.findIndex((name) => name.includes('a/dist/index.d.ts'))
  if (index === -1) {
    throw new Error("a/dist/index.d.ts is not in the dependent's buildinfo")
  }
  return index
}

for (const dir of ['a/dist', 'b/dist']) {
  rmSync(resolve(root, dir), { recursive: true, force: true })
}

writeFileSync(aSource, WITH_BAR)
if (!build().ok) {
  throw new Error('step 1 was expected to succeed')
}
const clean = readBuildInfo()

writeFileSync(aSource, WITHOUT_BAR)
const broken = build()
if (broken.ok || !broken.out.includes('TS2305')) {
  throw new Error(`step 2 was expected to report TS2305, got: ${broken.out}`)
}
const error = JSON.parse(readFileSync(buildInfo, 'utf8'))
const errorProgram = error.program ?? error

writeFileSync(aSource, WITH_BAR)
if (!build().ok) {
  throw new Error('step 3 was expected to succeed')
}

// Every recorded input version now matches disk; only the cached diagnostics are old.
errorProgram.fileInfos[findDtsIndex(errorProgram)] = clean.fileInfos[findDtsIndex(clean)]
writeFileSync(buildInfo, JSON.stringify(error))

const replay = build()
const forced = build('--force')

console.log(`compiler:            ${compiler}`)
console.log(`version:             ${readBuildInfo().version ?? 'unknown'}`)
console.log(`incremental rebuild: ${replay.ok ? 'clean' : replay.out.trim()}`)
console.log(`--force rebuild:     ${forced.ok ? 'clean' : forced.out.trim()}`)

if (replay.ok) {
  console.log('\nPASS: recovered: cached diagnostics were revalidated against current inputs.')
  process.exit(0)
}

console.log(
  '\nFAIL: replayed a stale TS2305 against an a/dist/index.d.ts that exports `bar`.\n' +
    'Recorded input versions all match disk, so no input change can ever clear it.\n' +
    `Only --force or deleting ${buildInfo} recovers.`,
)
process.exit(1)
