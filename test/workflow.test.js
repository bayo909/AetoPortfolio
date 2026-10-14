const test = require('node:test');
const assert = require('node:assert');
const { requiredApprovals, businessDaysBetween, loadPolicyChunks } = require('../src/policy');
const { mkService, ingest, fail, master } = require('./helpers');

test('policy docx is split into chunks keyed by clean Chunk ID', async () => {
  const c = await loadPolicyChunks();
  assert.strictEqual(Object.keys(c).length, 42);
  assert.strictEqual(c['FIN-POL-001'].title, 'Financial Approval Policy');
});

test('approval tiers follow FIN-POL-001', () => {
  assert.deepStrictEqual(requiredApprovals(100000, 'Vendor Invoice').map(r => r.role), ['Department Manager']);
  assert.deepStrictEqual(requiredApprovals(100001, 'Vendor Invoice').map(r => r.role), ['Department Manager', 'Finance']);
  assert.deepStrictEqual(requiredApprovals(750000, 'Vendor Invoice').map(r => r.role), ['Head of Department', 'Finance Manager']);
  assert.deepStrictEqual(requiredApprovals(10000001, 'Vendor Invoice').map(r => r.role), ['CFO', 'CEO / Executive Committee']);
  assert.ok(requiredApprovals(50, 'Payroll File').some(r => r.role === 'Additional Approver'));
});

test('business days exclude weekends', () => assert.strictEqual(businessDaysBetween('2026-03-06', '2026-03-09'), 1));

// Vendor invoice from the structured pipeline, taken all the way through billing and payment.
const INVOICE = 'INVOICE INV-7788\nFrom: Okafor & Partners\nDate: 09/03/2026\nService: Legal advisory fee\nAmount: NGN 750,000\nVAT: NGN 56,250\nWithholding Tax: NGN 37,500\nTotal: NGN 806,250';

test('structured invoice end-to-end: corrections, approvals, finance review auto-bills, then payment', async () => {
  const svc = await mkService();
  const rec = await ingest(svc, INVOICE, { intake: 'structured', docType: 'invoice_payable' });
  const id = rec.documents[0].id;
  let d = svc.getDocument(id);
  assert.strictEqual(d.lines[0].event, 'Professional Service Expense');
  assert.strictEqual(d.totals.gross, 806250);
  assert.strictEqual(d.lines[0].figures.wht, 37500);

  // corrections in billing: the extracted invoice lacks procurement references and a cost centre
  fail(assert, () => svc.submit(id, 'Ada Preparer'), 422);
  svc.update(id, { header: { costCenter: 'CC-LEG-50' }, refs: { purchaseRequest: 'PR-1', quotation: 'Q-9', purchaseOrder: 'PO-1', receipt: 'GRN-1' } });
  svc.submit(id, 'Ada Preparer');

  fail(assert, () => svc.approve(id, 'Head of Department', 'Ada Preparer'), 403);       // preparer
  fail(assert, () => svc.approve(id, 'Head of Department', 'Okafor & Partners'), 403);  // beneficiary
  fail(assert, () => svc.approve(id, 'Department Manager', 'Hod One'), 400);            // wrong tier
  svc.approve(id, 'Head of Department', 'Hod One');
  fail(assert, () => svc.approve(id, 'Finance Manager', 'Hod One'), 403);               // same person twice
  svc.approve(id, 'Finance Manager', 'Fin Manager');
  assert.strictEqual(svc.getDocument(id).status, 'approved');

  fail(assert, () => svc.financeReview(id, { by: 'Hod One' }), 403);
  fail(assert, () => svc.financeReview(id, { by: 'Rita Review', ackLowConfidence: true }), 422);   // three-way match not confirmed
  const all = o => Object.fromEntries(o.map(k => [k, true]));
  const c = svc.getDocument(id).checklists;
  d = svc.financeReview(id, { by: 'Rita Review', ackLowConfidence: true, threeWay: all(c.threeWay), vendorChecks: all(c.vendor) });
  assert.strictEqual(d.status, 'billed');                      // approval -> bill, immediately
  const bill = svc.getBill(d.billId);
  assert.strictEqual(bill.number, 'BILL-2026-00001');
  const sum = side => bill.entries.filter(e => e.side === side).reduce((s, e) => s + e.amount, 0);
  assert.strictEqual(sum('Dr'), 806250); assert.strictEqual(sum('Cr'), 806250);
  const by = Object.fromEntries(bill.entries.map(e => [e.account, e]));
  assert.strictEqual(by['Professional Fee Expense'].code, 6500);
  assert.strictEqual(by['Accounts Payable'].amount, 768750);
  assert.strictEqual(bill.paymentStatus, 'awaiting_payment');
  assert.strictEqual(bill.amountDue, 768750);

  // payment: independent processor, beneficiary account from the vendor master
  fail(assert, () => svc.payBill(bill.id, 'Rita Review'), 403);
  fail(assert, () => svc.payBill(bill.id, 'Okafor & Partners'), 403);
  const paid = svc.payBill(bill.id, 'Pat Processor');
  assert.strictEqual(paid.paymentStatus, 'paid');
  assert.deepStrictEqual(paid.payment.entries.map(e => [e.side, e.account, e.amount]), [['Dr', 'Accounts Payable', 768750], ['Cr', 'Bank', 768750]]);
  assert.strictEqual(paid.payment.beneficiary.accountNumber, '1023456789');
  fail(assert, () => svc.payBill(bill.id, 'Someone Else'), 409);
});

