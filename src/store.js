// Tiny persistence layer: uploaded files on disk + one JSON state file (write-through, atomic rename).
// With no directory it is memory-only (used by tests).
const fs = require('fs');
const path = require('path');

function createStore(dir) {
  if (!dir) return { persistent: false, load: () => null, save() {}, writeFile: () => null, readFile: () => null, filePath: () => null };
  const filesDir = path.join(dir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  const dbFile = path.join(dir, 'db.json');
  return {
    persistent: true,
    load() { try { return JSON.parse(fs.readFileSync(dbFile, 'utf8')); } catch { return null; } },
    save(state) {
      const tmp = dbFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, dbFile);
    },
    writeFile(name, buffer) { fs.writeFileSync(path.join(filesDir, name), buffer); return name; },
    readFile(name) { return fs.readFileSync(path.join(filesDir, name)); },
    filePath(name) { return path.join(filesDir, name); },
  };
}

module.exports = { createStore };
