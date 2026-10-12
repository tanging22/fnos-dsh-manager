/**
 * Patches: the small, idempotent edits applied to dsh's own client bundles.
 *
 * Why this module exists
 * ----------------------
 * dsh decides where the settings UI reads and writes from by asking whether the
 * server connection is loopback:
 *
 *     const persistence = ctx.remote.$host.isLoopback ? "host" : "memory"
 *
 *   - loopback  (`127.0.0.1`)       -> `"host"`   -> reads server settings
 *   - non-loopback (`10.11.12.13`)  -> `"memory"` -> process-local only
 *
 * `"memory"` is process-local and the settings RPC is loopback-only by design, so
 * a non-loopback visitor gets an **empty** settings page: plugin and model lists
 * come back blank. That is exactly the panel's audience here — this panel binds
 * `0.0.0.0:28000` and hands LAN clients a session cookie, so from the browser's
 * point of view the connection is never loopback.
 *
 * techyssy/deepseek-harness-fnos solves the same problem by rewriting the ternary
 * to the literal `"host"` in a python patch run at install time. We do the same
 * edit from the panel instead, because (a) the panel is already the place an
 * operator manages dsh, and (b) a runtime repair survives a version switch, which
 * a build-time patch cannot.
 *
 * Consequences, stated plainly
 * ----------------------------
 * This lifts dsh's intentional loopback-only guard on the settings RPC. Combined
 * with the panel's trust fence that is the intended exposure: LAN and FN Connect
 * clients can now read and write server-side configuration. Do **not** publish
 * `:28000` / `:28001` to an untrusted network.
 *
 * Design notes
 * ------------
 *  - **All versions, not just the current one.** Switching version with the
 *    patch applied to only `current` would silently drop it on the next switch,
 *    so every installed version under `${DATA_DIR}/versions/` is scanned.
 *  - **Idempotent.** A marker comment makes re-runs a no-op, and every report
 *    distinguishes `patched` from `already` from `missing` so a silent no-op can
 *    never be mistaken for success.
 *  - **`missing` is not an error.** Newer dsh may drop the ternary; the correct
 *    outcome then is "nothing to do", not a red badge.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { VERSIONS_DIR } from './dashboard-config.js'

/** Marker prepended so a re-run can tell "patched by us" from "already upstream". */
const MARKER = '/* dsh-console: settings host-mode patch */'
const MARKER_RE = /dsh-console: settings host-mode patch/

/**
 * The ternary, matched for any receiver.
 *
 * `connection.isLoopback` was the 0.1.x spelling; `ctx.remote.$host.isLoopback`
 * is current. A `\w.$` receiver class keeps this stable across that rename
 * without going after anything vaguer.
 */
const TERNARY = /[\w.$]+\.isLoopback \? "host" : "memory"/g
const REPLACEMENT = '"host"'

/**
 * Bundles that may carry the ternary.
 *
 * `dsh-client-ui-settings` is the one that matters: it owns the persistence
 * choice itself. The `-models` sibling used to carry its own copy and stopped
 * doing so, but it is scanned anyway — a future version could reintroduce it,
 * and a scan costs a stat call.
 */
const CANDIDATES = [
  'dsh-client-ui-settings/lib/client.js',
  'dsh-client-ui-settings-models/lib/client.js',
]

/** Installed version dirs, newest first, skipping anything without node_modules. */
function versionRoots() {
  if (!existsSync(VERSIONS_DIR)) return []
  const roots = []
  for (const entry of readdirSync(VERSIONS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const modules = join(VERSIONS_DIR, entry.name, 'node_modules', '@deepseek-ai')
    if (existsSync(modules)) roots.push(entry.name)
  }
  return roots.sort().reverse()
}

/** Rewrite one bundle in place. Returns the state it ended in. */
function patchFile(path) {
  const original = readFileSync(path, 'utf8')
  if (MARKER_RE.test(original)) return 'already'
  if (!TERNARY.test(original)) {
    // `lastIndex` is stateful on a /g regex; reset before the next file.
    TERNARY.lastIndex = 0
    return 'missing'
  }
  TERNARY.lastIndex = 0
  const patched = original.replace(TERNARY, REPLACEMENT)
  // Marker on line one so `grep -rl MARKER` finds it at a glance. Nothing
  // depends on the bundles' prologue staying first, so prepend unconditionally.
  writeFileSync(path, `${MARKER}\n${patched}`)
  return 'patched'
}

/**
 * Apply the settings host-mode patch everywhere and report what happened.
 *
 * Returns `{ ok, versions: [{ version, files: [{ file, state }] }] }`. `ok` is
 * true even when every file reports `missing`, because that means upstream no
 * longer needs the patch — only an unreadable install makes it false.
 */
export function applyPatches() {
  const versions = []
  let ok = true
  for (const version of versionRoots()) {
    const files = []
    for (const relative of CANDIDATES) {
      const path = join(VERSIONS_DIR, version, 'node_modules', '@deepseek-ai', relative)
      if (!existsSync(path)) continue
      try {
        files.push({ file: relative, state: patchFile(path) })
      } catch (error) {
        files.push({ file: relative, state: 'error', error: error?.message ?? String(error) })
        ok = false
      }
    }
    versions.push({ version, files })
  }
  return { ok, versions }
}
