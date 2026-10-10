const test = require('node:test');
const assert = require('node:assert');
const { loadMasterData } = require('../src/masterData');
const { loadPolicyChunks, requiredApprovals, businessDaysBetween } = require('../src/policy');
const { createService } = require('../src/service');

const master = loadMasterData();
const mk = async () => createService({ master, chunks: await loadPolicyChunks(), now: () => new Date('2026-03-10T10:00:00Z') });
const fail = (fn, status) => assert.throws(fn, e => e.status === status, `expected ${status}`);

function draft(svc, sourceDocument, text) {
  const up = svc.createUpload('t.txt', [{ n: 1, text }]);
  return svc.generate(up.id, sourceDocument, [{ lineNo: 1 }]).created[0];
}
const fill = (svc, id, extra = {}) => svc.update(id, {
  header: { counterparty: 'Okafor & Partners', department: 'Legal', costCenter: 'CC-100', documentDate: '2026-03-09', purpose: 'Legal advisory' },
  lines: [{ id: svc.getDocument(id).lines[0].id, quantity: '1', unitPrice: '750000', ...extra }],
});

test('policy docx is split into chunks keyed by clean Chunk ID', async () => {
  const c = await loadPolicyChunks();
  assert.strictEqual(Object.keys(c).length, 42);
  assert.strictEqual(c['FIN-POL-001'].title, 'Financial Approval Policy');
  assert.match(c['FIN-POL-001'].text, /Department Manager \+ Finance/);
});

test('approval tiers follow FIN-POL-001', () => {
  assert.deepStrictEqual(requiredApprovals(100000, 'Vendor Invoice').map(r => r.role), ['Department Manager']);
  assert.deepStrictEqual(requiredApprovals(100001, 'Vendor Invoice').map(r => r.role), ['Department Manager', 'Finance']);
  assert.deepStrictEqual(requiredApprovals(750000, 'Vendor Invoice').map(r => r.role), ['Head of Department', 'Finance Manager']);
  assert.deepStrictEqual(requiredApprovals(10000001, 'Vendor Invoice').map(r => r.role), ['CFO', 'CEO / Executive Committee']);
  assert.ok(requiredApprovals(50, 'Payroll File').some(r => r.role === 'Additional Approver'));
});

test('business days exclude weekends', () => {
  assert.strictEqual(businessDaysBetween('2026-03-06', '2026-03-09'), 1); // Fri -> Mon
});

test('document is created without figures, and cannot be submitted until completed', async () => {
  const svc = await mk();
  const d = draft(svc, 'Vendor Invoice', 'Professional fee billed by Okafor');
  const v = svc.getDocument(d.id);
  assert.strictEqual(v.totals.gross, 0);
  assert.strictEqual(v.lines[0].event, 'Professional Service Expense');
  fail(() => svc.submit(d.id, 'Ada'), 422);
});

test('vendor invoice end-to-end: legal fee with VAT and WHT becomes a balanced bill', async () => {
  const svc = await mk();
  const d = draft(svc, 'Vendor Invoice', 'Professional fee billed by Okafor');
  fill(svc, d.id, { vat: '56250', wht: '37500' });
  svc.update(d.id, { refs: { purchaseRequest: 'PR-1', quotation: 'Q-9', purchaseOrder: 'PO-1', receipt: 'GRN-1' } });
  svc.submit(d.id, 'Ada Preparer');
  assert.strictEqual(svc.getDocument(d.id).status, 'pending_approval');

  fail(() => svc.approve(d.id, 'Head of Department', 'Ada Preparer'), 403);          // preparer cannot approve
  fail(() => svc.approve(d.id, 'Head of Department', 'Okafor & Partners'), 403);     // beneficiary cannot approve
  fail(() => svc.approve(d.id, 'Department Manager', 'Hod One'), 400);               // wrong tier
  svc.approve(d.id, 'Head of Department', 'Hod One');
  fail(() => svc.approve(d.id, 'Finance Manager', 'Hod One'), 403);                  // same person twice
  svc.approve(d.id, 'Finance Manager', 'Fin Manager');
  assert.strictEqual(svc.getDocument(d.id).status, 'approved');

  fail(() => svc.financeReview(d.id, { by: 'Hod One' }), 403);
  fail(() => svc.financeReview(d.id, { by: 'Reviewer Rita' }), 422);                 // three-way match + vendor checks missing
  const all = o => Object.fromEntries(o.map(k => [k, true]));
  const c = svc.getDocument(d.id).checklists;
  svc.financeReview(d.id, { by: 'Reviewer Rita', threeWay: all(c.threeWay), vendorChecks: all(c.vendor) });
  assert.strictEqual(svc.getDocument(d.id).status, 'reviewed');

  fail(() => svc.convertToBill(d.id, 'Reviewer Rita'), 403);
  const bill = svc.convertToBill(d.id, 'Pat Processor');
  assert.strictEqual(bill.number, 'BILL-2026-00001');
  const dr = bill.entries.filter(e => e.side === 'Dr').reduce((s, e) => s + e.amount, 0);
  const cr = bill.entries.filter(e => e.side === 'Cr').reduce((s, e) => s + e.amount, 0);
  assert.strictEqual(dr, 806250); assert.strictEqual(cr, 806250);
  const by = Object.fromEntries(bill.entries.map(e => [e.account, e]));
  assert.strictEqual(by['Professional Fee Expense'].code, 6500);
  assert.strictEqual(by['Professional Fee Expense'].amount, 750000);
  assert.strictEqual(by['Accounts Payable'].amount, 768750);   // gross - WHT
  assert.strictEqual(by['WHT Payable'].code, 2320);
  assert.strictEqual(svc.getDocument(d.id).status, 'billed');
  assert.match(svc.billCsv(bill.id), /Professional Fee Expense,750000.00/);
});

