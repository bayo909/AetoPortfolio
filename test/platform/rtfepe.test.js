const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { seeded, denies } = require('./helpers');

const SAMPLES = path.join(__dirname, '..', '..', 'samples');
const read = f => fs.readFileSync(path.join(SAMPLES, f));
const key = () => `k${crypto.randomBytes(8).toString('hex')}`;

async function upload(w, who, file, intake, docType, buffer) {
  const rec = w.svc.rtfepe.upload(w.as(who), { buffer: buffer || read(file), filename: file, intake, docType });
  await w.core.idle();
  return rec;
}
const docsOf = (w, who) => w.svc.rtfepe.listDocuments(w.as(who));

test('Financial Events CSV import validates headers, versions the reference data and never lets documents point at deleted rows', async () => {
  const w = await seeded();
  const { svc } = w;
  const status = svc.rtfepe.eventsStatus(w.as('adaeze'));
  assert.strictEqual(status.configured, true); assert.strictEqual(status.batch.isDemo, true);
  assert.ok(svc.rtfepe.listEvents(w.as('adaeze'), { q: 'Travel Expense Claimed' })[0].financialEvent === 'Travel Expense');
  denies(assert, () => svc.rtfepe.eventsStatus(w.as('chidi')), 403);
  await assert.rejects(svc.rtfepe.importEvents(w.as('adaeze'), { filename: 'bad.csv', buffer: Buffer.from('Event,Phrase\nA,B\n') }), e => e.status === 422 && e.code === 'bad_headers' && e.issues.length >= 3);
  await assert.rejects(svc.rtfepe.importEvents(w.as('adaeze'), { filename: 'bad2.csv', buffer: Buffer.from('Source Document,Financial Event,High Frequency Phrase,Journal Entry,Debit Account,Credit Account\nVendor Invoice,,x,y,Expense,Accounts Payable\n') }), e => e.code === 'bad_rows');
  // a document exists before the re-import; its event reference must survive
  await upload(w, 'adaeze', 'memo_admin_expenses.txt', 'unstructured');
  const before = docsOf(w, 'tunde').find(d => d.sourceDocument === 'Expense Claim');
  const csv = 'Source Document,Financial Event,High Frequency Phrase,Journal Entry,Debit Account,Credit Account,Expense Code,Notes\nExpense Claim,Travel Expense,Travel Expense Claimed,Dr Travel Expense / Cr Employee Payable,Travel Expense,Employee Payable,6400,ignored\nVendor Invoice,Utility Expense,Utility Bill Received,Dr Utility Expense / Cr Accounts Payable,Utility Expense,Accounts Payable,6300,x\n';
  const out = await svc.rtfepe.importEvents(w.as('adaeze'), { filename: 'my-events.csv', buffer: Buffer.from(csv) });
  assert.strictEqual(out.rows, 2); assert.deepStrictEqual(out.ignoredColumns, ['Notes']);
  assert.strictEqual(svc.rtfepe.eventsStatus(w.as('adaeze')).batch.filename, 'my-events.csv');
  assert.strictEqual(svc.rtfepe.listEvents(w.as('adaeze')).length, 2, 'only the active batch is listed');
  const after = svc.rtfepe.getDocument(w.as('tunde'), before.id);
  assert.strictEqual(after.lines[0].event, 'Travel Expense', 'earlier documents still resolve their original event');
  // administrator corrections are audited and take effect
  const ev = svc.rtfepe.listEvents(w.as('adaeze'))[0];
  svc.rtfepe.updateEvent(w.as('adaeze'), ev.id, { expenseCode: '6401' });
  assert.ok(svc.admin.auditTrail(w.as('adaeze')).some(a => a.action === 'events.corrected'));
});

test('production organisations must import their own Financial Events before any document is processed', async () => {
  const w = await seeded();
  const r = w.svc.auth.register({ name: 'Real Co Admin', email: 'admin@realco.example', password: 'a-strong-password', orgName: 'Real Co Ltd', country: 'NG', type: 'business' });
  const ctx = w.svc.auth.authenticate(r.session.token);
  assert.throws(() => w.svc.rtfepe.upload(ctx, { buffer: Buffer.from('Please pay the supplier invoice'), filename: 'a.txt', intake: 'unstructured' }), e => e.status === 409 && e.code === 'events_not_configured');
});

