// Assembles the PayUno Flow platform (all services) around one shared core.
const { createCore } = require('./core');

function createPlatform(opts = {}) {
  const core = createCore(opts);
  const mods = {
    auth: './auth', vendor: './vendor', chat: './chat', ledger: './ledger', agent: './agent', commerce: './commerce', policy: './policy', bills: './bills',
    payments: './payments', subscriptions: './subscriptions', compliance: './compliance', rtfepe: './rtfepe', admin: './admin',
  };
  for (const [k, m] of Object.entries(mods)) core.svc[k] = require(m)(core);
  core.idle = () => core.svc.rtfepe.idle();
  return core;
}
module.exports = { createPlatform };
