const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createApp } = require('../server');
const { createChatService } = require('../src/chat/service');
const { loadMasterData } = require('../src/masterData');
const { loadRates } = require('../src/fepe/fx');

const sample = f => fs.readFileSync(path.join(__dirname, '..', 'samples', 'invoices', f));
const NOW = new Date('2026-10-11T10:00:00Z');

// buyer Northwind (admin Ada, approvers Kemi + Tolu), vendors SecureTech and Okafor
function world(opts = {}) {
  const svc = createChatService({ master: loadMasterData(), rates: loadRates({}), now: () => NOW, ...opts });
  const pw = 'correct-horse-9';
  const login = e => svc.authenticate(svc.login({ email: e, password: pw }).token);
  const ada = svc.register({ email: 'ada@n.test', name: 'Ada', password: pw, orgName: 'Northwind' }).user;
  const code = svc.orgInfo(svc.authenticate(svc.login({ email: 'ada@n.test', password: pw }).token)).joinCode;
  svc.register({ email: 'kemi@n.test', name: 'Kemi', password: pw, orgJoinCode: code });
  svc.register({ email: 'tolu@n.test', name: 'Tolu', password: pw, orgJoinCode: code });
  svc.register({ email: 'tunde@s.test', name: 'Tunde', password: pw, orgName: 'SecureTech Nigeria Ltd' });
  svc.register({ email: 'chidi@o.test', name: 'Chidi', password: pw, orgName: 'Okafor & Partners' });
  const A = login('ada@n.test');
  svc.setRole(A, login('kemi@n.test').id, 'approver'); svc.setRole(A, login('tolu@n.test').id, 'approver');
  const ws = svc.createWorkspace(A, { name: 'Northwind Finance' });
  const w = Object.values(svc.state.workspaces)[0];
  const U = { ada: A, kemi: login('kemi@n.test'), tolu: login('tolu@n.test'), tunde: login('tunde@s.test'), chidi: login('chidi@o.test') };
  svc.joinWorkspace(U.tunde, { code: w.inviteCode }); svc.joinWorkspace(U.chidi, { code: w.inviteCode });
  const view = svc.getWorkspace(A, ws.id);
  const tpl = n => svc.listTemplates(A, ws.id).find(t => t.name === n).id;
  return { svc, U, ws: ws.id, view, tpl, chan: n => view.channels.find(c => c.name.includes(n)).id, ada };
}
const upload = (name, buffer) => ({ name, mime: 'text/plain', buffer });

test('vendors join the owner workspace and only see their own payment channel', () => {
  const { svc, U, ws } = world();
  const names = u => svc.getWorkspace(u, ws).channels.map(c => c.name);
  assert.deepEqual(names(U.ada).sort(), ['general', 'pay-okafor-partners', 'pay-securetech-nigeria-ltd']);
  assert.deepEqual(names(U.tunde), ['pay-securetech-nigeria-ltd']);
  const okafor = svc.getWorkspace(U.ada, ws).channels.find(c => c.name.includes('okafor')).id;
  assert.throws(() => svc.listMessages(U.tunde, okafor), /not found/);
  assert.throws(() => svc.postMessage(U.tunde, okafor, { text: 'hi' }), /not found/);
  assert.equal(svc.getWorkspace(U.tunde, ws).inviteCode, undefined);
});

test('only the end user can request documents, and only from the vendor in the channel', () => {
  const { svc, U, chan, tpl } = world();
  const c = chan('securetech');
  assert.throws(() => svc.createRequest(U.tunde, c, { templateId: tpl('Vendor Invoice'), title: 'x' }), /Only the end user/);
  const r = svc.createRequest(U.ada, c, { templateId: tpl('Vendor Invoice'), title: 'Sept invoice' });
  assert.equal(r.vendor.name, 'SecureTech Nigeria Ltd');
  assert.equal(r.status, 'open');
});

test('a vendor cannot answer another vendor\'s request, nor submit unsolicited documents', async () => {
  const { svc, U, chan, tpl } = world();
  const r = svc.createRequest(U.ada, chan('securetech'), { templateId: tpl('Vendor Invoice'), title: 'Sept' });
  await assert.rejects(svc.submit(U.chidi, r.id, { file: upload('a.txt', sample('securetech_invoice_0042.txt')) }), /not found|Only the vendor/);
  await assert.rejects(svc.submit(U.ada, r.id, { file: upload('a.txt', sample('securetech_invoice_0042.txt')) }), /Only the vendor/);
});

