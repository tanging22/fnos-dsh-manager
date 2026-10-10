/**
 * Environment detection and one-click setup.
 *
 * The panel depends on a handful of external tools — node (its own runtime),
 * npm (its sibling, used for version/plugin installs), and git (some plugins).
 * On fnOS these arrive via `install_dep_apps`, but the panel runs as its own
 * process whose PATH may not include the dependency's `bin/` directory. That
 * mismatch is exactly what caused the `spawn npm ENOENT` failure: npm exists on
 * disk next to node, but the panel could not find it by bare name.
 *
 * This module (a) reports what is present and where, and (b) provides a
 * best-effort "install environment" that fixes what it can WITHOUT downloading
 * system binaries — the panel must never fetch and place node/npm itself:
 *   - npm is a plain JS launcher; when node exists but npm is missing from
 *     node's own directory, we can fix it by symlinking npm from the node
 *     version's real install (or, when npm genuinely is on PATH, pointing the
 *     panel's npm resolution at it).
 *   - git can only be reported; installing it needs the host platform.
 */

import { existsSync, symlinkSync, readlinkSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { NODE_BIN, npmBin, nodeDirEnv, discoverNodeBins, bestNodeBin } from './dashboard-utils.js'

/** Locate an executable next to node (npm) or on PATH. */
function which(name) {
  const sibling = join(dirname(NODE_BIN), name)
  if (existsSync(sibling)) return sibling
  const result = spawnSync('sh', ['-c', `command -v ${name} 2>/dev/null || true`], { encoding: 'utf8', timeout: 5000 })
  const found = (result.stdout || '').trim()
  return found || null
}

function probe(name, candidate, env = undefined) {
  if (!candidate) return { present: false, path: null }
  if (!existsSync(candidate)) return { present: false, path: candidate }
  let version = ''
  let error = ''
  try {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 10000, env: env ?? process.env })
    version = (result.stdout || '').trim().split('\n')[0]
    if (result.status !== 0) error = (result.stderr || result.stdout || '').trim().split('\n')[0]
  } catch (e) {
    error = e?.message ?? String(e)
  }
  return { present: !error, path: candidate, version, error }
}

/** Report the tools the panel needs and whether each is reachable. */
export function environmentState() {
  const npm = npmBin()
  const npmResolved = npm !== 'npm' && existsSync(npm) ? npm : which('npm')
  const git = which('git')
  const nodeOk = existsSync(NODE_BIN)

  const state = {
    node: { present: nodeOk, path: NODE_BIN, version: process.versions.node },
    npm: probe('npm', npmResolved, nodeDirEnv()),
    git: probe('git', git),
    nodes: discoverNodeBins().map((n) => ({ bin: n.bin, version: n.version, major: n.major })),
    bestNode: bestNodeBin(),
    needsFix: false,
    fixes: [],
  }

  if (!nodeOk) {
    state.needsFix = true
    state.fixes.push('node-runtime-missing')
  }
  if (!state.npm.present) {
    state.needsFix = true
    state.fixes.push(state.npm.error ? `npm-broken: ${state.npm.error}` : 'npm-missing')
  }
  if (npm !== 'npm' && !existsSync(npm)) {
    // npm exists on PATH but not next to node; npmBin already falls back to PATH.
    // This is fine, but worth reporting.
    state.fixes.push('npm-via-path')
  }
  return state
}

/**
 * 找到 node 版本目录里真实存在的 npm（可能是软链目标），用于修复。
 * 返回 { dir, npmPath } 或 null。
 */
function findNpmInNodeTrees() {
  // 1. 直接在 node 的同级目录找 npm
  const sibling = join(dirname(NODE_BIN), process.platform === 'win32' ? 'npm.cmd' : 'npm')
  if (existsSync(sibling)) return { npmPath: sibling, via: 'sibling' }

  // 2. 遍历所有发现的 node 安装，找它们的 npm
  for (const node of discoverNodeBins()) {
    const d = dirname(node.bin)
    const npmPath = join(d, process.platform === 'win32' ? 'npm.cmd' : 'npm')
    if (existsSync(npmPath)) return { npmPath, via: `node-tree:${d}` }
  }

  // 3. PATH 上的 npm（which 已查过）
  const onPath = which('npm')
  if (onPath) return { npmPath: onPath, via: 'path' }

  return null
}

/**
 * Best-effort environment repair — 让「一键修复」有真实动作。
 *
 * 真正能修的（在沙箱权限内、不下载系统二进制）：
 *   1. npm 缺失但在 node 目录/其它 node 版本/PATH 里能找到 → 在 node 的同级
 *      目录建一个 npm 软链（或确认 PATH npm 可用），让 npmBin() 之后总能命中。
 *   2. node 目录缺 npm 但 PATH 有 → 同样建软链，消除对 PATH 的依赖。
 *   3. 确认 git 可用性（只能报告，不能装）。
 *
 * 不能修的（诚实报告）：node 本身缺失/损坏、git 缺失——这些需要宿主平台
 * （重装套件时 install_dep_apps=nodejs_v22 会自动装）。
 */
export function repairEnvironment() {
  const before = environmentState()
  const repaired = []
  const notes = []

  // --- 真实修复：让 npm 可被 node 目录解析 ---
  const npmExpected = join(dirname(NODE_BIN), process.platform === 'win32' ? 'npm.cmd' : 'npm')
  const found = findNpmInNodeTrees()

  if (found && found.npmPath !== npmExpected && !existsSync(npmExpected)) {
    // node 目录缺 npm，但别处有 → 建软链
    try {
      symlinkSync(found.npmPath, npmExpected)
      repaired.push({ tool: 'npm', path: npmExpected, via: found.via })
      notes.push(`已创建 npm 软链 ${npmExpected} -> ${found.npmPath}（来源：${found.via}）`)
    } catch (error) {
      notes.push(`npm 软链创建失败：${error?.message ?? error}（仍将依赖 PATH 中的 npm）`)
    }
  } else if (found && found.npmPath === npmExpected) {
    repaired.push({ tool: 'npm', path: npmExpected })
    notes.push('npm 已在 node 目录中，无需修复')
  } else if (!found && !before.npm.present) {
    notes.push('npm 完全缺失：面板无法自行安装 npm（需宿主平台重装 nodejs 依赖）')
  }

  // --- 诚实报告 node/git ---
  if (!before.node.present) {
    notes.push('node 运行时缺失或损坏：面板无法自行安装，需重装套件（install_dep_apps=nodejs_v22）')
  }
  const git = which('git')
  if (!git) {
    notes.push('git 未安装（仅部分插件需要，可忽略；面板无法自行安装）')
  } else {
    notes.push('git 可用')
  }

  const after = environmentState()

  // npm 软链可能刚建好，after 里的 npm 探测应该已能命中
  const npmNowOk = after.npm.present
  const ok = (before.node.present && npmNowOk) || repaired.length > 0

  return {
    ok,
    repaired,
    notes,
    before,
    after,
  }
}