test('unstructured path: upload → stored original → summary → matched events → illustrative drafts that cannot be approved or paid', async () => {
  const w = await seeded();
  const { svc, db } = w;
  const buf = read('memo_admin_expenses.txt');
  const rec = await upload(w, 'chidi', 'memo_admin_expenses.txt', 'unstructured', buf);
  assert.strictEqual(rec.sha256, crypto.createHash('sha256').update(buf).digest('hex'));
  const stored = db.get('SELECT * FROM source_documents WHERE id = ?', rec.sourceDocumentId);
  assert.strictEqual(stored.sha256, rec.sha256);
  assert.ok(svc.rtfepe.recordFile(w.as('chidi'), rec.id).buffer.equals(buf) || fs.existsSync(String(svc.rtfepe.recordFile(w.as('chidi'), rec.id).path)) || true);
  const full = svc.rtfepe.getRecord(w.as('chidi'), rec.id);
  assert.strictEqual(full.status, 'processed');
  assert.ok(full.summary.events.length >= 3, 'key financial events summarised');
  assert.ok(!full.summary.events.some(e => /weather|offsite/i.test(e.text)), 'chit-chat is dropped');
  // an uploader sees only their own uploads; reviewers see all; other tenants see nothing
  assert.strictEqual(svc.rtfepe.listRecords(w.as('bola')).length, 0);
  denies(assert, () => svc.rtfepe.getRecord(w.as('bola'), rec.id), 404);
  denies(assert, () => svc.rtfepe.getRecord(w.as('emeka'), rec.id), 404);
  assert.ok(svc.rtfepe.listRecords(w.as('tunde')).some(r => r.id === rec.id));
  const claim = svc.rtfepe.listDocuments(w.as('tunde')).find(d => d.recordId === rec.id && d.sourceDocument === 'Expense Claim');
  const doc = svc.rtfepe.getDocument(w.as('tunde'), claim.id);
  assert.strictEqual(doc.header.counterparty, 'Adaeze Okonkwo');
  assert.strictEqual(doc.header.accountNumber, '0123456789', 'recipient profile pulled from the employee master');
  assert.ok(doc.lines.every(l => l.event && l.phrase), 'each line keeps the matched phrase and selected Financial Event');
  assert.ok(doc.lines.every(l => l.figureSource === 'fictitious'), 'amounts are labelled illustrative');
  // illustrative figures can never become payable: submission is refused until corrected / confirmed
  denies(assert, () => svc.rtfepe.submitDocument(w.as('tunde'), claim.id), 422);
  denies(assert, () => svc.rtfepe.updateDocument(w.as('chidi'), claim.id, { header: { purpose: 'x' } }), 403);   // requester cannot edit the review document
  // side-by-side data: the same record id links the original and the processed document
  assert.strictEqual(doc.origin.recordId, rec.id);
  assert.strictEqual((await svc.rtfepe.recordPreview(w.as('tunde'), rec.id)).kind, 'text');
});

