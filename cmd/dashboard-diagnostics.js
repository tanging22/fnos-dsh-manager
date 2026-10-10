/**
 * Diagnostics: the checks worth running before blaming the network.
 *
 * Everything here is read-only and cheap. Each check reports `status` of `pass`,
 * `warn`, or `fail` plus a `detail` string and, where useful, a `fix` hint.
 */

import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { activeDshHome, npmBin, NODE_BIN } from './dashboard-utils.js'
import {
  CREDENTIALS_PATH,
  ENV_PATH,
  CONFIG_PATH,
  dshLaunch,
  dshRoot,
  effectiveMode,
  loadConfig,
  managedAppDir,
} from './dashboard-config.js'
import { listenPort, pinnedVersion } from './dashboard-process.js'

function check(label, fn) {
  try {
    const out = fn()
    return { label, status: out.status ?? 'pass', detail: out.detail ?? '', fix: out.fix ?? '' }
  } catch (error) {
    return { label, status: 'fail', detail: error?.message ?? String(error), fix: '' }
  }
}

function modeOf(path) {
  try {
    return (statSync(path).mode & 0o777).toString(8)
  } catch {
    return null
  }
}

function readable(path) {
  try {
    accessSync(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

/** Listener count on a TCP port, or `null` when the tool is unavailable. */
function portListeners(port) {
  const result = spawnSync('sh', ['-c', `ss -ltn "sport = :${port}" 2>/dev/null | tail -n +2 | wc -l`], {
    encoding: 'utf8',
    timeout: 5000,
  })
  if (result.error || result.status !== 0) return null
  const count = Number((result.stdout ?? '').trim())
  return Number.isFinite(count) ? count : null
}

export function runDiagnostics() {
  const home = activeDshHome()
  const checks = []

  // A config that failed to parse is silent by nature — the panel just behaves
  // as if the user had never set anything. Surface it as a hard failure with
  // the exact reason and the fix, so "my settings keep resetting" is
  // answerable from the Diagnostics tab alone.
  checks.push(check('panel config', () => {
    const config = loadConfig()
    const error = config.__parseError || ''
    if (error) {
      return {
        status: 'fail',
        detail: `${CONFIG_PATH} is not readable as JSON: ${error}`,
        fix: 'Fix the file by hand, or delete it to regenerate defaults (Settings are lost).',
      }
    }
    return { status: 'pass', detail: `${CONFIG_PATH} (mode=${config.mode})` }
  }))

  checks.push(check('dsh install', () => {
    const root = dshRoot()
    if (!root) {
      const managed = managedAppDir()
      return {
        status: effectiveMode() === 'managed' ? 'fail' : 'warn',
        detail: managed
          ? `no dsh found under ${managed}`
          : 'no version installed yet',
        fix: 'Install a dsh version from the Versions tab.',
      }
    }
    return { status: 'pass', detail: root }
  }))

  checks.push(check('dsh binary', () => {
    const launch = dshLaunch()
    if (!launch) return { status: 'fail', detail: 'no launcher resolved', fix: 'Install dsh.' }
    const target = launch.args[0] || launch.bin
    if (!existsSync(target)) return { status: 'fail', detail: `${target} missing` }
    return { status: 'pass', detail: `${launch.bin} ${launch.args.join(' ')}`.trim() }
  }))

  checks.push(check('home directory', () => {
    if (!existsSync(home)) {
      return { status: 'warn', detail: `${home} does not exist yet`, fix: 'Start dsh once to create it.' }
    }
    if (!readable(home)) {
      return { status: 'fail', detail: `${home} is not readable`, fix: `chmod u+rwX ${home} (and chown it to the app user)` }
    }
    return { status: 'pass', detail: home }
  }))

  // What to check here flipped: dsh >= 0.2.1-alpha.2 rejects wildcard binds, so
  // a patch pinning 0.0.0.0 is now the *broken* state, not the healthy one.
  // Valid YAML shapes are asserted too — the v1.0.2 writer shipped a file that
  // threw before dsh ever validated anything.
  checks.push(check('patch file', () => {
    const patch = join(home, 'profiles/web/cordis.patch.yml')
    if (!existsSync(patch)) {
      return { status: 'warn', detail: `${patch} absent; dsh will bind loopback`, fix: 'Pick a LAN address in Settings if you need direct LAN access.' }
    }
    const text = readFileSync(patch, 'utf8')
    // Deliberately not pulling in a YAML library: the panel must stay
    // dependency-free, and the only two shapes worth judging here are (a) the
    // sequence-item indentation grammar this file's whole history got wrong and
    // (b) whether the pinned address is one dsh will accept.
    const lines = text.split(/\r?\n/)
    const start = lines.findIndex((line) => /^-\s*id:\s*webserver\s*$/.test(line))
    if (start < 0) return { status: 'warn', detail: 'no webserver override; dsh binds loopback', fix: 'Pick a LAN address in Settings.' }
    // Report every problem at once rather than the first: the v1.0.2 file had a
    // wrong indent AND a wildcard, and naming only one leaves the user guessing
    // why a settings save fixed it.
    const faults = []
    let host = null
    let port = null
    // One-line file preview then follows, so the user sees the real shape.
    //
    // This is a tiny stack machine instead of a magic number because the two
    // levels here are genuinely different depths: `- id:` puts `id` at column 3,
    // so the item's other keys (`config:`) must also start at column 3, while
    // `config:`'s own children (`host:`, `port:`) go deeper still. Every indent
    // therefore either opens a new level below the current one or lines up with
    // some enclosing key — anything else is what YAML rejects as bad
    // indentation. v1.0.2 wrote `config:` at 4 and its leaves at 8, i.e. it
    // never lined up with anything, and that is exactly what we report.
    const levels = []
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i]
      if (/^-\s/.test(line)) break
      if (!line.trim() || /^\s*#/.test(line)) continue
      const indent = line.length - line.trimStart().length
      if (levels.length === 0) {
        // First key of the item: it belongs beside `id`, i.e. two spaces in.
        if (indent !== 2) faults.push(`line ${i + 1} starts at column ${indent + 1}; the block's keys must start at column 3, beside "id"`)
        levels.push(indent)
      } else if (indent > levels[levels.length - 1]) {
        levels.push(indent)
      } else {
        const anchor = levels.indexOf(indent)
        if (anchor < 0) {
          faults.push(`line ${i + 1} lands at column ${indent + 1}, which lines up with no enclosing key`)
        } else {
          levels.length = anchor + 1
        }
      }
      const keyed = /^\s*([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(line)
      if (!keyed) continue
      if (keyed[1] === 'host') host = keyed[2].replace(/^["']|["']$/g, '')
      if (keyed[1] === 'port') port = keyed[2].replace(/^["']|["']$/g, '')
    }
    if (!host) faults.push('webserver block has no usable config.host')
    if (host && ['0.0.0.0', '::', '[::]'].includes(host)) {
      faults.push(`wildcard ${host} is rejected by dsh >= 0.2.1-alpha.2`)
    }
    if (faults.length) {
      return {
        status: 'fail',
        detail: faults.join('; '),
        fix: 'Save the network settings again to rewrite the patch.',
      }
    }
    return { status: 'pass', detail: `webserver pinned to ${host}${port ? `:${port}` : ''}` }
  }))

  checks.push(check('credentials', () => {
    for (const file of [CREDENTIALS_PATH, ENV_PATH]) {
      if (!existsSync(file)) continue
      const mode = modeOf(file)
      if (mode && mode !== '600') {
        return { status: 'fail', detail: `${file} is mode ${mode}; dsh requires 600`, fix: `chmod 600 ${file}` }
      }
      return { status: 'pass', detail: `${file} (mode ${mode})` }
    }
    return { status: 'warn', detail: 'no credentials file yet', fix: 'Set the DeepSeek API key in Settings.' }
  }))

  checks.push(check('port', () => {
    const port = listenPort()
    const count = portListeners(port)
    if (count === null) return { status: 'pass', detail: `port ${port} (listener count unavailable)` }
    if (count === 0) return { status: 'pass', detail: `port ${port} free` }
    return {
      status: 'warn',
      detail: `port ${port} already in use (${count} listener)`,
      fix: 'Stop the other instance or change the port.',
    }
  }))

  checks.push(check('node runtime', () => {
    const version = process.versions.node
    return Number(version.split('.')[0]) >= 22
      ? { status: 'pass', detail: `node ${version}` }
      : { status: 'warn', detail: `node ${version}; dsh expects >= 22` }
  }))

  checks.push(check('npm executable', () => {
    const bin = npmBin()
    const found = bin !== 'npm' && existsSync(bin)
    if (bin === 'npm') {
      return { status: 'warn', detail: 'npm not found next to node; relying on PATH', fix: 'Install npm alongside node.' }
    }
    return found
      ? { status: 'pass', detail: bin }
      : { status: 'fail', detail: `npm missing at ${bin}`, fix: 'Install npm (or nodejs dependency) via fnOS.' }
  }))

  checks.push(check('git', () => {
    const result = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 5000 })
    if (result.error) return { status: 'warn', detail: 'git not found (only needed for some plugins)' }
    return { status: 'pass', detail: (result.stdout || '').trim() }
  }))

  return {
    summary: {
      mode: effectiveMode(),
      managedAppDir: managedAppDir(),
      dshRoot: dshRoot(),
      home,
      port: listenPort(),
      node: NODE_BIN,
      nodeVersion: process.versions.node,
      npm: npmBin(),
    },
    checks,
    pinned: pinnedVersion(),
  }
}
