// HTTP layer: authentication, CSRF protection, security headers, authorisation and all /api routes.
const express = require('express');
const multer = require('multer');
const path = require('path');
const QRCode = require('qrcode');
const { createPlatform } = require('./index');
const { HttpError } = require('./errors');
const { toQtyMilli } = require('./money');

const COOKIE = 'pf_session';
const SENSITIVE = /^\/api\/(docs\/records\/[^/]+\/(file|preview)|kyb\/evidence|audit|qr\/resolve|admin\/kyb)/;

function parseCookies(h) { const o = {}; for (const p of String(h || '').split(';')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } return o; }

function createApp(opts = {}) {
  const core = opts.core || createPlatform(opts);
  const { svc } = core;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY ? 1 : 0);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
  const secureCookie = (opts.env || process.env).COOKIE_SECURE === '1';

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' blob:; object-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN', 'Permissions-Policy': 'camera=(self), geolocation=(), microphone=()',
      ...(secureCookie ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
    });
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  // coarse per-IP rate limit on the API
  const hits = new Map();
  app.use('/api', (req, res, next) => {
    const k = req.ip; const t = Date.now(); const w = hits.get(k) || { n: 0, reset: t + 60000 };
    if (t > w.reset) { w.n = 0; w.reset = t + 60000; }
    w.n++; hits.set(k, w);
    if (w.n > (opts.rateLimit || 1200)) return res.status(429).json({ error: 'Too many requests' });
    next();
  });

  // authentication: session cookie (SameSite=Strict + CSRF header on writes) or Authorization: Bearer
  app.use('/api', (req, res, next) => {
    const bearer = (req.headers.authorization || '').match(/^Bearer (.+)$/);
    const cookieTok = parseCookies(req.headers.cookie)[COOKIE];
    const token = bearer ? bearer[1] : cookieTok;
    req.token = token;
    req.ctx = svc.auth.authenticate(token);
    req.viaCookie = !bearer && !!cookieTok;
    if (req.viaCookie && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-pf-csrf'] !== '1') return res.status(403).json({ error: 'Missing CSRF header' });
    if (req.ctx && SENSITIVE.test(req.originalUrl.split('?')[0])) {
      core.db.insert('access_logs', { id: core.uid(), org_id: req.ctx.orgId, user_id: req.ctx.userId, method: req.method, path: req.originalUrl.split('?')[0], status: 0, sensitive: 1, at: core.iso() });
    }
    next();
  });

  const wrap = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).then(r => { if (r !== undefined && !res.headersSent) res.json(r); }).catch(next);
  const authed = fn => wrap((req, res) => { if (!req.ctx) throw new HttpError(401, 'Please sign in', undefined, 'unauthenticated'); return fn(req, res, req.ctx); });
  const g = (p, fn) => app.get(`/api${p}`, authed(fn));
  const post = (p, fn) => app.post(`/api${p}`, authed(fn));
  const patch = (p, fn) => app.patch(`/api${p}`, authed(fn));
  const put = (p, fn) => app.put(`/api${p}`, authed(fn));
  const del = (p, fn) => app.delete(`/api${p}`, authed(fn));
  const file = req => (req.file ? { buffer: req.file.buffer, filename: Buffer.from(req.file.originalname, 'latin1').toString('utf8'), mime: req.file.mimetype } : null);
  const sendFile = (res, f, inline = false) => { res.set({ 'Content-Type': f.mime || 'application/octet-stream', 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(f.filename)}"`, 'X-Content-Type-Options': 'nosniff' }); res.send(f.buffer); };
  const setCookie = (res, session) => res.cookie(COOKIE, session.token, { httpOnly: true, sameSite: 'strict', secure: secureCookie, expires: new Date(session.expiresAt), path: '/' });

  /* ------------------------------- auth ------------------------------- */
  app.post('/api/auth/register', wrap((req, res) => { const r = svc.auth.register(req.body); setCookie(res, r.session); res.status(201); return { user: r.user, org: r.org }; }));
  app.post('/api/auth/login', wrap((req, res) => { const r = svc.auth.login(req.body.email, req.body.password); setCookie(res, r.session); return { user: r.user, token: opts.exposeToken ? r.session.token : undefined }; }));
  app.post('/api/auth/logout', wrap((req, res) => { svc.auth.logout(req.token); res.clearCookie(COOKIE); return { ok: true }; }));
  g('/auth/me', (req, res, ctx) => svc.auth.me(ctx));
  post('/auth/switch-org', (req, res, ctx) => { svc.auth.switchOrg(req.token, ctx, req.body.orgId); return { ok: true }; });
  app.get('/api/invitations/preview/:token', wrap(req => svc.auth.previewInvitation(req.params.token)));
  app.post('/api/invitations/accept', wrap((req, res) => {
    const r = svc.auth.acceptInvitation(req.body.token, { ctx: req.ctx, name: req.body.name, password: req.body.password, orgName: req.body.orgName, country: req.body.country });
    if (r.session) setCookie(res, r.session);
    return { org: r.org, relationship: r.relationship, signedIn: !!r.session };
  }));
  app.get('/api/public/config', wrap(() => ({ countries: svc.auth.COUNTRIES, plans: svc.subscriptions.plans(), demo: !!(opts.env || process.env).SEED_DEMO || core.db.get('SELECT 1 x FROM organizations WHERE is_demo = 1') != null,
    demoPassword: core.db.get('SELECT 1 x FROM organizations WHERE is_demo = 1') ? 'PayUnoDemo!2026' : null,
    demoUsers: core.db.get('SELECT 1 x FROM organizations WHERE is_demo = 1') ? core.db.all("SELECT u.email, u.name, m.role, o.name org FROM users u JOIN organization_members m ON m.user_id = u.id JOIN organizations o ON o.id = m.org_id WHERE o.is_demo = 1 ORDER BY o.name, u.name") : [] })));
  app.get('/api/health', wrap(() => ({ ok: true })));

  /* ------------------------------ organisation ------------------------------ */
  g('/org/members', (r, s, ctx) => svc.auth.listMembers(ctx));
  g('/org/directory', (r, s, ctx) => svc.auth.directory(ctx));
  patch('/org/members/:id', (req, s, ctx) => svc.auth.updateMember(ctx, req.params.id, req.body));
  g('/org/invitations', (r, s, ctx) => svc.auth.listInvitations(ctx));
  post('/org/invitations', (req, s, ctx) => svc.auth.createInvitation(ctx, req.body));
  del('/org/invitations/:id', (req, s, ctx) => svc.auth.revokeInvitation(ctx, req.params.id) || { ok: true });
  g('/vendor/customers', (r, s, ctx) => svc.vendor.listCustomers(ctx));
  post('/org/relationships/:id/revoke', (req, s, ctx) => svc.vendor.revokeRelationship(ctx, req.params.id) || { ok: true });

  /* -------------------------------- vendor -------------------------------- */
  g('/vendor/profile', (r, s, ctx) => svc.vendor.getProfile(ctx));
  patch('/vendor/profile', (req, s, ctx) => svc.vendor.updateProfile(ctx, req.body));
  g('/vendor/products', (r, s, ctx) => svc.vendor.listProducts(ctx));
  post('/vendor/products', (req, s, ctx) => svc.vendor.saveProduct(ctx, null, req.body));
  patch('/vendor/products/:id', (req, s, ctx) => svc.vendor.saveProduct(ctx, req.params.id, req.body));
  del('/vendor/products/:id', (req, s, ctx) => svc.vendor.deleteProduct(ctx, req.params.id) || { ok: true });
  g('/vendor/pricing-rules', (r, s, ctx) => svc.vendor.listPricingRules(ctx));
  post('/vendor/pricing-rules', (req, s, ctx) => svc.vendor.savePricingRule(ctx, req.body));

  /* ------------------------------- marketplace ------------------------------- */
  g('/marketplace/vendors', (r, s, ctx) => svc.vendor.listVendors(ctx));
  g('/marketplace/vendors/:orgId', (req, s, ctx) => svc.vendor.storefront(ctx, req.params.orgId));
  post('/marketplace/vendors/:orgId/ask', (req, s, ctx) => { ctx.require('marketplace.browse'); svc.vendor.storefront(ctx, req.params.orgId); return svc.agent.answer(req.params.orgId, ctx.orgId, req.body.question || ''); });

  /* --------------------------- requests / commercial docs --------------------------- */
  g('/requests', (r, s, ctx) => svc.commerce.listRequests(ctx));
  post('/requests', (req, s, ctx) => svc.commerce.createRequest(ctx, req.body));
  g('/requests/:id', (req, s, ctx) => svc.commerce.getRequest(ctx, req.params.id));
  post('/requests/:id/cancel', (req, s, ctx) => svc.commerce.cancelRequest(ctx, req.params.id) || { ok: true });
  g('/purchase-orders', (r, s, ctx) => svc.commerce.listPurchaseOrders(ctx));
  g('/purchase-requests', (r, s, ctx) => svc.commerce.listPurchaseRequests(ctx));

  post('/agent/draft', async (req, s, ctx) => {
    ctx.require('agent.use');
    const rq = svc.commerce.mustRequest(ctx, req.body.requestId);
    if (rq.vendor_org_id !== ctx.orgId) throw new HttpError(403, 'Only the vendor can draft against this request');
    svc.subscriptions.assertEntitled(ctx.orgId, 'ai_agent');
    const type = req.body.type || (rq.kind === 'invoice_request' ? 'invoice' : 'quote');
    let items = JSON.parse(rq.items_json).map(i => ({ productId: i.productId, sku: i.sku, description: i.description, qtyMilli: i.qtyMilli }));
    const extra = [];
    if (req.body.instruction) {
      const out = await svc.agent.interpret(ctx.orgId, req.body.instruction);
      for (const q of out.questions) extra.push({ level: 'warning', code: 'clarify', msg: q });
      for (const it of out.items) if (it.qty) items.push({ sku: it.sku, description: '', qtyMilli: Math.round(it.qty * 1000) });
      extra.push({ level: 'info', code: 'agent', msg: `Interpreted instruction via ${out.provider}` });
    }
    const flags = [{ level: 'info', code: 'ai_draft', msg: 'AI-prepared DRAFT — not visible to the customer until a vendor approver approves it.' }, ...extra];
    const lines = items.map(i => ({ productId: i.productId, sku: i.sku, description: i.description, qtyMilli: i.qtyMilli }));
    const doc = type === 'invoice'
      ? svc.commerce.createInvoice(ctx, { requestId: rq.id, lines }, { via: 'agent', extraFlags: flags })
      : svc.commerce.createQuote(ctx, { requestId: rq.id, lines, terms: req.body.terms }, { via: 'agent', extraFlags: flags });
    const ch = core.db.get("SELECT id FROM channels WHERE kind='transaction' AND ref_type='request' AND ref_id = ?", rq.id);
    if (ch) core.svc.chat.insertMessage(ch.id, { userId: null, kind: 'agent', body: `AI Billing Agent: a draft ${type} for ${rq.number} is being prepared by ${ctx.org.name}. It stays internal until a vendor approver approves it.` });
    return { type, document: doc };
  });

  g('/quotes', (r, s, ctx) => svc.commerce.listQuotes(ctx));
  post('/quotes', (req, s, ctx) => svc.commerce.createQuote(ctx, req.body));
  g('/quotes/:id', (req, s, ctx) => svc.commerce.getQuote(ctx, req.params.id));
  patch('/quotes/:id', (req, s, ctx) => svc.commerce.updateQuote(ctx, req.params.id, req.body));
  for (const [a, fn] of [['submit', 'submitQuote'], ['approve', 'approveQuote'], ['reject', 'rejectQuote'], ['revise', 'reviseQuote'], ['accept', 'acceptQuote'], ['decline', 'declineQuote']])
    post(`/quotes/:id/${a}`, (req, s, ctx) => svc.commerce[fn](ctx, req.params.id, a === 'decline' ? req.body.reason : req.body));
  g('/invoices', (r, s, ctx) => svc.commerce.listInvoices(ctx));
  post('/invoices', (req, s, ctx) => svc.commerce.createInvoice(ctx, req.body));
  g('/invoices/:id', (req, s, ctx) => svc.commerce.getInvoice(ctx, req.params.id));
  patch('/invoices/:id', (req, s, ctx) => svc.commerce.updateInvoice(ctx, req.params.id, req.body));
  for (const [a, fn] of [['submit', 'submitInvoice'], ['approve', 'approveInvoice'], ['reject', 'rejectInvoice'], ['issue', 'issueInvoice'], ['revise', 'reviseInvoice']])
    post(`/invoices/:id/${a}`, (req, s, ctx) => svc.commerce[fn](ctx, req.params.id, req.body));
  post('/invoices/:id/cancel', (req, s, ctx) => svc.commerce.cancelInvoice(ctx, req.params.id, req.body.reason));
  g('/invoices/:id/qr', async (req, s, ctx) => {
    const q = svc.commerce.qrFor(ctx, req.params.id);
    const url = `${(opts.env || process.env).PUBLIC_URL || `${req.protocol}://${req.get('host')}`}/#/pay?t=${q.token}`;
    return { ...q, url, svg: await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) };
  });

  /* ------------------------------ collaboration ------------------------------ */
  g('/channels', (r, s, ctx) => svc.chat.list(ctx));
  post('/channels', (req, s, ctx) => svc.chat.createChannel(ctx, req.body));
  post('/channels/dm', (req, s, ctx) => svc.chat.directMessage(ctx, req.body.userId));
  g('/channels/:id/messages', (req, s, ctx) => svc.chat.messages(ctx, req.params.id, { parent: req.query.parent || null, afterSeq: Number(req.query.after || 0) }));
  app.post('/api/channels/:id/messages', upload.single('file'), authed((req, res, ctx) => {
    const body = typeof req.body.body === 'string' ? req.body.body : '';
    const out = svc.chat.post(ctx, req.params.id, { body, parentId: req.body.parentId || null, file: file(req) });
    if (/(^|\s)@agent\b/i.test(body)) {
      const ch = core.db.get('SELECT * FROM channels WHERE id = ?', req.params.id);
      const vendorId = ch.vendor_org_id;
      if (vendorId && ctx.org.is_customer && core.svc.vendor.activeRelationship(ctx.orgId, vendorId)) {
        const a = svc.agent.answer(vendorId, ctx.orgId, body.replace(/@agent/ig, ''));
        svc.chat.insertMessage(ch.id, { userId: null, kind: 'agent', body: `AI Billing Agent (answers from ${core.db.get('SELECT name FROM organizations WHERE id = ?', vendorId).name}'s published catalogue only):\n${a.text}`, parentId: req.body.parentId || null });
      }
    }
    return out;
  }));
  post('/messages/:id/react', (req, s, ctx) => svc.chat.react(ctx, req.params.id, req.body.emoji));
  app.get('/api/attachments/:id', authed((req, res, ctx) => { sendFile(res, svc.chat.attachment(ctx, req.params.id)); }));
  g('/search', (req, s, ctx) => svc.chat.search(ctx, req.query.q));
  g('/notifications', (r, s, ctx) => svc.chat.notifications(ctx));
  post('/notifications/read', (r, s, ctx) => svc.chat.readNotifications(ctx) || { ok: true });
  app.get('/api/stream', authed((req, res, ctx) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    const onMsg = e => { if (e.userIds.includes(ctx.userId)) res.write(`event: message\ndata: ${JSON.stringify({ channelId: e.channelId })}\n\n`); };
    const onNote = n => { if (n.user_id === ctx.userId) res.write(`event: notify\ndata: ${JSON.stringify({ title: n.title })}\n\n`); };
    core.bus.on('message', onMsg); core.bus.on('notify', onNote);
    const hb = setInterval(() => res.write(': hb\n\n'), 25000);
    req.on('close', () => { clearInterval(hb); core.bus.off('message', onMsg); core.bus.off('notify', onNote); });
    return undefined;
  }));

  /* ------------------------------- RT-FEPE docs ------------------------------- */
  g('/docs/config', (r, s, ctx) => svc.rtfepe.config(ctx));
  g('/docs/parties', (r, s, ctx) => svc.rtfepe.parties(ctx));
  app.post('/api/docs/upload', upload.single('file'), authed((req, res, ctx) => {
    if (!req.file) throw new HttpError(400, 'Choose a file to upload');
    res.status(201);
    return svc.rtfepe.upload(ctx, { buffer: req.file.buffer, filename: file(req).filename, intake: req.body.intake, docType: req.body.docType });
  }));
  g('/docs/records', (r, s, ctx) => svc.rtfepe.listRecords(ctx));
  g('/docs/records/:id', (req, s, ctx) => svc.rtfepe.getRecord(ctx, req.params.id));
  app.get('/api/docs/records/:id/file', authed((req, res, ctx) => {
    const f = svc.rtfepe.recordFile(ctx, req.params.id);
    const viewable = f.mime === 'application/pdf' || /^image\//.test(f.mime);   // browsers sandbox their own PDF/image viewers; everything else is served inert
    res.set({ 'Content-Type': f.mime, 'Content-Disposition': `inline; filename="${encodeURIComponent(f.filename)}"`, 'X-Content-Type-Options': 'nosniff', ...(viewable ? {} : { 'Content-Security-Policy': "default-src 'none'; sandbox" }) });
    if (f.path) res.sendFile(f.path); else res.send(f.buffer);
  }));
  g('/docs/records/:id/preview', (req, s, ctx) => svc.rtfepe.recordPreview(ctx, req.params.id));
  post('/docs/records/:id/reprocess', (req, s, ctx) => svc.rtfepe.reprocess(ctx, req.params.id));
  g('/docs/documents', (r, s, ctx) => svc.rtfepe.listDocuments(ctx));
  g('/docs/documents/:id', (req, s, ctx) => svc.rtfepe.getDocument(ctx, req.params.id));
  patch('/docs/documents/:id', (req, s, ctx) => svc.rtfepe.updateDocument(ctx, req.params.id, req.body));
  post('/docs/documents/:id/submit', (req, s, ctx) => svc.rtfepe.submitDocument(ctx, req.params.id, req.body));
  post('/docs/documents/:id/approve', (req, s, ctx) => svc.rtfepe.approveDocument(ctx, req.params.id, req.body.role));
  post('/docs/documents/:id/reject', (req, s, ctx) => svc.rtfepe.rejectDocument(ctx, req.params.id, req.body.reason));
  post('/docs/documents/:id/rematch', (req, s, ctx) => svc.rtfepe.rematch(ctx, req.params.id));
  post('/docs/documents/:id/request-info', (req, s, ctx) => svc.rtfepe.requestInfo(ctx, req.params.id, req.body.note));
  post('/docs/documents/:id/finance-review', (req, s, ctx) => svc.rtfepe.financeReview(ctx, req.params.id, req.body));
  g('/docs/policy/:chunk', (req, s, ctx) => svc.rtfepe.policyRef(ctx, req.params.chunk));

  g('/events/status', (r, s, ctx) => svc.rtfepe.eventsStatus(ctx));
  g('/events', (req, s, ctx) => svc.rtfepe.listEvents(ctx, { q: req.query.q || '', sourceDocument: req.query.sourceDocument || '' }));
  app.post('/api/events/import', upload.single('file'), authed(async (req, res, ctx) => { if (!req.file) throw new HttpError(400, 'Choose the Financial Events CSV'); return svc.rtfepe.importEvents(ctx, { filename: file(req).filename, buffer: req.file.buffer, isDemo: req.body.isDemo === '1' }); }));
  patch('/events/:id', (req, s, ctx) => svc.rtfepe.updateEvent(ctx, req.params.id, req.body));
  g('/policies', (r, s, ctx) => svc.policy.list(ctx));
  app.post('/api/policies/import', upload.single('file'), authed(async (req, res, ctx) => { if (!req.file) throw new HttpError(400, 'Choose the policy document'); return svc.policy.importPolicy(ctx, { filename: file(req).filename, buffer: req.file.buffer, isDemo: req.body.isDemo === '1' }); }));
  g('/policies/:id/rules', (req, s, ctx) => svc.policy.rules(ctx, req.params.id));
  post('/policies/:id/activate', (req, s, ctx) => svc.policy.activate(ctx, req.params.id) || { ok: true });
  patch('/policy-rules/:id', (req, s, ctx) => svc.policy.reviewRule(ctx, req.params.id, req.body) || { ok: true });

  /* ----------------------------- bills / approvals ----------------------------- */
  g('/bills', (req, s, ctx) => svc.bills.list(ctx, req.query));
  g('/bills/:id', (req, s, ctx) => svc.bills.get(ctx, req.params.id));
  patch('/bills/:id', (req, s, ctx) => svc.bills.validate(ctx, req.params.id, req.body));
  post('/bills/:id/submit', (req, s, ctx) => svc.bills.submit(ctx, req.params.id));
  post('/bills/:id/confirm-receipt', (req, s, ctx) => svc.bills.confirmReceipt(ctx, req.params.id));
  post('/bills/:id/dispute', (req, s, ctx) => svc.bills.dispute(ctx, req.params.id, req.body.reason));
  post('/bills/:id/reopen', (req, s, ctx) => svc.bills.reopen(ctx, req.params.id));
  post('/bills/:id/release-quarantine', (req, s, ctx) => svc.bills.releaseQuarantine(ctx, req.params.id, req.body.reason));
  post('/bills/:id/retry-posting', (req, s, ctx) => svc.bills.retryPosting(ctx, req.params.id));
  g('/bills/:id/attachments', (req, s, ctx) => svc.bills.attachments(ctx, req.params.id));
  app.post('/api/expenses', upload.single('file'), authed((req, res, ctx) => { res.status(201); return svc.bills.submitExpense(ctx, req.body, file(req)); }));
  g('/approvals', (r, s, ctx) => svc.bills.pendingApprovals(ctx));
  post('/approvals/:stepId/decide', (req, s, ctx) => svc.bills.decide(ctx, req.params.stepId, req.body));

  /* ------------------------------ wallets / payments ------------------------------ */
  g('/wallets', (r, s, ctx) => svc.payments.listWallets(ctx));
  post('/wallets', (req, s, ctx) => svc.payments.createWallet(ctx, req.body));
  patch('/wallets/:id', (req, s, ctx) => svc.payments.updateWallet(ctx, req.params.id, req.body));
  post('/wallets/:id/topup', (req, s, ctx) => svc.payments.topup(ctx, req.params.id, Number(req.body.amountMinor)));
  g('/wallets/:id/transactions', (req, s, ctx) => svc.payments.walletTransactions(ctx, req.params.id));
  app.get('/api/wallets/:id/statement.csv', authed((req, res, ctx) => { res.type('text/csv').attachment('wallet-statement.csv').send(svc.payments.statementCsv(ctx, req.params.id)); }));
  post('/qr/resolve', (req, s, ctx) => svc.payments.resolveQr(ctx, req.body.token));
  post('/payments/intents', (req, s, ctx) => svc.payments.createIntent(ctx, req.body));
  g('/payments/intents', (r, s, ctx) => svc.payments.listIntents(ctx));
  post('/payments/intents/:id/execute', (req, s, ctx) => svc.payments.execute(ctx, req.params.id, req.body));
  post('/payments/intents/:id/cancel', (req, s, ctx) => svc.payments.cancelIntent(ctx, req.params.id));
  post('/payments/intents/:id/refresh', (req, s, ctx) => svc.payments.refresh(ctx, req.params.id));
  g('/payments/intents/:id/receipt', (req, s, ctx) => svc.payments.receipt(ctx, req.params.id));
  g('/transactions', (r, s, ctx) => svc.payments.transactions(ctx));
  g('/reconciliation', (r, s, ctx) => svc.payments.reconciliation(ctx));
  post('/reconciliation/run', (r, s, ctx) => svc.payments.runReconciliation(ctx));
  // provider webhook: authenticated by signature, not by session
  app.post('/api/webhooks/sandbox-provider', express.text({ type: '*/*', limit: '100kb' }), wrap(req => svc.payments.handleProviderEvent(typeof req.body === 'string' ? req.body : JSON.stringify(req.body), req.headers['x-provider-signature'])));

  /* ----------------------------------- ledger ----------------------------------- */
  g('/ledger/accounts', (r, s, ctx) => svc.ledger.accounts(ctx));
  post('/ledger/accounts', (req, s, ctx) => svc.ledger.saveAccount(ctx, req.body));
  g('/ledger/journal', (req, s, ctx) => svc.ledger.journal(ctx, { billId: req.query.billId, limit: req.query.limit }));
  post('/ledger/journal/:id/reverse', (req, s, ctx) => svc.ledger.reverse(ctx, req.params.id, req.body.reason));
  g('/ledger/periods', (r, s, ctx) => svc.ledger.periods(ctx));
  post('/ledger/periods', (req, s, ctx) => svc.ledger.setPeriod(ctx, req.body.period, !!req.body.locked));
  g('/ledger/trial-balance', (req, s, ctx) => svc.ledger.trialBalance(ctx, req.query.asOf || undefined));
  g('/ledger/statements', (r, s, ctx) => svc.ledger.statements(ctx));
  g('/ledger/export', (req, s, ctx) => svc.ledger.export(ctx, req.query));
  g('/audit', (req, s, ctx) => svc.admin.auditTrail(ctx, req.query));
  g('/audit/verify', (r, s, ctx) => svc.admin.verifyAudit(ctx));
  g('/audit/trace/:billId', (req, s, ctx) => svc.admin.trace(ctx, req.params.billId));
  g('/audit/access-log', (r, s, ctx) => svc.admin.accessLog(ctx));
  g('/overview', (r, s, ctx) => svc.admin.overview(ctx));
  g('/reports', (r, s, ctx) => svc.admin.reports(ctx));
  g('/budgets', (r, s, ctx) => svc.admin.budgets(ctx));
  post('/budgets', (req, s, ctx) => svc.admin.saveBudget(ctx, req.body));
  g('/cost-centers', (r, s, ctx) => svc.admin.costCenters(ctx));
  post('/cost-centers', (req, s, ctx) => svc.admin.saveCostCenter(ctx, req.body));
  g('/integrations', (r, s, ctx) => svc.admin.integrations(ctx));
  post('/integrations', (req, s, ctx) => svc.admin.saveIntegration(ctx, req.body));
  post('/integrations/:id/sync', (req, s, ctx) => svc.admin.syncIntegration(ctx, req.params.id));

  /* ------------------------------ KYB & subscriptions ------------------------------ */
  g('/kyb', (r, s, ctx) => svc.compliance.myCase(ctx));
  put('/kyb/data', (req, s, ctx) => svc.compliance.saveData(ctx, req.body));
  app.post('/api/kyb/evidence', upload.single('file'), authed((req, res, ctx) => svc.compliance.addEvidence(ctx, { kind: req.body.kind, filename: file(req) && file(req).filename, buffer: req.file && req.file.buffer, expiresAt: req.body.expiresAt })));
  post('/kyb/submit', (r, s, ctx) => svc.compliance.submit(ctx));
  g('/kyb/configs', (r, s, ctx) => svc.compliance.configs(ctx));
  app.get('/api/kyb/evidence/:id', authed((req, res, ctx) => { sendFile(res, { ...svc.compliance.evidenceFile(ctx, req.params.id), mime: 'application/octet-stream' }); }));
  g('/admin/kyb', (r, s, ctx) => svc.compliance.queue(ctx));
  post('/admin/kyb/:id/decide', (req, s, ctx) => svc.compliance.decide(ctx, req.params.id, req.body));
  post('/admin/kyb-expiry', (r, s, ctx) => svc.compliance.runExpiry(ctx));
  put('/admin/kyb-config', (req, s, ctx) => svc.compliance.saveConfig(ctx, req.body));
  post('/admin/kyb-config/:country/validate', (req, s, ctx) => svc.compliance.validateConfig(ctx, req.params.country));
  g('/subscription', (r, s, ctx) => svc.subscriptions.get(ctx));
  g('/plans', (r, s, ctx) => svc.subscriptions.plans());
  post('/subscription/change', (req, s, ctx) => svc.subscriptions.change(ctx, req.body));
  post('/subscription/cancel', (r, s, ctx) => svc.subscriptions.cancel(ctx));
  post('/subscription/retry', (r, s, ctx) => svc.subscriptions.retryPayment(ctx));
  post('/subscription/payment-method', (req, s, ctx) => svc.subscriptions.setPaymentMethod(ctx, req.body.mode));
  put('/admin/plans/:key', (req, s, ctx) => svc.subscriptions.savePlan(ctx, { ...req.body, key: req.params.key }));
  g('/admin/subscriptions', (r, s, ctx) => svc.subscriptions.listAll(ctx));
  post('/admin/subscriptions/renewals', (r, s, ctx) => { ctx.require('platform.manage'); return svc.subscriptions.processRenewals(); });
  g('/admin/tenants', (r, s, ctx) => svc.admin.tenants(ctx));
  post('/admin/tenants/:id/status', (req, s, ctx) => svc.admin.setTenantStatus(ctx, req.params.id, req.body.status, req.body.reason) || { ok: true });
  g('/admin/health', (r, s, ctx) => svc.admin.health(ctx));
  g('/admin/roles', (r, s, ctx) => { ctx.require('platform.manage'); return svc.admin.roles(); });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(express.static(path.join(__dirname, '..', 'web'), { index: 'index.html', maxAge: 0 }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    if (/FOREIGN KEY|constraint failed|CHECK/i.test(err.message || '') && status === 500) status = 422;
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? 'Internal error' : (status === 422 && !err.status ? 'The change was rejected by a data integrity rule' : err.message), code: err.code, issues: err.issues });
  });
  return { app, core, idle: () => core.idle() };
}

if (require.main === module) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'storage');
  require('fs').mkdirSync(dataDir, { recursive: true });
  const dbFile = process.env.DATABASE_FILE || path.join(dataDir, 'payuno.db');
  const { app, core } = createApp({ dbFile, storageDir: dataDir });
  if (process.env.SEED_DEMO !== '0' && !core.db.get('SELECT 1 x FROM organizations LIMIT 1')) require('./seed').seed(core);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`PayUno Flow running on http://localhost:${port}  (sandbox payments, simulated balances)`));
}
module.exports = { createApp };
