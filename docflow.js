const express = require('express');
const multer = require('multer');
const path = require('path');
const { loadMasterData } = require('./src/masterData');
const { loadPolicyChunks } = require('./src/policy');
const { extractLines } = require('./src/extract');
const { createService } = require('./src/service');

async function createApp(opts = {}) {
  const master = opts.master || loadMasterData();
  const chunks = opts.chunks || await loadPolicyChunks();
  const svc = createService({ master, chunks });
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, 'public', 'docflow')));
  app.use('/samples', express.static(path.join(__dirname, 'samples')));

  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  app.get('/api/source-documents', (req, res) => res.json(svc.sourceDocuments()));

  app.post('/api/uploads', upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw new svc.HttpError(400, 'Choose a file to upload');
    const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const lines = await extractLines(req.file.buffer, name);
    if (!lines.length) throw new svc.HttpError(422, 'No text could be extracted. Scanned images need OCR, which this MVP does not include.');
    res.status(201).json(svc.createUpload(name, lines));
  }));
  app.get('/api/uploads/:id', (req, res) => res.json(svc.getUpload(req.params.id)));
  app.get('/api/uploads/:id/matches', (req, res) => res.json(svc.previewMatches(req.params.id, req.query.sourceDocument)));
  app.post('/api/uploads/:id/generate', (req, res) => res.status(201).json(svc.generate(req.params.id, req.body.sourceDocument, req.body.items)));

  app.get('/api/documents', (req, res) => res.json(svc.listDocuments()));
  app.get('/api/documents/:id', (req, res) => res.json(svc.getDocument(req.params.id)));
  app.patch('/api/documents/:id', (req, res) => res.json(svc.update(req.params.id, req.body)));
  app.post('/api/documents/:id/submit', (req, res) => res.json(svc.submit(req.params.id, req.body.by)));
  app.post('/api/documents/:id/approve', (req, res) => res.json(svc.approve(req.params.id, req.body.role, req.body.by)));
  app.post('/api/documents/:id/reject', (req, res) => res.json(svc.reject(req.params.id, req.body.by, req.body.reason)));
  app.post('/api/documents/:id/finance-review', (req, res) => res.json(svc.financeReview(req.params.id, req.body)));
  app.post('/api/documents/:id/convert', (req, res) => res.status(201).json(svc.convertToBill(req.params.id, req.body.by)));

  app.get('/api/bills', (req, res) => res.json(svc.listBills()));
  app.get('/api/bills/:id', (req, res) => res.json(svc.getBill(req.params.id)));
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
  return { app, svc };
}

if (require.main === module) { // standalone: node docflow.js
  createApp().then(({ app }) => {
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`DocFlow running on http://localhost:${port}`));
  });
}

module.exports = { createApp };
