// Append-only, hash-chained audit log. Each record commits to the previous record's hash, so any
// edit, deletion or reordering of history is detectable with verify().
const crypto = require('crypto');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const GENESIS = '0'.repeat(64);

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}

function append(chain, { actor, action, subject, data, at }) {
  const prev = chain.length ? chain[chain.length - 1].hash : GENESIS;
  const rec = { seq: chain.length + 1, at, actor, action, subject, data: data || {}, prev };
  rec.hash = sha(prev + canonical(rec));
  chain.push(rec);
  return rec;
}

function verify(chain) {
  let prev = GENESIS;
  for (let i = 0; i < chain.length; i++) {
    const { hash, ...rest } = chain[i];
    if (rest.seq !== i + 1 || rest.prev !== prev || sha(prev + canonical(rest)) !== hash) return { ok: false, brokenAt: i + 1, length: chain.length };
    prev = hash;
  }
  return { ok: true, length: chain.length, head: prev };
}

module.exports = { append, verify, sha, canonical, GENESIS };
