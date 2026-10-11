// State container with optional JSON-file persistence. Uploaded bytes live in dataDir/files/<sha256>
// (or in memory when no dataDir is given, e.g. tests).
const fs = require('fs');
const path = require('path');

const fresh = () => ({
  seq: 0, users: {}, orgs: {}, workspaces: {}, channels: {}, messages: {}, templates: {}, requests: {},
  submissions: {}, entries: {}, payments: {}, files: {}, audit: {}, sessions: {},
});

function createStore(dataDir) {
  let state = fresh();
  const blobs = new Map();
  const stateFile = dataDir && path.join(dataDir, 'state.json');
  if (dataDir) {
    fs.mkdirSync(path.join(dataDir, 'files'), { recursive: true });
    if (fs.existsSync(stateFile)) state = { ...fresh(), ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) };
  }
  let timer = null;
  const flush = () => {
    if (!dataDir) return;
    clearTimeout(timer); timer = null;
    const tmp = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, stateFile);
  };
  const saveSoon = () => { if (dataDir && !timer) { timer = setTimeout(flush, 200); timer.unref(); } };
  const putBlob = (sha, buf) => {
    if (!dataDir) return blobs.set(sha, buf);
    const f = path.join(dataDir, 'files', sha);
    if (!fs.existsSync(f)) fs.writeFileSync(f, buf);
  };
  const getBlob = sha => (dataDir ? fs.readFileSync(path.join(dataDir, 'files', sha)) : blobs.get(sha));
  return { get state() { return state; }, saveSoon, flush, putBlob, getBlob };
}

module.exports = { createStore };