test('rejection returns the document to draft and clears approvals', async () => {
  const svc = await mk();
  const d = draft(svc, 'Vendor Invoice', 'Utility bill received');
  fill(svc, d.id);
  svc.update(d.id, { lines: [{ id: svc.getDocument(d.id).lines[0].id, quantity: '1', unitPrice: '50000' }] });
  svc.submit(d.id, 'Ada');
  svc.approve(d.id, 'Department Manager', 'Mgr');
  assert.strictEqual(svc.getDocument(d.id).status, 'approved');
  svc.reject(d.id, 'Fin', 'Wrong cost center');
  const v = svc.getDocument(d.id);
  assert.strictEqual(v.status, 'draft'); assert.strictEqual(v.approvals.length, 0);
  assert.strictEqual(v.rejection.reason, 'Wrong cost center');
});

test('unmapped COA accounts need a code in range before review passes; low confidence needs acknowledgement', async () => {
  const svc = await mk();
  const up = svc.createUpload('t.txt', [{ n: 1, text: 'Customer billed' }]);
  const d = svc.generate(up.id, 'Customer Invoice', [{ lineNo: 1 }]).created[0];
  svc.update(d.id, { header: { counterparty: 'Acme', department: 'Sales', costCenter: 'CC-1', documentDate: '2026-03-09', purpose: 'x' },
    lines: [{ id: svc.getDocument(d.id).lines[0].id, quantity: '2', unitPrice: '10000', vat: '1500' }] });
  svc.submit(d.id, 'Ada');
  svc.approve(d.id, 'Department Manager', 'Mgr');
  fail(() => svc.financeReview(d.id, { by: 'Rita' }), 422);                                         // Revenue has no code yet
  fail(() => svc.financeReview(d.id, { by: 'Rita', accountOverrides: { Revenue: '6100' } }), 422); // out of 4000-4999
  svc.financeReview(d.id, { by: 'Rita', accountOverrides: { Revenue: '4100' } });
  const bill = svc.convertToBill(d.id, 'Pat');
  const by = Object.fromEntries(bill.entries.map(e => [e.account, e]));
  assert.strictEqual(by['Accounts Receivable'].amount, 21500);   // sale side: gross
  assert.strictEqual(by['Revenue'].amount, 20000);
  assert.strictEqual(by['Revenue'].code, 4100);
  assert.strictEqual(by['VAT Payable'].amount, 1500);
});

test('manual event pick without textual evidence is low confidence and needs reviewer acknowledgement', async () => {
  const svc = await mk();
  const up = svc.createUpload('t.txt', [{ n: 1, text: 'Staff team lunch' }]);
  assert.strictEqual(svc.generate(up.id, 'Expense Claim', [{ lineNo: 1 }]).skipped.length, 1);
  const rowIndex = master.rows.findIndex(r => r.sourceDocument === 'Expense Claim' && r.financialEvent === 'Travel Expense');
  const d = svc.generate(up.id, 'Expense Claim', [{ lineNo: 1, rowIndex }]).created[0];
  svc.update(d.id, { header: { counterparty: 'Emp One', department: 'Ops', costCenter: 'CC-2', documentDate: '2026-03-09', purpose: 'lunch', receiptsAttached: true },
    lines: [{ id: svc.getDocument(d.id).lines[0].id, quantity: '1', unitPrice: '20000' }] });
  svc.submit(d.id, 'Preparer');
  svc.approve(d.id, 'Department Manager', 'Mgr');
  fail(() => svc.financeReview(d.id, { by: 'Rita' }), 422);
  svc.financeReview(d.id, { by: 'Rita', ackLowConfidence: true });
  const bill = svc.convertToBill(d.id, 'Pat');
  assert.deepStrictEqual(bill.entries.map(e => [e.side, e.code]), [['Dr', 6400], ['Cr', 2200]]);
});

test('purchase order is a commitment: converts with no GL posting; procurement refs enforced above NGN 100k', async () => {
  const svc = await mk();
  const d = draft(svc, 'Purchase Order', 'Purchase order issued for furniture');
  fill(svc, d.id);
  fail(() => svc.submit(d.id, 'Ada'), 422);                    // 750k needs PR + quotation
  svc.update(d.id, { refs: { purchaseRequest: 'PR-5', quotationWaiver: 'Sole supplier' } });
  svc.submit(d.id, 'Ada');
  const v = svc.getDocument(d.id);
  assert.ok(v.requiredApprovals.some(r => r.role === 'Additional Approver'));   // contractual commitment
  svc.approve(d.id, 'Head of Department', 'Hod'); svc.approve(d.id, 'Finance Manager', 'Fm'); svc.approve(d.id, 'Additional Approver', 'Cfo');
  svc.financeReview(d.id, { by: 'Rita' });
  const bill = svc.convertToBill(d.id, 'Pat');
  assert.strictEqual(bill.entries.length, 0);
  assert.match(bill.glPosting, /No GL posting/);
});
