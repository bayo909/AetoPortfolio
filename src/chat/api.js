const express = require('express');
const multer = require('multer');

const COOKIE = 'sid';
const cookieOf = req => {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
};
const tokenOf = req => {
  const h = req.headers.authorization;
  return h && /^Bearer /i.test(h) ? h.slice(7).trim() : cookieOf(req);
};

function buildRouter(svc, { secureCookie = false } = {}) {
  const r = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const fileName = f => Buffer.from(f.originalname, 'latin1').toString('utf8');

  // naive per-IP+email limiter for credential endpoints
  const hits = new Map();
  const limited = (key, max = 10, windowMs = 60_000) => {
    const t = Date.now(), arr = (hits.get(key) || []).filter(x => t - x < windowMs);
    arr.push(t); hits.set(key, arr);
    if (hits.size > 5000) hits.clear();
    return arr.length > max;
  };
  const setCookie = (res, token) => res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${14 * 86400}${secureCookie ? '; Secure' : ''}`);

  r.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  r.post('/auth/register', (req, res) => {
    if (limited(`reg:${req.ip}`, 20)) return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
    const out = svc.register(req.body || {}); setCookie(res, out.token); res.status(201).json(out);
  });
  r.post('/auth/login', (req, res) => {
    const key = `login:${req.ip}:${String((req.body || {}).email).toLowerCase()}`;
    if (limited(key)) return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
    const out = svc.login(req.body || {}); setCookie(res, out.token); res.json(out);
  });
  r.post('/auth/logout', (req, res) => { svc.logout(tokenOf(req)); res.setHeader('Set-Cookie', `${COOKIE}=; Max-Age=0; Path=/`); res.json({ ok: true }); });

  // everything below needs a signed-in user
  r.use((req, res, next) => {
    req.user = svc.authenticate(tokenOf(req));
    if (!req.user) return res.status(401).json({ error: 'Please sign in' });
    next();
  });
  const u = req => req.user;

  r.get('/me', (req, res) => res.json({ user: svc.publicUser(u(req)), org: svc.orgInfo(u(req)), members: svc.members(u(req)), workspaces: svc.listWorkspaces(u(req)) }));
  r.patch('/members/:id', (req, res) => res.json(svc.setRole(u(req), req.params.id, req.body.role)));

  r.post('/workspaces', (req, res) => res.status(201).json(svc.createWorkspace(u(req), req.body || {})));
  r.post('/workspaces/join', (req, res) => {
    if (limited(`join:${req.ip}`, 10)) return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
    res.status(201).json(svc.joinWorkspace(u(req), req.body || {}));
  });
  r.get('/workspaces/:id', (req, res) => res.json(svc.getWorkspace(u(req), req.params.id)));
  r.patch('/workspaces/:id/settings', (req, res) => res.json(svc.updateSettings(u(req), req.params.id, req.body || {})));
  r.post('/workspaces/:id/invite/rotate', (req, res) => res.json(svc.rotateInvite(u(req), req.params.id)));
  r.post('/workspaces/:id/channels', (req, res) => res.status(201).json(svc.createChannel(u(req), req.params.id, req.body || {})));
  r.get('/workspaces/:id/templates', (req, res) => res.json(svc.listTemplates(u(req), req.params.id)));
  r.post('/workspaces/:id/templates', (req, res) => res.status(201).json(svc.createTemplate(u(req), req.params.id, req.body || {})));
  r.get('/workspaces/:id/requests', (req, res) => res.json(svc.openRequests(u(req), req.params.id)));
  r.get('/workspaces/:id/payables', (req, res) => res.json(svc.payables(u(req), req.params.id)));
  r.get('/workspaces/:id/ledger/trial-balance', (req, res) => res.json(svc.trialBalance(u(req), req.params.id)));
  r.get('/workspaces/:id/ledger/entries', (req, res) => res.json(svc.listEntries(u(req), req.params.id)));
  r.get('/workspaces/:id/ledger/entries/:eid/voucher', (req, res) => res.json(svc.voucher(u(req), req.params.id, req.params.eid)));
  r.get('/workspaces/:id/ledger/export.csv', (req, res) => res.type('text/csv').attachment('journal.csv').send(svc.payablesCsv(u(req), req.params.id)));
  r.get('/workspaces/:id/audit', (req, res) => res.json(svc.auditLog(u(req), req.params.id, req.query)));
  r.get('/workspaces/:id/audit/verify', (req, res) => res.json(svc.auditVerify(u(req), req.params.id)));

  r.get('/channels/:id/messages', (req, res) => res.json(svc.listMessages(u(req), req.params.id, req.query)));
  r.post('/channels/:id/messages', (req, res) => res.status(201).json(svc.postMessage(u(req), req.params.id, req.body || {})));
  r.post('/channels/:id/files', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Choose a file to upload' });
    res.status(201).json(svc.storeFile(u(req), req.params.id, { name: fileName(req.file), mime: req.file.mimetype, buffer: req.file.buffer }));
  });
  r.post('/channels/:id/requests', (req, res) => res.status(201).json(svc.createRequest(u(req), req.params.id, req.body || {})));
  r.get('/messages/:id/thread', (req, res) => res.json(svc.listThread(u(req), req.params.id)));

  r.post('/requests/:id/cancel', (req, res) => res.json(svc.cancelRequest(u(req), req.params.id)));
  // vendor answers a request with a file (multipart) or a filled template form (JSON)
  r.post('/requests/:id/submissions', upload.single('file'), wrap(async (req, res) => {
    let form = null;
    if (!req.file) {
      form = req.body && req.body.form;
      if (!form || typeof form !== 'object') return res.status(400).json({ error: 'Upload a file or fill in the template form' });
    }
    const file = req.file ? { name: fileName(req.file), mime: req.file.mimetype, buffer: req.file.buffer } : null;
    res.status(201).json(await svc.submit(u(req), req.params.id, { file, form }));
  }));
  r.get('/submissions/:id', (req, res) => res.json(svc.submission(u(req), req.params.id)));
  r.post('/submissions/:id/accept', (req, res) => res.json(svc.accept(u(req), req.params.id, req.body || {})));
  r.post('/submissions/:id/reject', (req, res) => res.json(svc.reject(u(req), req.params.id, req.body || {})));
  r.post('/submissions/:id/pay', (req, res) => res.status(201).json(svc.pay(u(req), req.params.id, req.body || {})));

  r.get('/files/:id', (req, res) => {
    const { meta, buffer } = svc.readFile(u(req), req.params.id);
    res.set({ 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    res.attachment(meta.name).send(buffer);
  });

  // server-sent events: ids only, the client refetches through the authorised endpoints
  r.get('/workspaces/:id/events', (req, res) => {
    const { ws } = svc.access(u(req), req.params.id);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    const fn = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    svc.bus.on(ws.id, fn);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); svc.bus.off(ws.id, fn); });
  });

  r.use((req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  r.use((err, req, res, next) => {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : err instanceof SyntaxError ? 400 : 500);
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? 'Internal error' : err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 15 MB' : err.message, issues: err.issues });
  });
  return r;
}

module.exports = { buildRouter };
