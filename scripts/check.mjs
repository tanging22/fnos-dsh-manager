#!/usr/bin/env node
/**
 * Syntax gate for everything that has to parse on the NAS.
 *
 * Two rules learned the hard way:
 *  - The entry points (cmd/dashboard.js, cmd/dashboard-server.js) and the
 *    browser bundle start real servers / touch `window`, so they are only
 *    syntax-checked, never imported.
 *  - `node --check` reports mojibake as an unexplained token error, so run this
 *    on a checkout saved as UTF-8 (the write tool does; PowerShell's
 *    Set-Content does not).
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Files that must not be imported here, only parsed. */
const SYNTAX_ONLY = new Set([
  // Start a real HTTP server / spawn processes on import.
  'cmd/dashboard.js',
  'cmd/dashboard-server.js',
  // Browser bundles: they touch `window` at module scope and have no meaning
  // in Node. dom.js runs inside the panel's iframe, not here.
  'ui/assets/app.js',
  'ui/assets/dom.js',
  'ui/assets/views/logs.js',
  'ui/assets/views/overview.js',
  'ui/assets/views/plugins.js',
  'ui/assets/views/settings.js',
  'ui/assets/views/versions.js',
  'ui/assets/views/workspace.js',
  // Vendored third-party browser bundle (@trimjs/web-app@0.5.0 dist/index.js,
  // unmodified). It reads `window` at module scope by design, so only its
  // syntax is checked here — its behaviour is the host SDK's, not ours.
  'ui/assets/vendor/trim-web-app.js',
  // This script: importing it would re-run the whole gate, recursively.
  'scripts/check.mjs',
])

/** Files to parse: every .js under cmd/ and ui/, plus the scripts themselves. */
function collect(dir, found = []) {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) collect(path, found)
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) found.push(path)
  }
  return found
}

const targets = [...collect('cmd'), ...collect('ui'), ...collect('scripts')]
  .map((path) => relative(ROOT, path).split('\\').join('/'))
  .sort()

let failures = 0

/* One `node --check` per file, but spawned SEQUENTIALLY with a small gap.
 *
 * They used to run back-to-back with no pacing, which is fine on the Linux CI
 * runner but fails wholesale on Windows: the freshly spawned node processes
 * collide on the same executable image and every one after the first few dies
 * with EBUSY, so `npm run check` reported dozens of bogus SYNTAX failures and
 * told you nothing. Sequential + a short pause keeps the gate honest on both.
 */
for (const target of targets) {
  const absolute = join(ROOT, target)
  try {
    execFileSync(process.execPath, ['--check', absolute], { stdio: 'pipe' })
  } catch (error) {
    const stderr = String(error.stderr ?? error.message)
    // EBUSY/ENOENT here is an environment collision, not a syntax error.
    if (/EBUSY|ENOENT|EPERM|EACCES/.test(stderr) && !/SyntaxError/.test(stderr)) {
      console.warn(`SKIP    ${target} (${stderr.split('\n')[0].trim()})`)
      continue
    }
    failures += 1
    console.error(`SYNTAX  ${target}`)
    console.error(stderr.trim().split('\n').slice(0, 4).map((line) => `        ${line}`).join('\n'))
  }
}

/* Import every non-entry module for real: catches duplicate exports, missing
   named exports, and ESM `require` slips that --check cannot see. The import is
   raced against a timer so a module that blocks at load time fails loudly
   instead of hanging the gate; the timer is cleared on the normal path or Node
   would keep the event loop alive and print an unsettled-await warning.
   scripts/ is excluded wholesale: those files are entry points that do work on
   load (make-icons.mjs rewrites the PNGs), so importing them is a side effect,
   not a test. */
const importable = targets.filter((target) => !SYNTAX_ONLY.has(target) && !target.startsWith('scripts/'))
let imported = 0
for (const target of importable) {
  let timer
  try {
    const module = await Promise.race([
      import(new URL(`../${target}`, import.meta.url)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('import timed out after 5s')), 5000)
      }),
    ])
    clearTimeout(timer)
    const names = Object.keys(module).length
    if (names === 0) console.warn(`WARN    ${target}: no exports`)
    imported += 1
  } catch (error) {
    clearTimeout(timer)
    failures += 1
    console.error(`IMPORT  ${target}`)
    console.error(`        ${error.message}`)
  }
}

/* A targeted gate for the bug that actually shipped.
 *
 * `acceptWebSocket()` called `crypto.createHash('sha1')` in a file that only
 * imported `createHash`. Node exposes a *global* `crypto` (the WebCrypto
 * object), so this parses fine, imports fine, and throws a TypeError the first
 * time a browser opens the push socket — inside an `upgrade` listener, with no
 * catch, killing the panel. `node --check` cannot see it, and the file is in
 * SYNTAX_ONLY, so nothing else looked.
 *
 * The rule: `crypto.*` in a module scope means WebCrypto, whose API is a
 * different set (`subtle`, `getRandomValues`, `randomUUID`). The hashing/cipher
 * helpers live in `node:crypto` and must be imported by name. Flag any
 * `crypto.<helper>` use that has no matching named import, so the mistake is
 * caught at build time instead of on a user's NAS.
 */