test('rejection returns the document to draft and clears approvals', async () => {
  const svc = await mkService();
  const rec = await ingest(svc, 'INVOICE U-1\nFrom: Ikeja Electric\nService: Utility bill received\nAmount: NGN 50,000', { intake: 'structured', docType: 'invoice_payable' });
  const id = rec.documents[0].id;
  svc.submit(id, 'Ada'); svc.approve(id, 'Department Manager', 'Mgr');
  assert.strictEqual(svc.getDocument(id).status, 'approved');
  svc.reject(id, 'Fin', 'Wrong cost center');
  const v = svc.getDocument(id);
  assert.strictEqual(v.status, 'draft'); assert.strictEqual(v.approvals.length, 0);
  assert.strictEqual(v.rejection.reason, 'Wrong cost center');
});

test('unmapped COA accounts need a code in range; sale-side VAT splits to VAT Payable', async () => {
  const svc = await mkService();
  const rec = await ingest(svc, 'INVOICE C-77\nBill to: Sterling Motors Ltd\nDescription | Qty | Unit Price | Amount\nPolicy administration | 2 | 10,000 | 20,000\nVAT | | | 1,500\nTotal | | | 21,500', { intake: 'structured', docType: 'invoice_receivable' });
  const id = rec.documents[0].id;
  svc.update(id, { header: { department: 'Sales', costCenter: 'CC-SAL-60' } });
  svc.submit(id, 'Ada'); svc.approve(id, 'Department Manager', 'Mgr');
  fail(assert, () => svc.financeReview(id, { by: 'Rita', ackLowConfidence: true }), 422);                       // Revenue has no code
  fail(assert, () => svc.financeReview(id, { by: 'Rita', ackLowConfidence: true, accountOverrides: { Revenue: '6100' } }), 422);
  const d = svc.financeReview(id, { by: 'Rita', ackLowConfidence: true, accountOverrides: { Revenue: '4100' } });
  const by = Object.fromEntries(svc.getBill(d.billId).entries.map(e => [e.account, e]));
  assert.strictEqual(by['Accounts Receivable'].amount, 21500);
  assert.strictEqual(by['Revenue'].code, 4100);
  assert.strictEqual(by['VAT Payable'].amount, 1500);
  assert.strictEqual(svc.getBill(d.billId).paymentStatus, 'no_payment');   // receivable: nothing to pay out
});

test('low-confidence lines need reviewer acknowledgement', async () => {
  const svc = await mkService();
  const rec = await ingest(svc, 'INVOICE U-1\nFrom: Ikeja Electric\nService: Metering charges\nAmount: NGN 50,000', { intake: 'structured', docType: 'invoice_payable' });
  const id = rec.documents[0].id;
  assert.ok(svc.getDocument(id).lines[0].confidence < 0.7);
  svc.submit(id, 'Ada'); svc.approve(id, 'Department Manager', 'Mgr');
  svc.update; // (locked now)
  fail(assert, () => svc.financeReview(id, { by: 'Rita', accountOverrides: { Expense: '6600' } }), 422);
  assert.strictEqual(svc.financeReview(id, { by: 'Rita', ackLowConfidence: true, accountOverrides: { Expense: '6600' } }).status, 'billed');
});

test('quote converts to a bill with no GL posting and nothing to pay', async () => {
  const svc = await mkService();
  const rec = await ingest(svc, 'QUOTATION QT-889\nFrom: Dell Nigeria Ltd\nDescription | Qty | Unit Price | Amount\nServer rack | 2 | 800,000 | 1,600,000', { intake: 'structured', docType: 'quote' });
  const id = rec.documents[0].id;
  svc.update(id, { refs: { purchaseRequest: 'PR-5' } });
  svc.submit(id, 'Ada');
  const v = svc.getDocument(id);
  assert.ok(v.requiredApprovals.some(r => r.role === 'Head of Department'));
  for (const r of v.requiredApprovals) svc.approve(id, r.role, `Approver ${r.role}`);
  const d = svc.financeReview(id, { by: 'Rita', ackLowConfidence: true });
  const bill = svc.getBill(d.billId);
  assert.strictEqual(bill.entries.length, 0);
  assert.match(bill.glPosting, /No GL posting/);
  assert.strictEqual(bill.paymentStatus, 'no_payment');
});

test('party master: header can be pulled from the employee/vendor record', async () => {
  const svc = await mkService();
  const rec = await ingest(svc, 'INVOICE X-1\nFrom: Unknown Supplier Ltd\nService: Consulting\nAmount: NGN 90,000', { intake: 'structured', docType: 'invoice_payable' });
  const id = rec.documents[0].id;
  assert.strictEqual(svc.getDocument(id).header.partyId, '');
  assert.ok(svc.getDocument(id).issues.submit.some(i => /not in the .*master/.test(i.msg)));
  const out = svc.update(id, { header: { partyId: 'VEN-007' } });
  assert.strictEqual(out.header.counterparty, 'Crestview Audit Partners');
  assert.strictEqual(out.header.accountNumber, '7089012345');
  assert.strictEqual(out.header.costCenter, 'CC-FIN-20');
  const p = svc.createParty({ kind: 'vendor', name: 'New Vendor Ltd', accountNumber: '1' });
  assert.strictEqual(p.id, 'VEN-008');
});

test('state survives a restart when a storage directory is used', async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docflow-test-'));
  try {
    const a = await mkService({ storageDir: dir });
    const rec = await ingest(a, INVOICE, { intake: 'structured', docType: 'invoice_payable' });
    const b = await mkService({ storageDir: dir });
    assert.strictEqual(b.getDocument(rec.documents[0].id).header.counterparty, 'Okafor & Partners');
    assert.strictEqual(b.recordFile(rec.id).buffer, null);
    assert.ok(fs.existsSync(b.recordFile(rec.id).path));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