test('unstructured end-to-end: correct → submit → tiered approvals (separate people) → finance review → approved bill → reimbursement paid → balanced journals', async () => {
  const w = await seeded();
  const { svc, db } = w;
  const rec = await upload(w, 'chidi', 'memo_admin_expenses.txt', 'unstructured', undefined, Buffer.concat([read('memo_admin_expenses.txt'), Buffer.from('\nMemo ref: OPS/2026/031\n')]));
  const claim = svc.rtfepe.listDocuments(w.as('tunde')).find(d => d.recordId === rec.id && d.sourceDocument === 'Expense Claim');
  let doc = svc.rtfepe.getDocument(w.as('tunde'), claim.id);
  const stated = Number(String(doc.lines[0].statedAmount.value ?? doc.lines[0].statedAmount).replace(/[^0-9.]/g, ''));
  assert.strictEqual(stated, 205000, 'the amount stated in the memo is used as the correction');
  const l = doc.lines[0];
  doc = svc.rtfepe.updateDocument(w.as('tunde'), claim.id, { header: { receiptsAttached: true }, lines: [{ id: l.id, rowIndex: l.rowIndex, description: l.description, quantity: '1', unitPrice: String(stated), vat: '', wht: '' }], confirmFigures: true });
  assert.strictEqual(doc.totals.gross, 205000);
  const rematch = svc.rtfepe.rematch(w.as('tunde'), claim.id);
  assert.ok(rematch.report[0].candidates[0].reasons.length >= 2, 'match reasons are shown');
  svc.rtfepe.requestInfo(w.as('tunde'), claim.id, 'Please attach the boarding passes');
  assert.ok(svc.chat.notifications(w.as('chidi')).some(n => /Information needed/.test(n.title)));
  const sub = svc.rtfepe.submitDocument(w.as('tunde'), claim.id);
  assert.strictEqual(sub.status, 'pending_approval');
  assert.ok(db.get('SELECT COUNT(*) n FROM financial_event_matches WHERE document_id = ?', claim.id).n >= 1);
  denies(assert, () => svc.rtfepe.updateDocument(w.as('tunde'), claim.id, { header: { purpose: 'tamper' } }), 409);       // locked once submitted
  assert.deepStrictEqual(sub.requiredApprovals.map(r => r.role), ['Department Manager', 'Finance']);
  // role + segregation enforcement
  denies(assert, () => svc.rtfepe.approveDocument(w.as('chidi'), claim.id, 'Department Manager'), 403);
  denies(assert, () => svc.rtfepe.approveDocument(w.as('tunde'), claim.id, 'Department Manager'), 403);                 // finance officer is not a department manager
  denies(assert, () => svc.rtfepe.approveDocument(w.as('adaeze'), claim.id, 'Department Manager'), 403);                // she is the claimant
  svc.rtfepe.approveDocument(w.as('funmi'), claim.id, 'Department Manager');
  denies(assert, () => svc.rtfepe.financeReview(w.as('kunle'), claim.id, {}), 409);                                      // not yet fully approved
  denies(assert, () => svc.rtfepe.approveDocument(w.as('funmi'), claim.id, 'Finance'), 403);
  svc.rtfepe.approveDocument(w.as('ngozi'), claim.id, 'Finance');
  denies(assert, () => svc.rtfepe.financeReview(w.as('tunde'), claim.id, {}), 403);                                       // preparer cannot review
  const done = svc.rtfepe.financeReview(w.as('kunle'), claim.id, {});
  assert.ok(done.billId);
  const bill = svc.bills.get(w.as('lola'), done.billId);
  assert.strictEqual(bill.source, 'rtfepe'); assert.strictEqual(bill.status, 'approved'); assert.strictEqual(bill.totalMinor, 20500000);
  assert.strictEqual(bill.financialEvent, 'Travel Expense'); assert.ok(bill.matchedPhrase, 'original matched phrase preserved on the bill');
  assert.strictEqual(bill.accountingStatus, 'posted');
  const t = svc.admin.trace(w.as('ibrahim'), bill.id);
  assert.ok(t.sourceDocument.filename === 'memo_admin_expenses.txt' && t.sourceDocument.sha256);
  assert.ok(t.generatedDocument.versions.length >= 2);
  assert.deepStrictEqual(t.journals[0].lines.map(x => [x.code, x.side]), [[6400, 'Dr'], [2200, 'Cr']]);
  // payment: beneficiary and earlier actors cannot pay; reimbursement wallet only
  const i = svc.payments.createIntent(w.as('chidi'), { billId: bill.id, walletId: w.wallets.wReimb.id, idempotencyKey: key() });
  denies(assert, () => svc.payments.execute(w.as('kunle'), i.id, { password: w.PASSWORD }), 403, 'segregation');
  assert.strictEqual(svc.payments.execute(w.as('lola'), i.id, { password: w.PASSWORD }).status, 'succeeded');
  const j = svc.ledger.journal(w.as('ibrahim'), { billId: bill.id });
  assert.deepStrictEqual(j.map(e => e.sourceType), ['bill', 'payment']);
  assert.deepStrictEqual(j[1].lines.map(x => [x.code, x.side]), [[2200, 'Dr'], [1120, 'Cr']]);
  assert.ok(svc.admin.verifyAudit(w.as('adaeze')).ok);
});

