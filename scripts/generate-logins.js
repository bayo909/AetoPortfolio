#!/usr/bin/env node
// Generates login profiles (buyers = company staff, one login per vendor) with fresh random passwords.
//   npm run logins              replace every login (all existing passwords stop working)
//   npm run logins -- --missing only add logins that do not exist yet (e.g. after adding a vendor)
const fs = require('fs');
const path = require('path');
const { loadMasterData } = require('../src/masterData');
const { createService } = require('../src/service');
const { formatCredentials, writeCredentialsFile } = require('../src/logins');

const storageDir = process.env.STORAGE_DIR || path.join(__dirname, '..', 'storage');
const pidFile = path.join(storageDir, 'server.pid');
if (fs.existsSync(pidFile)) {
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  let alive = false; try { process.kill(pid, 0); alive = true; } catch { /* stale pid file */ }
  if (alive) { console.error(`DocFlow is running (pid ${pid}). Stop it first — it holds its own copy of the data and would overwrite new logins.`); process.exit(1); }
}
const svc = createService({ master: loadMasterData(), storageDir });
const creds = svc.generateLogins({ reset: !process.argv.includes('--missing') });
if (!creds.length) { console.log('All login profiles already exist. Run without --missing to replace them.'); process.exit(0); }
console.log(formatCredentials(creds));
const file = writeCredentialsFile(storageDir, creds);
console.log(`\n${creds.length} login(s) created. Credentials sheet: ${file}`);
