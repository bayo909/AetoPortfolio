// Rebuilds the demo database: node scripts/reset-demo.js   (DATA_DIR / DATABASE_FILE respected)
const fs = require('fs');
const path = require('path');
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'storage');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
const { createPlatform } = require('../platform/index');
const { seed } = require('../platform/seed');
(async () => {
  const core = createPlatform({ dbFile: process.env.DATABASE_FILE || path.join(dataDir, 'payuno.db'), storageDir: dataDir });
  const r = await seed(core);
  console.log(`Demo data created in ${dataDir}. Password for every demo user: ${r.demoPassword}\nPending vendor invitation token: ${r.inviteToken}  (open /#/invite/${r.inviteToken})`);
  await core.shutdown();
  process.exit(0);
})();