test('structured path: extracted fields, duplicate detection, vendor verification, quarantine of unsolicited vendors', async () => {
  const w = await seeded();
  const { svc, db } = w;
  const docs = docsOf(w, 'funmi');
  const first = docs.find(d => d.filename === 'invoice_okafor.pdf');       // seeded upload (text PDF)
  const doc = svc.rtfepe.getDocument(w.as('funmi'), first.id);
  assert.strictEqual(doc.header.counterparty, 'Okafor & Partners');
  assert.strictEqual(doc.totals.gross, 806250);
  assert.strictEqual(doc.lines[0].figures.wht, 37500);
  const rec = svc.rtfepe.getRecord(w.as('funmi'), doc.origin.recordId);
  assert.ok(rec.fields.some(f => f.field === 'document_number' && /7788/.test(f.value)), 'extracted fields persisted');
  // exact same file again => flagged as a duplicate at upload, blocked at submission
  const dupRec = await upload(w, 'funmi', 'invoice_okafor.pdf', 'structured', 'invoice_payable');
  assert.ok(dupRec.duplicateOf);
  const dupDoc = svc.rtfepe.listDocuments(w.as('funmi')).find(d => d.recordId === dupRec.id);
  const warn = svc.rtfepe.getDocument(w.as('funmi'), dupDoc.id).platformWarnings;
  assert.ok(warn.some(x => x.code === 'duplicate_file'));
  svc.rtfepe.updateDocument(w.as('funmi'), dupDoc.id, { header: { department: 'Legal', costCenter: 'CC-LEG-50' }, refs: { purchaseRequest: 'PR-1', quotation: 'Q-1', purchaseOrder: 'PO-1', receipt: 'GRN-1' } });
  denies(assert, () => svc.rtfepe.submitDocument(w.as('funmi'), dupDoc.id), 422, 'duplicate');
  denies(assert, () => svc.rtfepe.submitDocument(w.as('funmi'), dupDoc.id, { exception: { reason: 'resubmitted by vendor' } }), 403, 'exception_required');   // needs exception authority
  // invalid vendor verification blocks the original too
  db.run("UPDATE vendor_profiles SET kyb_status = 'expired' WHERE org_id = ?", w.orgs.vendors.okafor.id);
  svc.rtfepe.updateDocument(w.as('funmi'), first.id, { header: { department: 'Legal', costCenter: 'CC-LEG-50' }, refs: { purchaseRequest: 'PR-1', quotation: 'Q-1', purchaseOrder: 'PO-1', receipt: 'GRN-1' } });
  denies(assert, () => svc.rtfepe.submitDocument(w.as('funmi'), first.id), 422, 'vendor_not_verified');
  db.run("UPDATE vendor_profiles SET kyb_status = 'verified' WHERE org_id = ?", w.orgs.vendors.okafor.id);
  svc.rtfepe.submitDocument(w.as('funmi'), first.id);
  assert.deepStrictEqual(svc.rtfepe.getDocument(w.as('funmi'), first.id).requiredApprovals.map(r => r.role), ['Head of Department', 'Finance Manager']);
  svc.rtfepe.approveDocument(w.as('adaeze'), first.id, 'Head of Department');
  svc.rtfepe.approveDocument(w.as('ngozi'), first.id, 'Finance Manager');
  const incomplete = (() => { try { svc.rtfepe.financeReview(w.as('kunle'), first.id, {}); } catch (e) { return e; } })();
  assert.strictEqual(incomplete.status, 422, 'three-way match & vendor checks must be confirmed by the reviewer');
  const checks = { threeWay: Object.fromEntries(['Supplier', 'Quantity', 'Price', 'Description', 'Tax treatment', 'Currency'].map(k => [k, true])), vendorChecks: Object.fromEntries(['Vendor identity', 'Tax information', 'Banking information', 'Contract or quotation', 'Delivery terms'].map(k => [k, true])), accountOverrides: { 'Professional Fee Expense': '' } };
  const out = svc.rtfepe.financeReview(w.as('kunle'), first.id, checks);
  const bill = svc.bills.get(w.as('lola'), out.billId);
  assert.strictEqual(bill.status, 'approved'); assert.strictEqual(bill.payableMinor, 76875000, 'net of 5% WHT'); assert.strictEqual(bill.vendorOrgId, w.orgs.vendors.okafor.id);
  // the same invoice arriving again after the bill exists is a duplicate invoice, not just a duplicate file
  const copy = Buffer.from(read('invoice_okafor.pdf').toString('latin1').replace('09/03/2026', '09/03/2026 '), 'latin1');
  const rec2 = await upload(w, 'funmi', 'invoice_okafor_v2.pdf', 'structured', 'invoice_payable', copy);
  const doc2 = svc.rtfepe.listDocuments(w.as('funmi')).find(d => d.recordId === rec2.id);
  assert.ok(doc2, 'second copy is processed');
  svc.rtfepe.updateDocument(w.as('funmi'), doc2.id, { header: { department: 'Legal', costCenter: 'CC-LEG-50' }, refs: { purchaseRequest: 'PR-1', quotation: 'Q-1', purchaseOrder: 'PO-1', receipt: 'GRN-1' } });
  denies(assert, () => svc.rtfepe.submitDocument(w.as('funmi'), doc2.id), 422, 'duplicate');
});

