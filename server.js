const express = require('express');
const multer = require('multer');
const path = require('path');
const { loadMasterData } = require('./src/masterData');
const { loadPolicyChunks } = require('./src/policy');
const { createService } = require('./src/service');
const ocr = require('./src/ocr');
const fs = require('fs');
const { SESSION_TTL_MS, createThrottle } = require('./src/auth');
const { formatCredentials, writeCredentialsFile } = require('./src/logins');

const COOKIE = 'docflow_sid';
const parseCookies = h => Object.fromEntries(String(h || '').split(';').map(c => c.trim().split(/=(.*)/s).slice(0, 2)).filter(([k]) => k));

async function createApp(opts = {}) {
  const master = opts.master || loadMasterData();
  const chunks = opts.chunks || await loadPolicyChunks();
  const storageDir = opts.storageDir === undefined ? process.env.STORAGE_DIR || path.join(__dirname, 'storage') : opts.storageDir;
  const svc = createService({ master, chunks, storageDir });
  let firstRunLogins = null;
  if (opts.autoLogins !== false && !svc.hasUsers()) {   // first start: issue logins once and print them
    firstRunLogins = svc.generateLogins();
    writeCredentialsFile(storageDir, firstRunLogins);
  }
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
  const throttle = createThrottle();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/samples', express.static(path.join(__dirname, 'samples')));

  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const pending = new Set(); // in-flight processing jobs (awaited by tests via idle())
  const start = id => { const p = svc.processRecord(id).catch(e => console.error('processing failed', e)).finally(() => pending.delete(p)); pending.add(p); return p; };
  const setCookie = (req, res, token, maxAge) =>
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`);

  /* ---- authentication (public routes) ---- */
  app.get('/api/config', (req, res) => res.json(svc.config()));
  app.post('/api/auth/login', (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase();
    const key = `${req.ip}|${username}`;
    if (throttle.blocked(key)) throw new svc.HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
    const session = svc.login(username, req.body.password);
    if (!session) { throttle.fail(key); throw new svc.HttpError(401, 'Wrong username or password'); }
    throttle.clear(key);
    setCookie(req, res, session.token, Math.floor(SESSION_TTL_MS / 1000));
    res.json({ user: session.user });
  });
  app.post('/api/auth/logout', (req, res) => { svc.logout(parseCookies(req.headers.cookie)[COOKIE]); setCookie(req, res, '', 0); res.json({ ok: true }); });
  app.get('/api/auth/me', (req, res) => {
    const user = svc.userForToken(parseCookies(req.headers.cookie)[COOKIE]);
    if (!user) return res.status(401).json({ error: 'Not signed in' });
    res.json({ user });
  });

  // everything below needs a session
  app.use('/api', (req, res, next) => {
    const user = svc.userForToken(parseCookies(req.headers.cookie)[COOKIE]);
    if (!user) return res.status(401).json({ error: 'Please sign in' });
    req.user = user; next();
  });
  const buyerOnly = (req, res, next) => (req.user.role === 'buyer' ? next() : res.status(403).json({ error: 'Vendor logins cannot use this' }));

  // Upload: the record (and the stored file) exists as soon as this returns; processing continues in the background.
  app.post('/api/records', upload.single('file'), (req, res) => {
    if (!req.file) throw new svc.HttpError(400, 'Choose a file to upload');
    const filename = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const record = svc.createRecord({ buffer: req.file.buffer, filename, intake: req.body.intake, docType: req.body.docType, actor: req.user });
    start(record.id);
    res.status(201).json(record);
  });
  app.get('/api/records', (req, res) => res.json(svc.listRecords(req.user)));
  app.get('/api/records/:id', (req, res) => res.json(svc.getRecord(req.params.id, req.user)));
  app.get('/api/records/:id/file', (req, res) => {
    const f = svc.recordFile(req.params.id, req.user);
    res.type(f.mime).set('Content-Disposition', `inline; filename="${encodeURIComponent(f.filename)}"`).set('X-Content-Type-Options', 'nosniff');
    if (f.path) res.sendFile(f.path); else res.send(f.buffer);
  });
  app.get('/api/records/:id/preview', wrap(async (req, res) => res.json(await svc.recordPreview(req.params.id, req.user))));
  app.post('/api/records/:id/reprocess', buyerOnly, wrap(async (req, res) => res.json(await svc.reprocessRecord(req.params.id, req.user))));

  app.get('/api/parties', buyerOnly, (req, res) => res.json(svc.listParties(req.query.kind)));
  app.post('/api/parties', buyerOnly, (req, res) => res.status(201).json(svc.createParty(req.body, req.user)));
  app.patch('/api/parties/:id', buyerOnly, (req, res) => res.json(svc.updateParty(req.params.id, req.body, req.user)));
  app.post('/api/parties/:id/login', buyerOnly, (req, res) => res.json(svc.resetPartyLogin(req.params.id, req.user)));
  app.get('/api/users', buyerOnly, (req, res) => res.json(svc.listUsersFor(req.user)));

  app.get('/api/documents', (req, res) => res.json(svc.listDocuments(req.user)));
  app.get('/api/documents/:id', (req, res) => res.json(svc.getDocument(req.params.id, req.user)));
  app.patch('/api/documents/:id', buyerOnly, (req, res) => res.json(svc.update(req.params.id, req.body, req.user)));
  app.post('/api/documents/:id/submit', buyerOnly, (req, res) => res.json(svc.submit(req.params.id, req.user)));
  app.post('/api/documents/:id/approve', buyerOnly, (req, res) => res.json(svc.approve(req.params.id, req.body.role, req.user)));
  app.post('/api/documents/:id/reject', buyerOnly, (req, res) => res.json(svc.reject(req.params.id, req.user, req.body.reason)));
  app.post('/api/documents/:id/finance-review', buyerOnly, (req, res) => res.json(svc.financeReview(req.params.id, { ...req.body, by: req.user })));

  app.get('/api/bills', (req, res) => res.json(svc.listBills(req.user)));
  app.get('/api/bills/:id', (req, res) => res.json(svc.getBill(req.params.id, req.user)));
  app.post('/api/bills/:id/pay', buyerOnly, (req, res) => res.json(svc.payBill(req.params.id, req.user)));
  app.get('/api/bills/:id/csv', buyerOnly, (req, res) => {
    res.type('text/csv').attachment(`${svc.getBill(req.params.id, req.user).number}.csv`).send(svc.billCsv(req.params.id, req.user));
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
  return { app, svc, idle, firstRunLogins, storageDir, shutdown: () => ocr.shutdown() };
}

if (require.main === module) {
  createApp().then(({ app, shutdown, firstRunLogins, storageDir }) => {
    const port = process.env.PORT || 3000;
    const pidFile = path.join(storageDir, 'server.pid');
    const server = app.listen(port, () => {
      fs.mkdirSync(storageDir, { recursive: true }); fs.writeFileSync(pidFile, String(process.pid));
      console.log(`DocFlow running on http://localhost:${port}`);
      if (firstRunLogins) console.log(`\nFirst start: login profiles created (shown once, also saved to ${path.join(storageDir, 'logins.txt')}):\n\n${formatCredentials(firstRunLogins)}\n`);
    });
    const stop = () => { try { fs.unlinkSync(pidFile); } catch { /* already gone */ } shutdown().finally(() => server.close(() => process.exit(0))); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  });
}

module.exports = { createApp };
