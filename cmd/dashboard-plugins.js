/**
 * Plugin management for the supervised dsh profile.
 *
 * dsh has no `dsh plugin` CLI; plugin lifecycle lives in the host's
 * plugin-manager service, which edits two files and runs pnpm:
 *   - the profile `package.json` (`dsh.profile.bundles` array + `dependencies`)
 *   - the profile `cordis.patch.yml` (a YAML array of `{id, disabled}` entries)
 *
 * This panel is *not* the dsh host, so it cannot reload a live profile. What it
 * can do — and all the operator needs — is edit those same files on disk and
 * restart dsh to apply them. `npm` is used instead of pnpm because the panel
 * already proves npm works on the box (version installs use it) and the profile
 * uses `nodeLinker: hoisted`, which both package managers honor.
 *
 * Profile layout (see app-boot/src/profile.ts):
 *   profileDir = `${activeDshHome()}/profiles/web`
 *   package.json: { name, private, dependencies: {}, dsh: { profile: { bundles: [] } } }
 *   cordis.patch.yml: a YAML sequence; each element is a map with `id`, optional
 *     `name`, `disabled`, `insert`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
import { activeDshHome, npmBin, npmEnv as npmEnvShared, registryDoc, runWithTimeout } from './dashboard-utils.js'
import { loadConfig, DSH_PACKAGE } from './dashboard-config.js'

/** Default market plugin (the dsh-market plugin manager). */
export const MARKET_PACKAGE = 'dshmarket'

/**
 * npm 官方包名规则（scope 可选）。
 *
 * 这是**显式的安全边界**，不是形式校验：`installedDir()` 会把包名拼进
 * `join(profileDir, 'node_modules', pkg)`，而 `removeBundle()` 随后用
 * `rmSync(..., { recursive: true, force: true })` 删这个目录。`join()` 会规范化
 * `..`，所以一个 `"../../../../../../etc"` 会被解析成 `/var/apps/etc` 并被递归
 * 删除（`force: true` 还会吞掉失败）。
 *
 * 此前唯一挡住它的是**隐式保护**：`npm remove <非法名>` 通常返回非 0，函数提前
 * return。那是依赖 npm 的行为，不是校验 —— 换 npm 版本、换 registry、或某个
 * 名字恰好合法时就会失效。一旦触发就是 `rm -rf` 级破坏。
 */
const PKG_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

/** 合法包名？空/非字符串/含 `..`、路径分隔符、大写均拒绝。 */
export function isValidPackageName(name) {
  return typeof name === 'string' && PKG_NAME_RE.test(name) && !name.includes('..')
}

/**
 * 第二道兜底：解析后的目标必须仍在 profile 的 node_modules 内。
 * 正则之外再校验一次真实路径，防止将来有人放宽正则或引入新的拼接点。
 */
function safeInstalledDir(pkg) {
  const root = resolve(join(profileDir(), 'node_modules'))
  const target = resolve(join(root, pkg))
  if (target !== root && !target.startsWith(root + sep)) return null
  return target
}

/** The profile this panel manages plugins for. */
export function profileDir() {
  return join(activeDshHome(), 'profiles', 'web')
}

export function profilePackagePath() {
  return join(profileDir(), 'package.json')
}

export function profilePatchPath() {
  return join(profileDir(), 'cordis.patch.yml')
}

/** The name npm knows a scoped package by (e.g. `dshmarket`). */
function shortName(pkg) {
  const name = String(pkg || '')
  const slash = name.lastIndexOf('/')
  return slash >= 0 ? name.slice(slash + 1) : name
}

/**
 * Directory npm hoists the package to.
 *
 * 返回 `null` 表示包名非法或路径逃逸出了 `node_modules`（见 safeInstalledDir）——
 * 调用方必须处理 null，绝不能拿它去 `rmSync(recursive)`。
 */
function installedDir(pkg) {
  return safeInstalledDir(pkg)
}

// ---------------------------------------------------------------------------
// Registry inspection (same `node -e fetch` pattern as dashboard-versions.js)
// ---------------------------------------------------------------------------

