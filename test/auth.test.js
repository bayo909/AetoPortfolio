const test = require('node:test');
const assert = require('node:assert');
const { generatePassword, hashPassword, verifyPassword, createThrottle } = require('../src/auth');
const { mkService, ingest, fail } = require('./helpers');
const { createApp } = require('../server');

const INVOICE = 'INVOICE INV-7788\nFrom: Okafor & Partners\nDate: 09/03/2026\nService: Legal advisory fee\nAmount: NGN 90,000\nTotal: NGN 90,000';
const cred = (creds, u) => creds.find(c => c.username === u);

test('passwords are random, hashed with scrypt and verified in constant time', () => {
  const a = generatePassword(), b = generatePassword();
  assert.notStrictEqual(a, b);
  assert.match(a, /^[a-km-zA-HJ-NP-Z2-9]{14}$/);              // no look-alike characters
  const h = hashPassword(a);
  assert.ok(h.startsWith('scrypt$') && !h.includes(a));
  assert.ok(verifyPassword(a, h));
  assert.ok(!verifyPassword(b, h));
  assert.ok(!verifyPassword(a, 'garbage'));
});

test('throttle locks after 5 failures and clears on success', () => {
  let t = 0; const th = createThrottle({ now: () => t });
  for (let i = 0; i < 5; i++) th.fail('k');
  assert.ok(th.blocked('k'));
  t += 11 * 60 * 1000;
  assert.ok(!th.blocked('k'));
});

test('generateLogins issues buyer logins and one login per vendor; passwords work, wrong ones do not', async () => {
  const svc = await mkService();
  const creds = svc.generateLogins();
  assert.strictEqual(creds.filter(c => c.role === 'vendor').length, 7);
  assert.ok(creds.filter(c => c.role === 'buyer').length >= 12);
  assert.strictEqual(new Set(creds.map(c => c.password)).size, creds.length);
  const s = svc.login('cfo', cred(creds, 'cfo').password);
  assert.strictEqual(s.user.name, 'Chidi Okeke');
  assert.ok(!('passwordHash' in s.user));
  assert.strictEqual(svc.userForToken(s.token).username, 'cfo');
  assert.strictEqual(svc.login('cfo', 'wrong'), null);
  assert.strictEqual(svc.login('nobody', 'x'), null);
  svc.logout(s.token);
  assert.strictEqual(svc.userForToken(s.token), null);
});

test('regenerating replaces every login and ends sessions; --missing only adds absent ones', async () => {
  const svc = await mkService();
  const first = svc.generateLogins();
  const s = svc.login('cfo', cred(first, 'cfo').password);
  svc.createParty({ kind: 'vendor', name: 'Brand New Vendor Ltd' });
  const added = svc.generateLogins({ reset: false });
  assert.deepStrictEqual(added.map(c => c.username), ['brand.new.vendor']);
  assert.ok(svc.userForToken(s.token));                         // existing logins untouched
  const second = svc.generateLogins();
  assert.strictEqual(svc.userForToken(s.token), null);
  assert.strictEqual(svc.login('cfo', cred(first, 'cfo').password), null);   // old password dead
  assert.ok(svc.login('cfo', cred(second, 'cfo').password));
});

test('admin can create or reset a vendor login; others cannot', async () => {
  const svc = await mkService();
  const creds = svc.generateLogins();
  const admin = svc.login('admin', cred(creds, 'admin').password).user;
  const cfo = svc.login('cfo', cred(creds, 'cfo').password).user;
  fail(assert, () => svc.resetPartyLogin('VEN-001', cfo), 403);
  const r = svc.resetPartyLogin('VEN-001', admin);
  assert.strictEqual(r.username, 'securetech');
  assert.strictEqual(svc.login('securetech', cred(creds, 'securetech').password), null);
  assert.ok(svc.login('securetech', r.password));
  fail(assert, () => svc.resetPartyLogin('EMP-001', admin), 404);
});