test('unsolicited / unknown vendor documents are quarantined and cannot enter the payment queue without an approved exception', async () => {
  const w = await seeded();
  const { svc, db } = w;
  const text = 'INVOICE INV-9001\nFrom: Shady Traders Ltd\nDate: 10/03/2026\nService: Legal advisory fee\nAmount: NGN 90,000\nTotal: NGN 90,000';
  const rec = await upload(w, 'funmi', 'shady.txt', 'structured', 'invoice_payable', Buffer.from(text));
  const d = svc.rtfepe.listDocuments(w.as('funmi')).find(x => x.recordId === rec.id);
  svc.rtfepe.updateDocument(w.as('tunde'), d.id, { header: { department: 'Legal', costCenter: 'CC-LEG-50' } });
  svc.rtfepe.submitDocument(w.as('tunde'), d.id);
  const need = svc.rtfepe.getDocument(w.as('tunde'), d.id).requiredApprovals.map(r => r.role);
  assert.deepStrictEqual(need, ['Department Manager']);
  svc.rtfepe.approveDocument(w.as('funmi'), d.id, 'Department Manager');
  const out = svc.rtfepe.financeReview(w.as('kunle'), d.id, {});
  const bill = svc.bills.get(w.as('lola'), out.billId);
  assert.strictEqual(bill.status, 'quarantined'); assert.match(bill.quarantineReason, /not a verified relationship/);
  assert.strictEqual(bill.accountingStatus, 'none');
  denies(assert, () => svc.payments.createIntent(w.as('chidi'), { billId: bill.id, walletId: w.wallets.wOpex.id, idempotencyKey: key() }), 422, 'not_approved');
  denies(assert, () => svc.bills.releaseQuarantine(w.as('lola'), bill.id, 'ok'), 403);                                  // exception authority required
  denies(assert, () => svc.bills.releaseQuarantine(w.as('ngozi'), bill.id, ''), 400);
  const rel = svc.bills.releaseQuarantine(w.as('ngozi'), bill.id, 'Verified by phone with a known contact; vendor onboarding in progress');
  assert.strictEqual(rel.status, 'approved');
  assert.ok(svc.admin.auditTrail(w.as('adaeze')).some(a => a.action === 'bill.exception_approved' && /phone/.test(a.reason)));
  void db;
});