function registry() {
  return (loadConfig().install?.npmRegistry || 'https://registry.npmjs.org').replace(/\/+$/, '')
}

function npmEnv() {
  return npmEnvShared(loadConfig().install?.proxy)
}

/** `name@1.2.3` → `name`；`@scope/name@1.2.3` → `@scope/name`。 */
export function specPackageName(spec) {
  const text = String(spec ?? '').trim()
  if (!text) return ''
  const at = text.startsWith('@') ? text.indexOf('@', 1) : text.indexOf('@')
  return at > 0 ? text.slice(0, at) : text
}

/** Resolve a package spec to its name + latest version via the registry. */
export async function inspectPackage(spec) {
  const specName = String(spec || '').trim()
  if (!specName) return { ok: false, error: 'missing-package' }
  // registry 可在设置里改，改成恶意源后"registry 说它存在"就不再是有效校验，
  // 所以包名正则必须在这里先过一遍。
  if (!isValidPackageName(specPackageName(specName))) {
    return { ok: false, error: 'invalid-package-name' }
  }

  // 走 npm view 而非 node -e fetch：Node 的 fetch 不读 HTTP_PROXY，配了代理的
  // 机器上 npm install 能通、这里却永远 registry-unreachable。
  const doc = await registryDoc(specPackageName(specName), {
    registry: registry(),
    proxy: loadConfig().install?.proxy,
  })
  if (!doc.ok) return { ok: false, error: doc.error, detail: doc.detail }

  try {
    const d = doc.doc ?? {}
    const versions = Array.isArray(d.versions) ? d.versions : Object.keys(d.versions ?? {})
    return {
      ok: true,
      name: d.name || specPackageName(specName),
      latest: d['dist-tags']?.latest ?? null,
      versions,
      description: d.description || '',
    }
  } catch {
    return { ok: false, error: 'bad-registry-payload' }
  }
}

// ---------------------------------------------------------------------------
// Profile manifest read/write
// ---------------------------------------------------------------------------

function readProfilePackage() {
  try {
    return JSON.parse(readFileSync(profilePackagePath(), 'utf8'))
  } catch {
    return { name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }
  }
}