test('roles gate each step: preparer submits, tier approvers approve, reviewer reviews, processor pays', async () => {
  const svc = await mkService();
  const creds = svc.generateLogins();
  const u = name => svc.login(name, cred(creds, name).password).user;
  const rec = await ingest(svc, INVOICE, { intake: 'structured', docType: 'invoice_payable' });
  const id = rec.documents[0].id;
  svc.update(id, { header: { costCenter: 'CC-LEG-50', department: 'Legal' } }, u('ada.preparer'));
  fail(assert, () => svc.submit(id, u('dept.manager')), 403);                     // not a Preparer
  svc.submit(id, u('ada.preparer'));
  assert.strictEqual(svc.getDocument(id).header.preparedBy, 'Ada Preparer');      // name comes from the login, not typed
  fail(assert, () => svc.approve(id, 'Department Manager', u('cfo')), 403);       // wrong role
  fail(assert, () => svc.approve(id, 'Department Manager', u('ada.preparer')), 403);
  svc.approve(id, 'Department Manager', u('dept.manager'));
  fail(assert, () => svc.financeReview(id, { by: u('payment.processor') }), 403); // wrong role
  const d = svc.financeReview(id, { by: u('finance.reviewer'), ackLowConfidence: true, accountOverrides: {} });
  assert.strictEqual(d.status, 'billed');
  fail(assert, () => svc.payBill(d.billId, u('finance.reviewer')), 403);          // not a Payment Processor
  assert.strictEqual(svc.payBill(d.billId, u('payment.processor')).paymentStatus, 'paid');
  assert.strictEqual(svc.getBill(d.billId).payment.by, 'Pat Processor');
});

test('vendors see only their own records, documents and bills, in a reduced view, and cannot act', async () => {
  const svc = await mkService();
  const creds = svc.generateLogins();
  const u = name => svc.login(name, cred(creds, name).password).user;
  const okafor = u('okafor.and.partners'), dell = u('dell');
  const buyer = u('ada.preparer');

  const rec = await (async () => {
    const r = svc.createRecord({ buffer: Buffer.from(INVOICE.replace('Okafor & Partners', 'Some Other Text')), filename: 'inv.txt', intake: 'unstructured', docType: 'auto', actor: okafor });
    await svc.processRecord(r.id); return svc.getRecord(r.id, okafor);
  })();
  assert.strictEqual(rec.intake, 'structured');                       // vendors cannot choose unstructured
  assert.strictEqual(rec.docType, 'invoice_payable');
  const docId = rec.documents[0].id;
  const asBuyer = svc.getDocument(docId, buyer);
  assert.strictEqual(asBuyer.header.partyId, 'VEN-002');              // forced to the vendor's own master record, whatever the text says
  assert.strictEqual(asBuyer.header.counterparty, 'Okafor & Partners');

  const v = svc.getDocument(docId, okafor);
  assert.ok(v.vendorView && !v.issues && !v.approvals && !v.journal && !v.review);
  assert.strictEqual(v.totals.gross, 90000);

  assert.strictEqual(svc.listRecords(dell).length, 0);
  assert.strictEqual(svc.listDocuments(dell).length, 0);
  fail(assert, () => svc.getRecord(rec.id, dell), 404);
  fail(assert, () => svc.getDocument(docId, dell), 404);
  fail(assert, () => svc.recordFile(rec.id, dell), 404);
  assert.strictEqual(svc.listRecords(okafor).length, 1);
  assert.strictEqual(svc.listRecords(buyer).length, 1);

  fail(assert, () => svc.update(docId, { header: { purpose: 'x' } }, okafor), 403);
  fail(assert, () => svc.submit(docId, okafor), 403);
  fail(assert, () => svc.approve(docId, 'Department Manager', okafor), 403);
  fail(assert, () => svc.createParty({ kind: 'vendor', name: 'X' }, okafor), 403);

  // bill + payment status become visible to the vendor, but not the journal or the control trail
  svc.update(docId, { header: { department: 'Legal', costCenter: 'CC-LEG-50' } }, buyer);
  svc.submit(docId, u('ada.preparer'));
  svc.approve(docId, 'Department Manager', u('dept.manager'));
  const done = svc.financeReview(docId, { by: u('finance.reviewer'), ackLowConfidence: true });
  const bill = svc.getBill(done.billId, okafor);
  assert.ok(bill.vendorView && !bill.entries && !bill.workflow);
  assert.strictEqual(bill.paymentStatus, 'awaiting_payment');
  assert.strictEqual(svc.listBills(dell).length, 0);
  fail(assert, () => svc.getBill(done.billId, dell), 404);
  fail(assert, () => svc.payBill(done.billId, okafor), 403);
});