const WEB_CRYPTO_ONLY = new Set([
  'subtle', 'getRandomValues', 'randomUUID', 'randomFillSync',
  'arrayBuffer', 'Base64URL', 'HKDF',
])
/** Helpers that only exist on `node:crypto`, never on the global WebCrypto. */
const NODE_CRYPTO_ONLY = [
  'createHash', 'createHmac', 'createCipheriv', 'createDecipheriv',
  'createSign', 'createVerify', 'randomBytes', 'randomUUID',
  'timingSafeEqual', 'pbkdf2', 'scrypt', 'generateKeyPair',
]


let cryptoFailures = 0

/* Strip comments and string/template literals before scanning.
 *
 * Without this the gate cannot tell code from prose. The very file this check
 * was written for carries a comment explaining that "`crypto.createHash` here
 * threw a TypeError" — the exact text the scanner matches — so a mention in a
 * comment read as a live call site. Blanking literals keeps the signal to real
 * code and to nothing else.
 */
function stripCommentsAndStrings(text) {
  let out = ''
  let i = 0
  let mode = 'code' // code | line | block | sq | dq | tpl
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (mode === 'code') {
      if (ch === '/' && next === '/') { mode = 'line'; i += 2; continue }
      if (ch === '/' && next === '*') { mode = 'block'; i += 2; continue }
      if (ch === "'") { mode = 'sq'; i += 1; out += ' '; continue }
      if (ch === '"') { mode = 'dq'; i += 1; out += ' '; continue }
      if (ch === '`') { mode = 'tpl'; i += 1; out += ' '; continue }
      out += ch
      i += 1
      continue
    }
    if (mode === 'line') {
      if (ch === '\n') { mode = 'code'; out += '\n' }
      i += 1
      continue
    }
    if (mode === 'block') {
      if (ch === '*' && next === '/') { mode = 'code'; i += 2; continue }
      if (ch === '\n') out += '\n'
      i += 1
      continue
    }
    const terminator = mode === 'sq' ? "'" : mode === 'dq' ? '"' : '`'
    if (ch === '\\') { i += 2; continue }
    if (ch === terminator) { mode = 'code'; i += 1; continue }
    if (ch === '\n') out += '\n'
    i += 1
  }
  return out
}

