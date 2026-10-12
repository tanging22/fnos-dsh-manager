/**
 * Last-visitor memory.
 *
 * dsh itself records no access records, so anything purporting to show "who
 * visited" has to observe traffic somewhere. The panel owns a reverse proxy
 * (see server.js), and this module is its observation side.
 *
 * v1.0.40 slimmed this down: the JSONL access log (queue + flush + trim +
 * stats) and the read-only login.log reader are gone — the overview page only
 * shows the most recent visitor's IP, so a single in-memory slot is the whole
 * feature. Nothing touches disk, and a panel restart simply starts empty.
 */

let last = null

/** Called by the proxy for every forwarded request; keeps only the newest. */
export function recordVisit({ ip } = {}) {
  last = { ip: String(ip ?? '').trim() || '-', ts: new Date().toISOString() }
}

/** The most recent visitor, or null when nothing has been proxied yet. */
export function lastVisitor() {
  return last
}
