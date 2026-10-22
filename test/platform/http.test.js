const test = require('node:test');
const assert = require('node:assert');
const { seeded } = require('./helpers');
const { createApp } = require('../../platform/server');
const { DEMO_INVITE_TOKEN } = require('../../platform/seed');

async function boot() {
  const w = await seeded();
  const { app } = createApp({ core: w.core, rateLimit: 100000 });
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    const call = async (method, url, body, { csrf = true, headers = {}, raw = false } = {}) => {
      const res = await fetch(base + url, { method, headers: { ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-pf-csrf': '1' } : {}), ...headers }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      if (raw) return res;
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch { json = text; }
      return { status: res.status, body: json, headers: res.headers };
    };
    return { call, get: (u, o) => call('GET', u, null, o), post: (u, b, o) => call('POST', u, b, o), login: (email) => call('POST', '/api/auth/login', { email, password: w.PASSWORD }, { csrf: false }) };
  };
  return { w, base, client, close: () => server.close() };
}

test('HTTP: cookie sessions, CSRF header on writes, security headers, and 401 when signed out', async () => {
  const h = await boot();
  try {
    const anon = h.client();
    assert.strictEqual((await anon.get('/api/bills')).status, 401);
    assert.strictEqual((await anon.get('/api/health')).body.ok, true);
    const pub = await anon.get('/api/public/config');
    assert.strictEqual(pub.status, 200); assert.ok(pub.body.demoUsers.length > 15);
    const bad = await anon.login('chidi.nwosu@apex.example'.replace('chidi', 'nobody'));
    assert.strictEqual(bad.status, 401);
    const c = h.client();
    const ok = await c.login('tunde.bakare@apex.example');
    assert.strictEqual(ok.status, 200);
    assert.match(ok.headers.get('set-cookie'), /HttpOnly/i); assert.match(ok.headers.get('set-cookie'), /SameSite=Strict/i);
    assert.match(ok.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.strictEqual(ok.headers.get('x-content-type-options'), 'nosniff');
    const me = await c.get('/api/auth/me');
    assert.strictEqual(me.body.role, 'finance_officer'); assert.ok(me.body.permissions.includes('bill.validate'));
    // a cross-site form post carries the cookie but not the custom header: refused
    const forged = await c.post('/api/bills/x/submit', {}, { csrf: false });
    assert.strictEqual(forged.status, 403); assert.match(forged.body.error, /CSRF/);
    // role checks happen on the server regardless of what the UI shows
    const emp = h.client(); await emp.login('chidi.nwosu@apex.example');
    assert.strictEqual((await emp.post('/api/ledger/periods', { period: '2026-01', locked: true })).status, 403);
    assert.strictEqual((await emp.get('/api/audit')).status, 403);
    // tenant isolation over HTTP
    const bills = (await c.get('/api/bills')).body;
    const gf = h.client(); await gf.login('hauwa.musa@greenfield.example');
    assert.strictEqual((await gf.get(`/api/bills/${bills[0].id}`)).status, 404);
    assert.deepStrictEqual((await gf.get('/api/bills')).body, []);
    const logout = await c.post('/api/auth/logout', {});
    assert.strictEqual(logout.status, 200);
    assert.strictEqual((await c.get('/api/auth/me')).status, 401, 'logout invalidates the session server-side');
  } finally { h.close(); }
});

test('HTTP: invitation → registration → KYB-pending relationship; QR image carries only a signed link', async () => {
  const h = await boot();
  try {
    const anon = h.client();
    const prev = await anon.get(`/api/invitations/preview/${DEMO_INVITE_TOKEN}`);
    assert.strictEqual(prev.body.inviter, 'Apex Insurance & Financial Services Ltd.');
    const acc = await anon.post('/api/invitations/accept', { token: DEMO_INVITE_TOKEN, name: 'Bright Path', password: 'a-strong-password', orgName: 'BrightPath Logistics Ltd', country: 'NG' }, { csrf: false });
    assert.strictEqual(acc.status, 200); assert.strictEqual(acc.body.relationship, 'pending_kyb');
    assert.strictEqual((await anon.get('/api/channels')).body.every(ch => ch.orgName === 'BrightPath Logistics Ltd'), true, 'no access to Apex channels yet');
    assert.strictEqual((await h.client().post('/api/invitations/accept', { token: DEMO_INVITE_TOKEN, name: 'x', password: 'a-strong-password' }, { csrf: false })).status, 410);
    // QR for the approved invoice
    const v = h.client(); await v.login('seyi.adeyemi@securetech.example');
    const inv = (await v.get('/api/invoices')).body.find(i => i.billId === h.w.bills.approved);
    const qr = await v.get(`/api/invoices/${inv.id}/qr`);
    assert.match(qr.body.svg, /^<\?xml|<svg/); assert.match(qr.body.url, /#\/pay\?t=/);
    assert.ok(!qr.body.url.includes('2034567890'));
    // employee resolves it, pays through the API with an idempotency key
    const e = h.client(); await e.login('chidi.nwosu@apex.example');
    const res = await e.post('/api/qr/resolve', { token: qr.body.token });
    assert.strictEqual(res.body.eligible, true);
    const k = 'idem-http-0001';
    const i1 = await e.post('/api/payments/intents', { billId: res.body.billId, walletId: res.body.wallets.find(x => x.name.startsWith('OPEX Main')).id, idempotencyKey: k, scanId: res.body.scanId });
    const i2 = await e.post('/api/payments/intents', { billId: res.body.billId, walletId: res.body.wallets.find(x => x.name.startsWith('OPEX Main')).id, idempotencyKey: k });
    assert.strictEqual(i1.status, 200); assert.strictEqual(i2.body.id, i1.body.id);
    const f = h.client(); await f.login('kunle.raji@apex.example');
    assert.strictEqual((await f.post(`/api/payments/intents/${i1.body.id}/execute`, { password: 'nope' })).status, 401);
    const paid = await f.post(`/api/payments/intents/${i1.body.id}/execute`, { password: h.w.PASSWORD });
    assert.strictEqual(paid.body.status, 'succeeded');
    const again = await f.post(`/api/payments/intents/${i1.body.id}/execute`, { password: h.w.PASSWORD });
    assert.strictEqual(again.body.idempotentReplay, true);
    const rcpt = await f.get(`/api/payments/intents/${i1.body.id}/receipt`);
    assert.strictEqual(rcpt.body.simulated, true); assert.strictEqual(rcpt.body.reconciliation.status, 'matched');
    // forged webhook is rejected, never applied
    const wh = await fetch(`${h.base}/api/webhooks/sandbox-provider`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-provider-signature': 'bad' }, body: JSON.stringify({ event_id: 'e1', intent_id: i1.body.id, type: 'payment.failed' }) });
    assert.strictEqual(wh.status, 401);
  } finally { h.close(); }
});

test('HTTP: file uploads are type-checked, private, and tenant scoped; CSV and policy imports are role gated', async () => {
  const h = await boot();
  try {
    const c = h.client(); await c.login('chidi.nwosu@apex.example');
    const fd = new FormData(); fd.append('intake', 'unstructured'); fd.append('file', new Blob(['MZ\0\0 not text'], { type: 'text/plain' }), 'x.txt');
    assert.strictEqual((await c.call('POST', '/api/docs/upload', fd)).status, 415);
    const ok = new FormData(); ok.append('intake', 'unstructured'); ok.append('file', new Blob(['Please settle the supplier invoice from SecureTech Nigeria Ltd for the cybersecurity monitoring service. Total NGN 400,000.\n'], { type: 'text/plain' }), 'note.txt');
    const up = await c.call('POST', '/api/docs/upload', ok);
    assert.strictEqual(up.status, 201); assert.match(up.body.sha256, /^[0-9a-f]{64}$/);
    await h.w.core.idle();
    const file = await c.call('GET', `/api/docs/records/${up.body.id}/file`, null, { raw: true });
    assert.strictEqual(file.status, 200); assert.match(file.headers.get('content-security-policy'), /sandbox/);
    const other = h.client(); await other.login('emeka.obi@greenfield.example');
    assert.strictEqual((await other.get(`/api/docs/records/${up.body.id}`)).status, 404);
    const csv = new FormData(); csv.append('file', new Blob(['a,b\n1,2\n'], { type: 'text/csv' }), 'e.csv');
    assert.strictEqual((await c.call('POST', '/api/events/import', csv)).status, 403);
    const admin = h.client(); await admin.login('adaeze.okonkwo@apex.example');
    const csv2 = new FormData(); csv2.append('file', new Blob(['a,b\n1,2\n'], { type: 'text/csv' }), 'e.csv');
    const bad = await admin.call('POST', '/api/events/import', csv2);
    assert.strictEqual(bad.status, 422); assert.strictEqual(bad.body.code, 'bad_headers');
  } finally { h.close(); }
});