test('request -> submit -> accept -> pay posts balanced entries and a verifiable audit trail', async () => {
  const { svc, U, ws, chan, tpl } = world();
  const r = svc.createRequest(U.ada, chan('securetech'), { templateId: tpl('Vendor Invoice'), title: 'Sept' });
  const sub = await svc.submit(U.tunde, r.id, { file: upload('inv.txt', sample('securetech_invoice_0042.txt')) });
  assert.equal(sub.status, 'ready');
  // vendors cannot review or pay
  assert.throws(() => svc.accept(U.tunde, sub.id), /Only the end user/);
  // requester (Ada) cannot accept her own request under segregation of duties
  assert.throws(() => svc.accept(U.ada, sub.id), /Segregation of duties/);
  assert.equal(svc.accept(U.kemi, sub.id).status, 'posted');
  assert.throws(() => svc.pay(U.kemi, sub.id), /Segregation of duties/);
  const payment = svc.pay(U.tolu, sub.id, {});
  assert.equal(payment.status, 'settled');
  assert.equal(payment.rail, 'simulated');
  assert.throws(() => svc.pay(U.tolu, sub.id), /already been paid/);

  const tb = svc.trialBalance(U.ada, ws);
  assert.equal(tb.balanced, true);
  assert.equal(tb.entryCount, 2);
  const row = code => tb.rows.find(x => x.code === code);
  assert.equal(row(2110).balance, 0);            // payable settled
  assert.ok(row(1100).balance < 0);              // cash went out
  assert.ok(row(2320).balance < 0);              // WHT liability remains
  assert.throws(() => svc.trialBalance(U.tunde, ws), /ledger belongs/);

  const entries = svc.listEntries(U.ada, ws);
  const v = svc.voucher(U.ada, ws, entries.find(e => e.type === 'accrual').id);
  assert.equal(v.entryIntact, true);
  assert.equal(v.sourceFile.name, 'inv.txt');
  assert.ok(v.transcript.length >= 3);
  assert.equal(svc.auditVerify(U.ada, ws).ok, true);
});

test('tampering with a posted entry or the audit log is detected', async () => {
  const { svc, U, ws, chan, tpl } = world();
  const r = svc.createRequest(U.ada, chan('securetech'), { templateId: tpl('Vendor Invoice'), title: 'Sept' });
  const sub = await svc.submit(U.tunde, r.id, { file: upload('inv.txt', sample('securetech_invoice_0042.txt')) });
  svc.accept(U.kemi, sub.id);
  const entry = Object.values(svc.state.entries)[0];
  assert.throws(() => { 'use strict'; entry.lines[0].debit = 1; }, TypeError); // frozen
  const clone = JSON.parse(JSON.stringify(entry)); clone.lines[0].debit = 1;
  svc.state.entries[entry.id] = clone;
  const v = svc.auditVerify(U.ada, ws);
  assert.equal(v.ok, false);
  assert.deepEqual(v.tamperedEntries, [entry.number]);
  svc.state.entries[entry.id] = entry;
  svc.state.audit[Object.keys(svc.state.audit)[0]][2].actor = 'someone-else';
  assert.equal(svc.auditVerify(U.ada, ws).ok, false);
});

test('flagged documents need an override reason; duplicates and bad arithmetic are caught', async () => {
  const { svc, U, chan, tpl } = world();
  const c = chan('securetech');
  const r1 = svc.createRequest(U.ada, c, { templateId: tpl('Vendor Invoice'), title: 'A' });
  const ok = await svc.submit(U.tunde, r1.id, { file: upload('inv.txt', sample('securetech_invoice_0042.txt')) });
  svc.accept(U.kemi, ok.id);
  const r2 = svc.createRequest(U.ada, c, { templateId: tpl('Vendor Invoice'), title: 'B' });
  const dup = await svc.submit(U.tunde, r2.id, { file: upload('again.txt', sample('securetech_invoice_0042.txt')) });
  assert.equal(dup.status, 'flagged');
  assert.ok(dup.flags.some(f => f.code === 'duplicate_invoice'));
  assert.throws(() => svc.accept(U.kemi, dup.id), /reason/);
  svc.reject(U.kemi, dup.id, { reason: 'Already paid under INV-2026-0042' });
  const r2view = svc.openRequests(U.tunde, Object.values(svc.state.workspaces)[0].id).find(x => x.id === r2.id);
  assert.equal(r2view.status, 'open'); // vendor can resubmit
  const bad = await svc.submit(U.tunde, r2.id, { file: upload('bad.txt', sample('securetech_invoice_wrong_total.txt')) });
  assert.ok(bad.flags.some(f => f.code === 'total_mismatch'));
  const forced = svc.accept(U.kemi, bad.id, { overrideReason: 'Vendor confirmed by phone the lines are right' });
  assert.equal(forced.status, 'posted');
  assert.match(forced.overrideReason, /confirmed/);
});