function writeProfilePackage(pkg) {
  mkdirSync(dirname(profilePackagePath()), { recursive: true })
  writeFileSync(profilePackagePath(), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
}

function readBundles(pkg) {
  return pkg?.dsh?.profile?.bundles ?? []
}

function writeBundles(pkg, bundles) {
  pkg.dsh = pkg.dsh ?? {}
  pkg.dsh.profile = pkg.dsh.profile ?? {}
  pkg.dsh.profile.bundles = bundles
  writeProfilePackage(pkg)
}

/** Is this bundle currently selected (active) in the profile? */
function bundleEnabled(pkg, name) {
  return readBundles(pkg).includes(name)
}

/** Is the package physically installed under the profile's node_modules? */
function bundleInstalled(name) {
  const dir = installedDir(name)
  return Boolean(dir) && existsSync(join(dir, 'package.json'))
}

/** Read the installed package's own manifest (for version + description). */
function installedManifest(name) {
  const dir = installedDir(name)
  if (!dir) return null
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// cordis.patch.yml editing (line-level, mirrors writePluginEnabled semantics)
// ---------------------------------------------------------------------------

/**
 * Read the patch file as an array of YAML maps. Entries are line groups:
 * each `- id: <x>` (or `-` then `id:` on the next line) starts one entry.
 */
function readPatchEntries() {
  const entries = []
  let text = ''
  try {
    text = readFileSync(profilePatchPath(), 'utf8')
  } catch {
    return { entries, text: '' }
  }
  const lines = text.split(/\r?\n/)
  let current = null
  for (const line of lines) {
    const start = /^-\s*id:\s*(\S+)/.exec(line)
    if (start) {
      if (current) entries.push(current)
      current = { id: start[1], lines: [line] }
      continue
    }
    if (/^-\s*$/.test(line.trim())) {
      // A bare `-` may open a map whose `id:` follows on the next line.
      if (current) entries.push(current)
      current = { id: null, lines: [line] }
      continue
    }
    if (current) {
      current.lines.push(line)
      const idLine = /^\s*id:\s*(\S+)/.exec(line)
      if (idLine && current.id === null) current.id = idLine[1]
    }
  }
  if (current) entries.push(current)
  return { entries, text }
}

function renderPatchEntries(entries, text) {
  // Preserve any header comment (lines before the first entry / `[]`).
  const headerLines = []
  const body = text.split(/\r?\n/)
  for (const line of body) {
    const trimmed = line.trim()
    if (/^-\s*id:/.test(trimmed) || trimmed === '-' || trimmed === '[]') break
    headerLines.push(line)
  }
  const rendered = entries.flatMap((entry) => entry.lines)
  const header = headerLines.join('\n')
  const bodyText = rendered.join('\n')
  if (!header.trim()) return `${bodyText}\n`
  return `${header}\n${bodyText}\n`
}

/** Plugin write mutex: all four write paths (setPluginEnabled / installBundle /
 * removeBundle / setBundleEnabled) read-modify-write package.json and
 * cordis.patch.yml. Two concurrent requests (double-click, two tabs) used to
 * interleave read→read→write→write, so the second write clobbered the first —
 * the UI reported success while the file lost one change. Serialize them. */
let pluginWriteChain = Promise.resolve()
function withPluginWriteLock(fn) {
  const run = pluginWriteChain.then(fn, fn)
  pluginWriteChain = run.then(() => {}, () => {})
  return run
}

/**
 * Set a plugin entry's `disabled` state. `id` is the composition entry id (the
 * loader row id), `name` the module name. Mirrors
 * `writePluginEnabled(patch.ts)` but keeps the edit line-level and dependency-free.
 */
export function setPluginEnabled(id, name, enabled) {
  // cordis.patch.yml 是逐行拼出来的：id/name 里的换行会变成新的 YAML 条目
  // （配置文件注入）。只接受单行、无控制字符的值。
  const safeId = String(id ?? '')
  const safeName = String(name ?? '')
  if (/[\r\n\x00-\x1f]/.test(safeId) || /[\r\n\x00-\x1f]/.test(safeName)) {
    return { ok: false, error: 'invalid-plugin-id' }
  }
  // 后续全部按规范化后的字符串处理（入参可能是 number/null）。
  id = safeId
  name = safeName
  return withPluginWriteLock(() => {
    const { entries, text } = readPatchEntries()
  // Find the last matching override: an entry with this id, no `insert`, and a
  // matching (or absent) `name`.
  let target = null
  for (const entry of entries) {
    if (!entry.id || entry.id !== id) continue
    if (entry.lines.some((line) => /^\s*insert:/.test(line))) continue
    const nameLine = entry.lines.find((line) => /^\s*name:/.test(line))
    const entryName = nameLine ? /^\s*name:\s*(\S+)/.exec(nameLine)?.[1] : null
    if (entryName && entryName !== name) continue
    target = entry
  }

  if (target) {
    // Toggle the `disabled:` line in place, or add one.
    const idx = target.lines.findIndex((line) => /^\s*disabled:/.test(line))
    if (idx >= 0) {
      target.lines[idx] = `  disabled: ${enabled ? 'false' : 'true'}`
    } else {
      // Insert after the last field of the entry.
      let insertAt = target.lines.length
      for (let i = target.lines.length - 1; i >= 0; i -= 1) {
        if (!/^\s*$/.test(target.lines[i])) { insertAt = i + 1; break }
      }
      target.lines.splice(insertAt, 0, `  disabled: ${enabled ? 'false' : 'true'}`)
    }
  } else if (!enabled) {
    // No override yet and disabling: append a new entry.
    entries.push({ id, lines: [`- id: ${id}`, `  disabled: true`] })
  }
  // Enabling a plugin with no existing override = nothing to write.

  const out = renderPatchEntries(entries, text)
  mkdirSync(dirname(profilePatchPath()), { recursive: true })
  writeFileSync(profilePatchPath(), out, 'utf8')
  return { ok: true, changed: Boolean(target) || !enabled }
  })
}

// ---------------------------------------------------------------------------
// Bundle install / remove
// ---------------------------------------------------------------------------

function npmArgs(subcommand, args = []) {
  // Same as versions: `http` level streams "fetching package X" lines for the
  // live progress log instead of staying silent until the install completes.
  return [subcommand, '--registry', registry(), '--no-audit', '--no-fund', '--loglevel', 'http', '--foreground-scripts', '--progress', 'false', ...args]
}

/** Install a bundle into the profile and select it. */
export async function installBundle(spec, { onProgress } = {}) {
  return withPluginWriteLock(async () => {
    const name = String(spec || '').trim()
  if (!name) return { ok: false, error: 'missing-package' }
  if (!isValidPackageName(specPackageName(name))) return { ok: false, error: 'invalid-package-name' }

  // Registry inspection: normalize `name@version` and validate the package exists.
  const inspect = await inspectPackage(name)
  if (!inspect.ok) return inspect
  if (!isValidPackageName(inspect.name)) return { ok: false, error: 'invalid-package-name' }
  const installSpec = name.includes('@') && !name.startsWith('@') ? name : `${inspect.name}@${inspect.latest}`

  const dir = profileDir()
  mkdirSync(dir, { recursive: true })

  const pkg = readProfilePackage()
  if (bundleInstalled(inspect.name)) {
    // Reinstall = upgrade to the requested version.
    onProgress?.({ phase: 'upgrading', name: inspect.name })
  } else {
    onProgress?.({ phase: 'installing', name: inspect.name })
  }

  let log = ''
  const result = await runWithTimeout(npmBin(), npmArgs('install', ['--prefix', dir, installSpec]), 20 * 60 * 1000, {
    env: await npmEnv(),
    cwd: dir,
    onData: (chunk) => {
      log = (log + chunk).slice(-2000)
      onProgress?.({ phase: 'installing', name: inspect.name, log })
    },
  })

  if (result.code !== 0 || !bundleInstalled(inspect.name)) {
    return {
      ok: false,
      error: 'install-failed',
      detail: (result.stderr || result.stdout || '').trim().slice(-2000),
    }
  }

  // 旧快照回写修复：npm install 自己已经把依赖写进了 package.json。若在
  // install 前读取的旧 pkg 上整体回写，会把 npm 刚写入的 dependencies（以及
  // 其它并发/历史变更）覆盖掉。install 成功后重新读，在新鲜副本上合并。
  const fresh = readProfilePackage()
  fresh.dependencies = fresh.dependencies ?? {}
  fresh.dependencies[inspect.name] = `^${inspect.latest}`
  const bundles = readBundles(fresh)
  if (!bundles.includes(inspect.name)) bundles.push(inspect.name)
  writeBundles(fresh, bundles)

  return { ok: true, name: inspect.name, version: inspect.latest, restartRequired: true }
  })
}
/** Remove a bundle: deselect, then uninstall the package. */
export async function removeBundle(name) {
  // 路径穿越防线（P0）：`name` 直接来自请求体，且后面会用
  // `rmSync(dir, { recursive: true, force: true })`。必须先校验，不能指望
  // `npm remove` 帮忙拦 —— 那是隐式依赖 npm 的行为。
  const pkgName = typeof name === 'string' ? name.trim() : ''
  if (!isValidPackageName(pkgName)) return { ok: false, error: 'invalid-package-name' }
  // 包含校验放在锁外做一次（纯计算，不碰文件系统），锁内再确认一次。
  if (!safeInstalledDir(pkgName)) return { ok: false, error: 'invalid-package-name' }

  return withPluginWriteLock(async () => {
    const pkg = readProfilePackage()
    const bundles = readBundles(pkg).filter((entry) => entry !== pkgName)
    writeBundles(pkg, bundles)

    const dir = profileDir()
    const result = await runWithTimeout(npmBin(), npmArgs('remove', ['--prefix', dir, pkgName]), 10 * 60 * 1000, {
      env: await npmEnv(),
      cwd: dir,
    })
    if (result.code !== 0) {
      return { ok: false, error: 'remove-failed', detail: (result.stderr || '').trim().slice(-2000) }
    }
    // npm may leave a stray dir; clean it defensively.
    // `pkgName` 已在入口做过正则 + 包含双重校验；递归删除前再确认一次仍未逃出
    // node_modules。多一道判断的成本可以忽略，代价不对称（一次误删不可恢复）。
    const finalTarget = safeInstalledDir(pkgName)
    if (finalTarget) { try { rmSync(finalTarget, { recursive: true, force: true }) } catch {} }
    return { ok: true, name: pkgName, restartRequired: true }
  })
}

/** Toggle a bundle's selection (enable/disable) without touching the install. */
export function setBundleEnabled(name, enabled) {
  // 校验与写入必须用同一个（trim 后的）名字：入参带空格时若校验用 pkgName、
  // 写入用原始 name，package.json 里会留下一个和 npm 实际装的包对不上的条目。
  const pkgName = typeof name === 'string' ? name.trim() : ''
  if (!isValidPackageName(pkgName)) return { ok: false, error: 'invalid-package-name' }
  return withPluginWriteLock(() => {
    const pkg = readProfilePackage()
    const bundles = readBundles(pkg)
    const has = bundles.includes(pkgName)
    if (enabled && !has) bundles.push(pkgName)
    if (!enabled && has) {
      const idx = bundles.indexOf(pkgName)
      bundles.splice(idx, 1)
    }
    writeBundles(pkg, bundles)
    return { ok: true, name: pkgName, enabled, restartRequired: true }
  })
}

// ---------------------------------------------------------------------------
// Read plugin rows from the patch file (what dsh would report as listPlugins)
// ---------------------------------------------------------------------------

/** The enabled/disabled state of a plugin entry, as the patch file records it. */
function patchDisabledState(id) {
  const { entries } = readPatchEntries()
  for (const entry of entries) {
    if (entry.id !== id) continue
    const line = entry.lines.find((l) => /^\s*disabled:/.test(l))
    if (line) return /true/.test(line)
  }
  return false
}

/** Everything the Plugins tab renders in one call. */
export function pluginState() {
  const pkg = readProfilePackage()
  const bundles = readBundles(pkg)
  const dependencies = Object.keys(pkg?.dependencies ?? {})

  // Installed bundles = the union of selected names and declared dependencies.
  const names = [...new Set([...bundles, ...dependencies])]
  const rows = names.map((name) => {
    const manifest = installedManifest(name)
    const installed = dependencies.includes(name) || bundleInstalled(name)
    const enabled = bundles.includes(name)
    return {
      name,
      shortName: shortName(name),
      version: manifest?.version ?? null,
      description: manifest?.description ?? '',
      installed,
      enabled,
      isMarket: name === MARKET_PACKAGE || shortName(name) === MARKET_PACKAGE,
      removable: installed && name !== DSH_PACKAGE,
    }
  }).sort((a, b) => a.name.localeCompare(b.name))

  // Plugin rows recorded in the patch file (explicit enable/disable entries).
  const { entries } = readPatchEntries()
  const pluginRows = entries
    .filter((entry) => entry.id && !entry.lines.some((line) => /^\s*insert:/.test(line)))
    .map((entry) => {
      const nameLine = entry.lines.find((line) => /^\s*name:/.test(line))
      return {
        id: entry.id,
        name: nameLine ? /^\s*name:\s*(\S+)/.exec(nameLine)?.[1] ?? '' : '',
        disabled: entry.lines.some((line) => /^\s*disabled:\s*true/.test(line)),
      }
    })

  return {
    profileDir: profileDir(),
    bundles: rows,
    pluginRows,
    market: {
      package: MARKET_PACKAGE,
      installed: names.some((name) => shortName(name) === MARKET_PACKAGE),
      enabled: bundles.some((name) => shortName(name) === MARKET_PACKAGE),
    },
    restartRequiredHint: 'Changes apply after dsh is restarted.',
  }
}

export { patchDisabledState }
