/**
 * Patches: the small, idempotent edits applied to dsh's own client bundles.
 *
 * Why this module exists
 * ----------------------
 * Two upstream behaviours break specifically under this panel's deployment, and
 * neither is configurable, so both are repaired in place:
 *
 * 1. **Settings host-mode.** dsh decides where the settings UI reads and writes
 *    from by asking whether the server connection is loopback:
 *
 *        const persistence = ctx.remote.$host.isLoopback ? "host" : "memory"
 *
 *      - loopback  (`127.0.0.1`)       -> `"host"`   -> reads server settings
 *      - non-loopback (`10.11.12.13`)  -> `"memory"` -> process-local only
 *
 *    `"memory"` is process-local and the settings RPC is loopback-only by design, so
 *    a non-loopback visitor gets an **empty** settings page: plugin and model lists
 *    come back blank. That is exactly the panel's audience here — this panel binds
 *    `0.0.0.0:28000` and hands LAN clients a session cookie, so from the browser's
 *    point of view the connection is never loopback.
 *
 * 2. **Unreadable-ancestor fsync.** After every attachment write dsh walks from the
 *    store directory up to the filesystem root, fsyncing each ancestor, to prove the
 *    new directory entry is durable:
 *
 *        await ensureDurableDirectory(home, parse(home).root)   // stop = "/"
 *
 *    On fnOS the intermediate mount point is `d---------  root:root /vol1`, so the
 *    walk reaches a directory this process cannot even open and the whole upload
 *    dies with `EACCES: permission denied, open '/vol1'` — even though the store
 *    itself (`${DSH_HOME}/attachments/v1`) is owned by us and perfectly writable.
 *    Durability of a mount point the process cannot read is the operator's
 *    contract, not ours, so the walk now stops at the first unreadable level.
 *
 * techyssy/deepseek-harness-fnos solves (1) by rewriting the ternary in a python
 * patch run at install time. We do the same edit from the panel instead, because
 * (a) the panel is already the place an operator manages dsh, and (b) a runtime
 * repair survives a version switch, which a build-time patch cannot.
 *
 * Consequences, stated plainly
 * ----------------------------
 * Patch 1 lifts dsh's intentional loopback-only guard on the settings RPC. Combined
 * with the panel's trust fence that is the intended exposure: LAN and FN Connect
 * clients can now read and write server-side configuration. Do **not** publish
 * `:28000` / `:28001` to an untrusted network.
 *
 * Patch 2 gives up a durability guarantee above the process's own home. The data
 * written below it — the attachment bytes themselves, their directory entries, and
 * every level the process owns — is still fsynced exactly as before.
 *
 * Design notes
 * ------------
 *  - **All versions, not just the current one.** Switching version with the
 *    patch applied to only `current` would silently drop it on the next switch,
 *    so every installed version under `${DATA_DIR}/versions/` is scanned.
 *  - **Idempotent.** A marker comment makes re-runs a no-op, and every report
 *    distinguishes `patched` from `already` from `missing` so a silent no-op can
 *    never be mistaken for success.
 *  - **`missing` is not an error.** Newer dsh may drop the ternary, or fix the
 *    fsync walk itself; the correct outcome then is "nothing to do", not a red
 *    badge.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { VERSIONS_DIR } from './dashboard-config.js'

/**
 * The settings host-mode patch.
 *
 * `connection.isLoopback` was the 0.1.x spelling; `ctx.remote.$host.isLoopback`
 * is current. A `\w.$` receiver class keeps this stable across that rename
 * without going after anything vaguer.
 */
const SETTINGS_PATCH = {
  id: 'settings-host-mode',
  marker: '/* dsh-console: settings host-mode patch */',
  markerRe: /dsh-console: settings host-mode patch/,
  // Bundles that may carry the ternary. `dsh-client-ui-settings` is the one that
  // matters: it owns the persistence choice itself. The `-models` sibling used to
  // carry its own copy and stopped doing so, but it is scanned anyway — a future
  // version could reintroduce it, and a scan costs a stat call.
  files: [
    'dsh-client-ui-settings/lib/client.js',
    'dsh-client-ui-settings-models/lib/client.js',
  ],
  find: /[\w.$]+\.isLoopback \? "host" : "memory"/g,
  replace: '"host"',
}

/**
 * The unreadable-ancestor fsync patch.
 *
 * Matched on the `open()` call rather than on surrounding whitespace: bundlers
 * reindent freely, but this call is the only `open(path, constants.O_RDONLY)` in
 * the module and the lexical shape has held across releases. The marker rides
 * inside the branch we add, so "patched by us" and "fixed upstream" stay
 * distinguishable without a second write.
 */
const FSYNC_PATCH = {
  id: 'unreadable-ancestor-fsync',
  markerRe: /dsh-console: unreadable-ancestor fsync patch/,
  files: ['dsh-attachment-local/lib/index.js'],
  // `;?` because a bundler may drop the semicolon; matching it when present
  // keeps the replacement from leaving a stray `;` after the closing brace.
  find: /const handle = await open\(path, constants\.O_RDONLY\);?/,
  replace: [
    'let handle;',
    '\ttry {',
    '\t\thandle = await open(path, constants.O_RDONLY);',
    '\t} catch (error) {',
    '\t\t/* dsh-console: unreadable-ancestor fsync patch -- durability above the home line is the operator\'s. */',
    '\t\tif (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM")) return;',
    '\t\tthrow error;',
    '\t}',
  ].join('\n'),
}

/** Every patch this panel owns, applied in order. */
const PATCHES = [SETTINGS_PATCH, FSYNC_PATCH]

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

/**
 * Rewrite one bundle in place. Returns the state it ended in.
 *
 * `already` short-circuits on the marker before the search, so a bundle patched
 * by an older panel build is never rewritten a second time.
 */
function patchFile(path, patch) {
  const original = readFileSync(path, 'utf8')
  if (patch.markerRe.test(original)) return 'already'
  if (!patch.find.test(original)) {
    // `lastIndex` is stateful on a /g regex; reset before the next file.
    patch.find.lastIndex = 0
    return 'missing'
  }
  patch.find.lastIndex = 0
  const patched = original.replace(patch.find, patch.replace)
  // Only the settings patch prepends a file-level marker: it replaces a whole
  // expression, leaving no other place to hang one, and nothing depends on those
  // bundles' prologue staying first. The fsync patch carries its own inline.
  writeFileSync(path, patch.marker ? `${patch.marker}\n${patched}` : patched)
  return 'patched'
}

/**
 * Apply every patch everywhere and report what happened.
 *
 * Returns `{ ok, versions: [{ version, files: [{ file, patch, state }] }] }`. `ok`
 * is true even when every file reports `missing`, because that means upstream no
 * longer needs the patch — only an unreadable install makes it false.
 */
export function applyPatches() {
  const versions = []
  let ok = true
  for (const version of versionRoots()) {
    const files = []
    for (const patch of PATCHES) {
      for (const relative of patch.files) {
        const path = join(VERSIONS_DIR, version, 'node_modules', '@deepseek-ai', relative)
        if (!existsSync(path)) continue
        try {
          files.push({ file: relative, patch: patch.id, state: patchFile(path, patch) })
        } catch (error) {
          files.push({ file: relative, patch: patch.id, state: 'error', error: error?.message ?? String(error) })
          ok = false
        }
      }
    }
    versions.push({ version, files })
  }
  return { ok, versions }
}