/* ---------------------------- over HTTP ---------------------------- */
async function boot() {
  const ctx = await createApp({ storageDir: null, autoLogins: false });
  const creds = ctx.svc.generateLogins();
  const server = await new Promise(r => { const s = ctx.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (username, password = cred(creds, username).password) => {
    const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    return { res, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
  const call = (cookie, path, init = {}) => fetch(base + path, { ...init, headers: { cookie, ...(init.headers || {}) } });
  return { ...ctx, base, creds, login, call, close: () => new Promise(r => server.close(r)) };
}

test('HTTP: API requires a session; cookie is HttpOnly; logout ends the session', async () => {
  const t = await boot();
  try {
    assert.strictEqual((await fetch(`${t.base}/api/records`)).status, 401);
    assert.strictEqual((await fetch(`${t.base}/api/documents`)).status, 401);
    assert.strictEqual((await fetch(`${t.base}/api/config`)).status, 200);           // login page needs it
    const bad = await t.login('cfo', 'wrong-password');
    assert.strictEqual(bad.res.status, 401);
    const { res, cookie } = await t.login('cfo');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('set-cookie'), /HttpOnly/);
    assert.match(res.headers.get('set-cookie'), /SameSite=Lax/);
    const me = await (await t.call(cookie, '/api/auth/me')).json();
    assert.strictEqual(me.user.username, 'cfo');
    assert.strictEqual((await t.call(cookie, '/api/records')).status, 200);
    await t.call(cookie, '/api/auth/logout', { method: 'POST' });
    assert.strictEqual((await t.call(cookie, '/api/records')).status, 401);
  } finally { await t.close(); }
});

test('HTTP: repeated wrong passwords are throttled', async () => {
  const t = await boot();
  try {
    for (let i = 0; i < 5; i++) assert.strictEqual((await t.login('dell', 'nope')).res.status, 401);
    assert.strictEqual((await t.login('dell', 'nope')).res.status, 429);
    assert.strictEqual((await t.login('dell')).res.status, 429);     // even the right password waits out the lock
    assert.strictEqual((await t.login('cfo')).res.status, 200);      // other accounts are unaffected
  } finally { await t.close(); }
});

test('HTTP: a vendor uploads an invoice, sees only their own data and is kept out of buyer routes', async () => {
  const t = await boot();
  try {
    const v = await t.login('okafor.and.partners'), other = await t.login('dell'), buyer = await t.login('ada.preparer');
    const fd = new FormData();
    fd.append('intake', 'unstructured'); fd.append('file', new Blob([INVOICE]), 'invoice.txt');
    const up = await t.call(v.cookie, '/api/records', { method: 'POST', body: fd });
    assert.strictEqual(up.status, 201);
    const rec = await up.json();
    assert.strictEqual(rec.intake, 'structured');
    await t.idle();
    assert.strictEqual((await (await t.call(v.cookie, `/api/records/${rec.id}`)).json()).status, 'processed');
    assert.strictEqual((await t.call(other.cookie, `/api/records/${rec.id}`)).status, 404);
    assert.deepStrictEqual(await (await t.call(other.cookie, '/api/records')).json(), []);
    assert.strictEqual((await (await t.call(buyer.cookie, '/api/documents')).json()).length, 1);
    for (const [method, path] of [['GET', '/api/parties'], ['GET', '/api/users'], ['PATCH', '/api/documents/x'], ['POST', '/api/documents/x/approve'], ['POST', '/api/bills/x/pay']])
      assert.strictEqual((await t.call(v.cookie, path, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' })).status, 403, `${method} ${path}`);
  } finally { await t.shutdown(); await t.close(); }
});
