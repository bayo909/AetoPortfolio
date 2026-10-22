// Issues login profiles and writes the one-time credentials sheet next to the data (mode 0600).
const fs = require('fs');
const path = require('path');

function formatCredentials(creds) {
  const w = k => Math.max(k.length, ...creds.map(c => String(c[k]).length));
  const wu = w('username'), wp = w('password');
  const row = (a, b, c, d) => `${a.padEnd(wu)}  ${b.padEnd(wp)}  ${c.padEnd(8)}  ${d}`;
  return [row('USERNAME', 'PASSWORD', 'TYPE', 'NAME / ROLE'),
    ...creds.map(c => row(c.username, c.password, c.role === 'vendor' ? 'vendor' : 'buyer', `${c.name}${c.role === 'buyer' ? ' — ' + c.title : ''}`))].join('\n');
}

function writeCredentialsFile(storageDir, creds) {
  if (!storageDir) return null;
  const file = path.join(storageDir, 'logins.txt');
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(file, `Generated ${new Date().toISOString()} — passwords are shown once and stored only as hashes. Delete this file after distributing.\n\n${formatCredentials(creds)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

module.exports = { formatCredentials, writeCredentialsFile };