for (const target of targets) {
  if (target.startsWith('scripts/')) continue
  const absolute = join(ROOT, target)
  const code = stripCommentsAndStrings(readFileSync(absolute, 'utf8'))

  // Every `crypto.<helper>(` that is not `something.crypto.<helper>(` —
  // `this.crypto`, `req.crypto` etc. are legitimate members, not the global.
  const uses = [...code.matchAll(/(?<![\w.])crypto\.([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1])
  for (const name of uses) {
    // Anything on the global WebCrypto object is legitimate.
    if (WEB_CRYPTO_ONLY.has(name)) continue
    // Flag the hashing/cipher helpers, which exist ONLY on `node:crypto`.
    //
    // An import does NOT excuse the `crypto.` prefix: `crypto.createHash`
    // resolves the *global* object no matter what was imported, so the named
    // import has to be called unqualified. That distinction is the whole bug —
    // the shipped file imported `createHash` correctly AND called
    // `crypto.createHash` by mistake, so keying off the import list hid it.
    if (!NODE_CRYPTO_ONLY.includes(name)) continue
    cryptoFailures += 1
    console.error(`CRYPTO  ${target}`)
    console.error(`        crypto.${name}() resolves the GLOBAL crypto (WebCrypto), which has no ${name}.`)
    console.error(`        Call the bare \`${name}(...)\` from the existing node:crypto import instead.`)
  }
}
failures += cryptoFailures

/* The manifest is parsed by fnOS, so a stray BOM or CRLF-quoted field breaks
   installation with no useful message. */
const MANIFEST_REQUIRED = [
  'appname',
  'version',
  'display_name',
  'desc',
  'platform',
  'source',
  'maintainer',
  'desktop_uidir',
  'desktop_applaunchname',
  'service_port',
]
const manifestPath = join(ROOT, 'manifest')
if (!existsSync(manifestPath)) {
  failures += 1
  console.error('MANIFEST is missing entirely')
} else {
  const manifest = readFileSync(manifestPath, 'utf8')
  if (manifest.charCodeAt(0) === 0xfeff) {
    failures += 1
    console.error('MANIFEST has a UTF-8 BOM')
  }
  if (manifest.includes('\r\n')) {
    failures += 1
    console.error('MANIFEST has CRLF line endings; fnOS expects LF')
  }
  for (const required of MANIFEST_REQUIRED) {
    if (!new RegExp(`^${required}\\s*=`, 'm').test(manifest)) {
      failures += 1
      console.error(`MANIFEST missing key: ${required}`)
    }
  }
  /* ui/config names the launch entry the desktop shell opens. */
  const uiConfigPath = join(ROOT, 'ui', 'config')
  if (!existsSync(uiConfigPath)) {
    failures += 1
    console.error('ui/config is missing; the suite will not appear in the desktop')
  } else {
    try {
      const uiConfig = JSON.parse(readFileSync(uiConfigPath, 'utf8'))
      const entry = /^desktop_applaunchname\s*=\s*(.+)$/m.exec(manifest)?.[1]?.trim()
      if (entry && !uiConfig['.url']?.[entry]) {
        failures += 1
        console.error(`ui/config has no .url entry for ${entry}`)
      }
    } catch (error) {
      failures += 1
      console.error(`ui/config is not valid JSON: ${error.message}`)
    }
  }
}

/* The gateway proxy and the fnOS lifecycle scripts are part of the shipped
 * product but were outside `targets`, which only collects .js/.mjs. So edits to
 * `cmd/proxy.py` or `cmd/main` got zero checking — a syntax error there would
 * surface only as a dead desktop icon at install time. Compile them here instead,
 * and skip (loudly) when the interpreter is absent rather than failing the gate.
 */
const pythonSources = ['cmd/proxy.py']
const shellSources = ['cmd/main', 'cmd/install_callback', 'cmd/upgrade_init', 'cmd/upgrade_callback',
  'cmd/config_init', 'cmd/config_callback', 'cmd/uninstall_init', 'cmd/uninstall_callback']

for (const source of shellSources) {
  if (!existsSync(join(ROOT, source))) continue
  try {
    execFileSync('bash', ['-n', join(ROOT, source)], { stdio: 'pipe' })
  } catch (error) {
    const stderr = String(error.stderr ?? error.message)
    // Same Windows collision as the JS checks above: the spawn itself failed,
    // so nothing was actually parsed and there is no syntax verdict to report.
    if (/EBUSY|ENOENT|EPERM|EACCES/.test(stderr) && !/syntax error/i.test(stderr)) {
      console.warn(`SKIP    ${source} (${stderr.split('\n')[0].trim()})`)
      continue
    }
    failures += 1
    console.error(`SHELL   ${source}`)
    console.error(`        ${stderr.trim().split('\n')[0]}`)
  }
}

/* Prefer an explicitly provided interpreter, then PATH, then the common
 * absolute locations. A Python-based WorkBuddy runtime is not on PATH, and
 * silently skipping the check is exactly how the proxy bug survived. */
const pythonCandidates = [
  process.env.PYTHON,
  'python3',
  'python',
  '/usr/bin/python3',
  'C:/Users/zhushichuan/.workbuddy/binaries/python/versions/3.13.12/python.exe',
].filter(Boolean)
const pythonBin = pythonCandidates.find((bin) => {
  try {
    execFileSync(bin, ['--version'], { stdio: 'pipe' })
    return true
  } catch (error) {
    // This environment cannot spawn non-node binaries from Node (EBUSY on
    // Windows). That is an environment limit, not a missing interpreter, and it
    // must not turn the gate red — nor silently pass as "checked and fine".
    const message = String(error.stderr ?? error.message)
    // A missing interpreter must never abort the gate: keep looking. Windows
    // returns 9009 ("not recognised as an internal or external command") for a
    // stub like the MicrosoftApps python3 shim, which is an absent interpreter,
    // not a broken one. Previously that rethrow killed the whole gate, so a
    // developer without python could not run `npm run check` at all.
    if (!/EBUSY|ENOENT|EPERM|EACCES/.test(message) && error.status !== 9009) throw error
    return false
  }
})
if (pythonBin) {
  for (const source of pythonSources) {
    const absolute = join(ROOT, source)
    if (!existsSync(absolute)) continue
    try {
      // Compile to bytecode without writing a __pycache__ next to the source.
      execFileSync(pythonBin, ['-c', `import py_compile,sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)`,
        absolute, join(tmpdir(), 'fnos-dsh-manager-proxy.pyc')], { stdio: 'pipe' })
    } catch (error) {
      failures += 1
      console.error(`PYTHON  ${source}`)
      console.error(`        ${String(error.stderr ?? error.message).trim().split('\n').slice(0, 3).join('\n        ')}`)
    }
  }
} else {
  console.warn('SKIP    python syntax (no python3/python found; set PYTHON= to enable)')
}

console.log(`\n${targets.length} parsed, ${imported} imported, ${failures} failure(s)`)
process.exit(failures ? 1 : 0)