test('template form submissions, custom templates and reclassification limits', async () => {
  const { svc, U, ws, chan, tpl } = world();
  const custom = svc.createTemplate(U.ada, ws, { name: 'Vendor Invoice + Project', baseTemplateId: tpl('Vendor Invoice'), extraFields: [{ label: 'Project code', required: true }] });
  assert.ok(custom.fields.some(f => f.key === 'project_code' && f.required));
  assert.throws(() => svc.createTemplate(U.tunde, ws, { name: 'x', baseTemplateId: tpl('Vendor Invoice') }), /Only the workspace owner/);
  const r = svc.createRequest(U.ada, chan('okafor'), { templateId: tpl('Vendor Invoice'), title: 'Advisory' });
  const sub = await svc.submit(U.chidi, r.id, { form: { fields: { number: 'F-1', date: '2026-10-05', currency: 'USD', vatRate: 7.5 }, lines: [{ description: 'Legal advisory', quantity: 2, unitPrice: 500 }] } });
  assert.equal(sub.status, 'ready');
  assert.equal(sub.extracted.total, 1075);
  assert.throws(() => svc.accept(U.kemi, sub.id, { lineAccounts: { 0: 1100 } }), /may not be posted/);
  const done = svc.accept(U.kemi, sub.id, { lineAccounts: { 0: 6900 } });
  assert.equal(done.journal.find(l => l.code === 6900).debit, 1000);
});

test('supporting documents are accepted without a ledger entry; auto-post respects flags', async () => {
  const { svc, U, ws, chan, tpl } = world();
  const r = svc.createRequest(U.ada, chan('securetech'), { templateId: tpl('Tax Exemption / Compliance Certificate'), title: 'TCC' });
  const sub = await svc.submit(U.tunde, r.id, { file: upload('tcc.txt', sample('tax_clearance_certificate.txt')) });
  assert.equal(sub.status, 'ready');
  assert.equal(svc.accept(U.kemi, sub.id).status, 'accepted');
  assert.equal(svc.trialBalance(U.ada, ws).entryCount, 0);

  svc.updateSettings(U.ada, ws, { autoPost: true });
  const r2 = svc.createRequest(U.ada, chan('securetech'), { templateId: tpl('Vendor Invoice'), title: 'Auto' });
  const clean = await svc.submit(U.tunde, r2.id, { file: upload('inv.txt', sample('securetech_invoice_0042.txt')) });
  assert.equal(clean.status, 'posted');
  assert.equal(clean.autoPosted, true);
  const r3 = svc.createRequest(U.ada, chan('securetech'), { templateId: tpl('Vendor Invoice'), title: 'Auto2' });
  const flagged = await svc.submit(U.tunde, r3.id, { file: upload('bad.txt', sample('securetech_invoice_wrong_total.txt')) });
  assert.equal(flagged.status, 'flagged');
});

test('request threads are private to the owner and the addressed vendor in a shared channel', async () => {
  const { svc, U, ws, tpl } = world();
  const shared = svc.createChannel(U.ada, ws, { name: 'all-vendors', vendorOrgIds: Object.values(svc.state.workspaces)[0].vendorOrgIds });
  const r = svc.createRequest(U.ada, shared.id, { templateId: tpl('Vendor Invoice'), title: 'T', vendorOrgId: Object.values(svc.state.workspaces)[0].vendorOrgIds[0] });
  assert.equal(svc.listMessages(U.chidi, shared.id).some(m => m.kind === 'request'), false);
  assert.equal(svc.listMessages(U.tunde, shared.id).some(m => m.kind === 'request'), true);
  assert.throws(() => svc.listThread(U.chidi, r.messageId), /not found/);
});

