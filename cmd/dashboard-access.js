/**
 * Last-visitor memory.
 *
 * dsh itself records no access records, so anything purporting to show "who
 * visited" has to observe traffic somewhere. The panel owns a reverse proxy
 * (see server.js), and this module is its observation side.
 *
 * v1.0.40 slimmed this down: the JSONL access log (queue + flush + trim +
 * stats) and the read-only login.log reader are gone — the overview page shows
 * only the most recent visitor, so a single in-memory slot is the whole
 * feature. Nothing touches disk, and a panel restart simply starts empty.
 *
 * The slot keeps the WHOLE picture of that one request (time / ip / path /
 * client), because the overview card shows all four as separate rows. Storing
 * only the IP would make the card's other three rows permanently blank.
 */

/** Headers worth keeping for display; everything else is dropped. */
const MAX_AGENT = 160

let last = null

/**
 * Called by the proxy for every forwarded request; keeps only the newest.
 *
 * Fields beyond `ip` are optional so a caller that only knows the address does
 * not have to invent the rest. `path` drops any query string (it carries dsh
 * tokens) and `agent` is length-capped: both are rendered in a fixed-width
 * card, and an uncapped value would blow the layout out.
 */
export function recordVisit({ ip, method, path, status, userAgent } = {}) {
  const rawPath = String(path ?? '').trim()
  const queryAt = rawPath.indexOf('?')
  last = {
    ip: String(ip ?? '').trim() || '-',
    ts: new Date().toISOString(),
    method: String(method ?? '').trim() || '-',
    // A query string can carry dsh's launch token, so it is not displayed.
    path: (queryAt === -1 ? rawPath : rawPath.slice(0, queryAt)) || '-',
    status: Number.isFinite(Number(status)) ? Number(status) : 0,
    agent: shorten(String(userAgent ?? '').trim()),
  }
  // Returned so the proxy can broadcast exactly what was stored, instead of
  // restating the fields (which is how the two copies drifted apart before).
  return last
}

/** Keep the browser family; the full string is long and rarely useful. */
function shorten(agent) {
  if (!agent) return ''
  // Order matters: Edge and Chrome UAs both claim "Chrome", Safari claims
  // "Safari" too (via "Version/"), so the more specific token has to win.
  const families = [
    [/Edg\//, 'Edge'],
    [/OPR\//, 'Opera'],
    [/Firefox\//, 'Firefox'],
    [/Chrome\//, 'Chrome'],
    [/Safari\//, 'Safari'],
    [/curl\//, 'curl'],
    [/node/i, 'Node.js'],
    [/python-requests/i, 'python-requests'],
  ]
  for (const [pattern, name] of families) {
    if (pattern.test(agent)) return name
  }
  return agent.length > MAX_AGENT ? `${agent.slice(0, MAX_AGENT)}…` : agent
}

/** The most recent visitor, or null when nothing has been proxied yet. */
export function lastVisitor() {
  return last
}
