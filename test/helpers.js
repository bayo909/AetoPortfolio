const { loadMasterData } = require('../src/masterData');
const { loadPolicyChunks } = require('../src/policy');
const { createService } = require('../src/service');

const master = loadMasterData();
let chunksP;
async function mkService(opts = {}) {
  chunksP = chunksP || loadPolicyChunks();
  return createService({ master, chunks: await chunksP, now: () => new Date('2026-03-10T10:00:00Z'), ...opts });
}
async function ingest(svc, text, { intake = 'unstructured', docType, filename = 'doc.txt', uploadedBy = 'Ada Preparer' } = {}) {
  const rec = svc.createRecord({ buffer: Buffer.from(text), filename, intake, docType, uploadedBy });
  await svc.processRecord(rec.id);
  return svc.getRecord(rec.id);
}
const fail = (assert, fn, status) => assert.throws(fn, e => e.status === status, `expected HTTP ${status}`);
module.exports = { master, mkService, ingest, fail };