test('HTTP: auth, multipart upload, cookies and error shapes', async () => {
  const { app, svc } = await createApp({ docflow: false, dataDir: null, now: () => NOW });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, { token, body, form } = {}) => {
    const res = await fetch(base + url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: form || (body ? JSON.stringify(body) : undefined) });
    return { status: res.status, json: await res.json().catch(() => null), res };
  };
  try {
    assert.equal((await call('GET', '/api/me')).status, 401);
    const reg = await call('POST', '/api/auth/register', { body: { email: 'a@b.test', name: 'A', password: 'password1', orgName: 'BuyerCo' } });
    assert.equal(reg.status, 201);
    assert.match(reg.res.headers.get('set-cookie'), /HttpOnly/);
    assert.equal((await call('POST', '/api/auth/register', { body: { email: 'a@b.test', name: 'A', password: 'password1', orgName: 'Other' } })).status, 409);
    assert.equal((await call('POST', '/api/auth/login', { body: { email: 'a@b.test', password: 'nope-nope' } })).status, 401);
    const t1 = reg.json.token;
    const ws = (await call('POST', '/api/workspaces', { token: t1, body: { name: 'W' } })).json;
    const v = await call('POST', '/api/auth/register', { body: { email: 'v@c.test', name: 'V', password: 'password1', orgName: 'VendorCo' } });
    const t2 = v.json.token;
    const wsRec = Object.values(svc.state.workspaces)[0];
    assert.equal((await call('POST', '/api/workspaces/join', { token: t2, body: { code: 'WRONG' } })).status, 404);
    assert.equal((await call('POST', '/api/workspaces/join', { token: t2, body: { code: wsRec.inviteCode } })).status, 201);
    const ch = (await call('GET', `/api/workspaces/${ws.id}`, { token: t1 })).json.channels.find(c => c.kind === 'shared');
    const tpl = (await call('GET', `/api/workspaces/${ws.id}/templates`, { token: t1 })).json.find(t => t.name === 'Vendor Invoice');
    assert.equal((await call('POST', `/api/channels/${ch.id}/requests`, { token: t2, body: { templateId: tpl.id, title: 'x' } })).status, 403);
    const req = await call('POST', `/api/channels/${ch.id}/requests`, { token: t1, body: { templateId: tpl.id, title: 'Invoice please' } });
    assert.equal(req.status, 201);
    const fd = new FormData();
    fd.append('file', new Blob([sample('securetech_invoice_0042.txt')]), 'inv.txt');
    const sub = await call('POST', `/api/requests/${req.json.id}/submissions`, { token: t2, form: fd });
    assert.equal(sub.status, 201);
    assert.equal(sub.json.extracted.number, 'INV-2026-0042');
    const bad = new FormData(); bad.append('file', new Blob(['x']), 'macro.exe');
    const r2 = await call('POST', `/api/requests/${req.json.id}/submissions`, { token: t2, form: bad });
    assert.equal(r2.status, 409); // first submission still under review
    const dl = await fetch(`${base}/api/files/${sub.json.fileId}`, { headers: { Authorization: `Bearer ${t2}` } });
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-disposition'), /attachment/);
    assert.equal((await fetch(`${base}/api/files/${sub.json.fileId}`)).status, 401);
  } finally { server.close(); }
});

test('state and files survive a restart when a data directory is configured', async () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'aeto-'));
  try {
    const a = world({ dataDir: dir });
    const r = a.svc.createRequest(a.U.ada, a.chan('securetech'), { templateId: a.tpl('Vendor Invoice'), title: 'Persist' });
    const sub = await a.svc.submit(a.U.tunde, r.id, { file: upload('inv.txt', sample('securetech_invoice_0042.txt')) });
    a.svc.flush();
    const b = createChatService({ dataDir: dir, master: loadMasterData(), rates: loadRates({}), now: () => NOW });
    const ada = b.authenticate(b.login({ email: 'ada@n.test', password: 'correct-horse-9' }).token);
    assert.equal(b.payables(ada, a.ws)[0].id, sub.id);
    assert.equal(b.readFile(ada, sub.fileId).buffer.toString().includes('INV-2026-0042'), true);
    assert.equal(b.auditVerify(ada, a.ws).ok, true);
    b.flush(); a.svc.flush();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('custom template fields are required and read from forms, text and structured files', async () => {
  const { svc, U, ws, chan, tpl } = world();
  const custom = svc.createTemplate(U.ada, ws, { name: 'Invoice + Project', baseTemplateId: tpl('Vendor Invoice'), extraFields: [{ label: 'Project code', required: true }] });
  const ask = () => svc.createRequest(U.ada, chan('securetech'), { templateId: custom.id, title: 'P' });
  const noProject = await svc.submit(U.tunde, ask().id, { file: upload('i.txt', sample('securetech_invoice_0042.txt')) });
  assert.ok(noProject.flags.some(f => f.code === 'missing_field' && /Project code/.test(f.message)));
  svc.reject(U.kemi, noProject.id, { reason: 'Add project code' });
  const text = sample('securetech_invoice_0042.txt').toString().replace('Currency: NGN', 'Currency: NGN\nProject code: PRJ-77\n');
  const ok = await svc.submit(U.tunde, Object.values(svc.state.requests).find(r => r.status === 'open' && r.templateId === custom.id).id, { file: upload('i2.txt', Buffer.from(text)) });
  assert.equal(ok.extracted.custom.project_code, 'PRJ-77');
  assert.equal(ok.flags.some(f => f.code === 'missing_field'), false);
});