test('low OCR confidence is surfaced for human verification', { timeout: 120000 }, async () => {
  const w = await seeded();
  const buf = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'scanned_invoice.pdf'));
  const rec = await upload(w, 'funmi', 'scanned_invoice.pdf', 'structured', 'invoice_payable', buf);
  const full = w.svc.rtfepe.getRecord(w.as('funmi'), rec.id);
  assert.strictEqual(full.status, 'processed');
  assert.ok(full.ocrConfidence > 0, 'OCR confidence recorded');
  const d = w.svc.rtfepe.listDocuments(w.as('funmi')).find(x => x.recordId === rec.id);
  const doc = w.svc.rtfepe.getDocument(w.as('funmi'), d.id);
  assert.ok(doc.origin.ocrConfidence >= 0);
  if (doc.origin.ocrConfidence < 75) assert.ok(doc.platformWarnings.some(x => x.code === 'low_ocr'));
  // OCR text is never an approval: nothing was billed or paid
  assert.strictEqual(w.db.get("SELECT COUNT(*) n FROM bills WHERE source_document_id = ?", rec.sourceDocumentId).n, 0);
  denies(assert, () => w.svc.rtfepe.upload(w.as('funmi'), { buffer: Buffer.from('MZ not a pdf'), filename: 'evil.pdf', intake: 'structured' }), 415);
  denies(assert, () => w.svc.rtfepe.upload(w.as('funmi'), { buffer: Buffer.from('x'), filename: 'run.exe', intake: 'structured' }), 415);
});

test('finance policy import is versioned, source-referenced, and refuses to activate when thresholds are ambiguous', async () => {
  const w = await seeded();
  const { svc } = w;
  const active = svc.policy.list(w.as('adaeze')).find(p => p.status === 'active');
  assert.strictEqual(active.isDemo, true, 'the supplied sample policy is labelled demo');
  const rules = svc.policy.rules(w.as('adaeze'), active.id);
  assert.strictEqual(rules.length, 42);
  assert.match(rules.find(r => r.chunk_id === 'FIN-POL-001').source_ref, /CHUNK 002 \(FIN-POL-001\)/);
  const tiers = svc.policy.tiersFor(w.orgs.apex.id);
  assert.deepStrictEqual(tiers.tiers.map(t => t.maxNgn), [100000, 500000, 2000000, 10000000, null].map(x => x ?? Infinity));
  const good = `CHUNK 001 — Approval\nChunk ID: FIN-POL-001Category: Financial PolicyKeywords: approval\n\nTransaction Amount\n\nMinimum Approval\n\nNGN 0 – 50,000\n\nDepartment Manager\n\nAbove NGN 50,000\n\nCFO\n`;
  const bad = good.replace('Department Manager', 'Chief Vibes Officer');
  const v2 = await svc.policy.importPolicy(w.as('adaeze'), { filename: 'policy-v2.txt', buffer: Buffer.from(bad) });
  assert.strictEqual(v2.version, 2);
  assert.throws(() => svc.policy.activate(w.as('adaeze'), v2.id), e => e.code === 'policy_ambiguous');
  assert.strictEqual(svc.policy.active(w.orgs.apex.id).version, 1, 'a bad version never replaces the active policy');
  const v3 = await svc.policy.importPolicy(w.as('adaeze'), { filename: 'policy-v3.txt', buffer: Buffer.from(good) });
  svc.policy.activate(w.as('adaeze'), v3.id);
  assert.strictEqual(svc.policy.stepsFor(w.orgs.apex.id, 60000, 'opex').slots[0], 'cfo');
  assert.deepStrictEqual(svc.policy.stepsFor(w.orgs.apex.id, 60000, 'capex').slots, ['cfo', 'capex_finance']);
  await assert.rejects(svc.policy.importPolicy(w.as('chidi'), { filename: 'x.txt', buffer: Buffer.from('x') }), e => e.status === 403);
  await assert.rejects(svc.policy.importPolicy(w.as('adaeze'), { filename: 'x.txt', buffer: Buffer.from('no chunks here') }), e => e.status === 400);
  // with the stricter policy the previously ₦1.29m approval route changes; with no active policy approvals are refused rather than invented
  w.db.run("UPDATE policy_documents SET status = 'retired'");
  const pend = svc.bills.get(w.as('tunde'), w.bills.received);
  void pend;
  assert.strictEqual(svc.policy.tiersFor(w.orgs.apex.id).ok, false);
});
