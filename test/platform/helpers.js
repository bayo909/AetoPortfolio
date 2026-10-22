const { createPlatform } = require('../../platform/index');
const { seed, DEMO_PASSWORD } = require('../../platform/seed');

let template = null;
/** Fresh, fully seeded in-memory platform (about a second). `clock` lets tests move time. */
async function seeded(opts = {}) {
  const clock = { t: new Date() };
  const core = createPlatform({ dbFile: ':memory:', now: () => new Date(clock.t), ...opts });
  const s = await seed(core);
  return { core, svc: core.svc, db: core.db, clock, PASSWORD: DEMO_PASSWORD, ...s };
}
/** Asserts a function throws an HttpError with the given status (and optional code). */
function denies(assert, fn, status, code) {
  assert.throws(fn, e => e.status === status && (!code || e.code === code), `expected HTTP ${status}${code ? ' ' + code : ''}`);
}
const iso = d => d.toISOString();
module.exports = { seeded, denies, iso, DEMO_PASSWORD };
