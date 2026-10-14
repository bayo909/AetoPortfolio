const express = require('express');
const multer = require('multer');
const path = require('path');
const { loadMasterData } = require('./src/masterData');
const { loadPolicyChunks } = require('./src/policy');
const { createService } = require('./src/service');
const ocr = require('./src/ocr');

async function createApp(opts = {}) {
  const master = opts.master || loadMasterData();
  const chunks = opts.chunks || await loadPolicyChunks();
  const svc = createService({ master, chunks, storageDir: opts.storageDir === undefined ? process.env.STORAGE_DIR || path.join(__dirname, 'storage') : opts.storageDir });
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/samples', express.static(path.join(__dirname, 'samples')));

  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const pending = new Set(); // in-flight processing jobs (awaited by tests via app.idle())
  const start = id => { const p = svc.processRecord(id).catch(e => console.error('processing failed', e)).finally(() => pending.delete(p)); pending.add(p); return p; };

  app.get('/api/config', (req, res) => res.json(svc.config()));

  // Upload: the record (and the stored file) exists as soon as this returns; processing continues in the background.
  app.post('/api/records', upload.single('file'), (req, res) => {
    if (!req.file) throw new svc.HttpError(400, 'Choose a file to upload');
    const filename = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const record = svc.createRecord({ buffer: req.file.buffer, filename, intake: req.body.intake, docType: req.body.docType, uploadedBy: req.body.uploadedBy });
    start(record.id);
    res.status(201).json(record);
  });
  app.get('/api/records', (req, res) => res.json(svc.listRecords()));
  app.get('/api/records/:id', (req, res) => res.json(svc.getRecord(req.params.id)));
  app.get('/api/records/:id/file', (req, res) => {
    const f = svc.recordFile(req.params.id);
    res.type(f.mime).set('Content-Disposition', `inline; filename="${encodeURIComponent(f.filename)}"`).set('X-Content-Type-Options', 'nosniff');
    if (f.path) res.sendFile(f.path); else res.send(f.buffer);
  });
  app.get('/api/records/:id/preview', wrap(async (req, res) => res.json(await svc.recordPreview(req.params.id))));
  app.post('/api/records/:id/reprocess', wrap(async (req, res) => res.json(await svc.reprocessRecord(req.params.id))));

  app.get('/api/parties', (req, res) => res.json(svc.listParties(req.query.kind)));
  app.post('/api/parties', (req, res) => res.status(201).json(svc.createParty(req.body)));
  app.patch('/api/parties/:id', (req, res) => res.json(svc.updateParty(req.params.id, req.body)));

  app.get('/api/documents', (req, res) => res.json(svc.listDocuments()));
  app.get('/api/documents/:id', (req, res) => res.json(svc.getDocument(req.params.id)));
  app.patch('/api/documents/:id', (req, res) => res.json(svc.update(req.params.id, req.body)));
  app.post('/api/documents/:id/submit', (req, res) => res.json(svc.submit(req.params.id, req.body.by)));
  app.post('/api/documents/:id/approve', (req, res) => res.json(svc.approve(req.params.id, req.body.role, req.body.by)));
  app.post('/api/documents/:id/reject', (req, res) => res.json(svc.reject(req.params.id, req.body.by, req.body.reason)));
  app.post('/api/documents/:id/finance-review', (req, res) => res.json(svc.financeReview(req.params.id, req.body)));

  app.get('/api/bills', (req, res) => res.json(svc.listBills()));
  app.get('/api/bills/:id', (req, res) => res.json(svc.getBill(req.params.id)));
  app.post('/api/bills/:id/pay', (req, res) => res.json(svc.payBill(req.params.id, req.body.by)));
  app.get('/api/bills/:id/csv', (req, res) => {
    res.type('text/csv').attachment(`${svc.getBill(req.params.id).number}.csv`).send(svc.billCsv(req.params.id));
  });
  app.get('/api/policy', (req, res) => res.json(svc.policyChunks()));
  app.get('/api/policy/:id', (req, res) => {
    const c = svc.policyChunk(req.params.id);
    if (!c) return res.status(404).json({ error: 'Policy chunk not found' });
    res.json(c);
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? 'Internal error' : err.message, issues: err.issues });
  });
  const idle = () => Promise.all([...pending]);
  return { app, svc, idle, shutdown: () => ocr.shutdown() };
}

if (require.main === module) {
  createApp().then(({ app, shutdown }) => {
    const port = process.env.PORT || 3000;
    const server = app.listen(port, () => console.log(`DocFlow running on http://localhost:${port}`));
    process.on('SIGINT', () => { shutdown().finally(() => server.close(() => process.exit(0))); });
  });
}

module.exports = { createApp };
