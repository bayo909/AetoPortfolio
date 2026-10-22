// Hash-linked, append-only audit trail (per organisation). Each event commits to the previous event's hash.
// SQLite triggers reject UPDATE/DELETE; verifyChain() detects tampering made by bypassing them.
// This is tamper-EVIDENT, not tamper-proof: anchor the head hash externally (see README) for stronger guarantees.
const { uid, iso } = require('./db');
const { sha256 } = require('./security');

const GENESIS = '0'.repeat(64);
const canon = o => JSON.stringify(o, Object.keys(o).sort());

function createAudit(db, now = () => new Date()) {
  const head = orgId => (db.get('SELECT hash FROM audit_events WHERE org_id = ? ORDER BY seq DESC LIMIT 1', orgId) || { hash: GENESIS }).hash;

  function write(orgId, { actorId = null, actorOrgId = null, action, objectType, objectId, prior = null, next = null, reason = '', refs = {} }) {
    const base = {
      id: uid(), org_id: orgId, actor_id: actorId, actor_org_id: actorOrgId, action, object_type: objectType, object_id: String(objectId),
      prior_json: prior == null ? null : JSON.stringify(prior), new_json: next == null ? null : JSON.stringify(next), reason, refs_json: JSON.stringify(refs), at: iso(now()),
    };
    const prev = head(orgId);
    const hash = sha256(prev + canon(base));
    db.insert('audit_events', { ...base, prev_hash: prev, hash });
    return hash;
  }

  /** Records the event once per organisation involved (e.g. both vendor and customer on a shared document). */
  function record(orgIds, ev) {
    for (const o of [...new Set([].concat(orgIds))]) write(o, ev);
  }

  function verify(orgId) {
    const rows = db.all('SELECT * FROM audit_events WHERE org_id = ? ORDER BY seq', orgId);
    let prev = GENESIS;
    for (const r of rows) {
      const { seq, prev_hash, hash, ...base } = r;
      if (prev_hash !== prev || sha256(prev + canon(base)) !== hash) return { ok: false, brokenAtSeq: seq, checked: rows.length };
      prev = hash;
    }
    return { ok: true, checked: rows.length, head: prev };
  }

  return { record, verify, head };
}

module.exports = { createAudit, GENESIS };
