const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { mkService, ingest } = require('./helpers');
const { shutdown } = require('../src/ocr');
const { fictitiousFigures } = require('../src/figures');
const { master } = require('./helpers');

test.after(() => shutdown());

const MEMO = fs.readFileSync(path.join(__dirname, '..', 'samples', 'memo_admin_expenses.txt'), 'utf8');

test('unstructured memo: key financial events are summarised, noise is dropped', async () => {
  const svc = await mkService();
  const rec = await ingest(svc, MEMO);
  assert.strictEqual(rec.status, 'processed');
  assert.deepStrictEqual(rec.summary.events.map(e => e.match.event), ['Travel Expense', 'Vendor Payment', 'Utility Expense', 'Professional Service Expense']);
  assert.ok(!rec.summary.events.some(e => /offsite|\blease\b/i.test(e.text)));
  assert.match(rec.summary.headline, /4 key financial events/);
});

test('unstructured memo: source documents are generated per type and party, headers come from master data', async () => {
  const svc = await mkService();
  const rec = await ingest(svc, MEMO);
  assert.deepStrictEqual(rec.documents.map(d => d.sourceDocument), ['Expense Claim', 'Payment Voucher', 'Vendor Invoice', 'Vendor Invoice']);
  const ec = svc.getDocument(rec.documents[0].id);
  assert.strictEqual(ec.header.counterparty, 'Adaeze Okonkwo');
  assert.strictEqual(ec.header.accountNumber, '0123456789');
  assert.strictEqual(ec.header.department, 'Claims');           // employee master supplies department / cost centre
  assert.strictEqual(ec.header.documentDate, '2026-03-13');      // taken from the memo
  assert.strictEqual(ec.origin.intake, 'unstructured');
  assert.strictEqual(ec.lines[0].figureSource, 'fictitious');
  assert.strictEqual(ec.lines[0].statedAmount, 'NGN 205,000');
  const prof = svc.getDocument(rec.documents[3].id);
  assert.strictEqual(prof.header.counterparty, 'Crestview Audit Partners');
  assert.ok(Number(prof.lines[0].vat) > 0 && Number(prof.lines[0].wht) > 0);   // VAT 7.5% and WHT 5% illustrations
});

test('fictitious figures are deterministic and within the event range', () => {
  const row = master.rows.find(r => r.financialEvent === 'Travel Expense');
  const a = fictitiousFigures('seed', row), b = fictitiousFigures('seed', row);
  assert.deepStrictEqual(a, b);
  assert.ok(Number(a.unitPrice) >= 30000 && Number(a.unitPrice) <= 250000);
  assert.notDeepStrictEqual(fictitiousFigures('other seed', row), a);
});

test('illustrative figures must be confirmed or edited before submission', async () => {
  const svc = await mkService();
  const rec = await ingest(svc, 'Adaeze Okonkwo submitted a travel expense claimed for the Abuja regulatory meeting.');
  const id = rec.documents[0].id;
  assert.ok(svc.getDocument(id).issues.submit.some(i => /illustrative/.test(i.msg)));
  assert.throws(() => svc.submit(id, 'Ada Preparer'), e => e.status === 422);
  svc.update(id, { confirmFigures: true });
  assert.strictEqual(svc.getDocument(id).lines[0].figureSource, 'confirmed');
  assert.strictEqual(svc.submit(id, 'Ada Preparer').status, 'pending_approval');
});

test('editing a figure marks it as user-entered', async () => {
  const svc = await mkService();
  const rec = await ingest(svc, 'Adaeze Okonkwo submitted a travel expense claimed for the Abuja regulatory meeting.');
  const v = svc.getDocument(rec.documents[0].id);
  const out = svc.update(v.id, { lines: [{ id: v.lines[0].id, quantity: '1', unitPrice: '99000', vat: '', wht: '' }] });
  assert.strictEqual(out.lines[0].figureSource, 'user');
});

test('structured invoice (text): fields, line items, party and references are posted', async () => {
  const svc = await mkService();
  const rec = await ingest(svc, 'INVOICE  INV-2026-7788\nFrom: SecureTech Nigeria Ltd\nDate: 12/03/2026\nPO Number: PO-2026-00421\nService: Cybersecurity monitoring\nAmount: NGN 2,400,000\nVAT (7.5%): NGN 180,000\nTotal: NGN 2,580,000', { intake: 'structured', docType: 'invoice_payable' });
  assert.strictEqual(rec.status, 'processed');
  const d = svc.getDocument(rec.documents[0].id);
  assert.strictEqual(d.sourceDocument, 'Vendor Invoice');
  assert.strictEqual(d.header.counterparty, 'SecureTech Nigeria Ltd');
  assert.strictEqual(d.header.partyId, 'VEN-001');
  assert.strictEqual(d.header.documentDate, '2026-03-12');
  assert.strictEqual(d.refs.invoice, 'INV-2026-7788');
  assert.strictEqual(d.refs.purchaseOrder, 'PO-2026-00421');
  assert.strictEqual(d.lines.length, 1);
  assert.strictEqual(d.lines[0].event, 'Expense Recognition');
  assert.strictEqual(d.totals.gross, 2580000);
  assert.strictEqual(d.lines[0].figureSource, 'extracted');
});

test('structured invoice (table): quantities, unit prices and pro-rata VAT', async () => {
  const svc = await mkService();
  const rec = await ingest(svc, 'Invoice No: DL-5521\nFrom: Dell Nigeria Ltd\nDescription | Qty | Unit Price | Amount\nLaptop computers | 20 | 450,000 | 9,000,000\nDocking stations | 20 | 25,000 | 500,000\nVAT | | | 712,500\nTotal | | | 10,212,500', { intake: 'structured', docType: 'invoice_payable' });
  const d = svc.getDocument(rec.documents[0].id);
  assert.strictEqual(d.lines.length, 2);
  assert.deepStrictEqual(d.lines.map(l => l.quantity), ['20', '20']);
  assert.strictEqual(d.totals.net, 9500000);
  assert.strictEqual(d.totals.vat, 712500);
  assert.strictEqual(d.totals.gross, 10212500);
  assert.strictEqual(d.lines[0].event, 'Inventory Acquisition');   // "laptop" -> goods
});

test('quote and receipt are recognised and posted as their own document types', async () => {
  const svc = await mkService();
  const q = await ingest(svc, 'QUOTATION QT-889\nFrom: Dell Nigeria Ltd\nDescription | Qty | Unit Price | Amount\nServer rack | 2 | 800,000 | 1,600,000', { intake: 'structured', docType: 'auto' });
  const qd = svc.getDocument(q.documents[0].id);
  assert.strictEqual(qd.sourceDocument, 'Quote');
  assert.strictEqual(qd.refs.quotation, 'QT-889');
  assert.strictEqual(qd.journal.length, 0);                       // a quote posts nothing
  const r = await ingest(svc, 'RECEIPT RC-10\nReceived from: Sterling Motors Ltd\nAmount: NGN 500,000', { intake: 'structured', docType: 'auto' });
  const rd = svc.getDocument(r.documents[0].id);
  assert.strictEqual(rd.sourceDocument, 'Sales Receipt');
  assert.strictEqual(rd.header.counterparty, 'Sterling Motors Ltd');
  assert.strictEqual(rd.lines[0].event, 'Customer Payment');
});

test('image upload is stored, OCR-ed and processed (structured)', async () => {
  const svc = await mkService();
  const buffer = fs.readFileSync(path.join(__dirname, 'fixtures', 'invoice_securetech.png'));
  const rec = svc.createRecord({ buffer, filename: 'invoice.png', intake: 'structured', docType: 'invoice_payable', uploadedBy: 'Ada' });
  assert.strictEqual(rec.status, 'stored');                       // record exists immediately
  assert.deepStrictEqual(svc.recordFile(rec.id).buffer, buffer);  // and holds the original file
  await svc.processRecord(rec.id);
  const done = svc.getRecord(rec.id);
  assert.strictEqual(done.method, 'ocr');
  assert.ok(done.ocrConfidence > 70);
  const d = svc.getDocument(done.documents[0].id);
  assert.strictEqual(d.header.counterparty, 'SecureTech Nigeria Ltd');
  assert.strictEqual(d.totals.gross, 2580000);
  assert.strictEqual(d.refs.invoice, 'INV-2026-7788');
});

test('unrecognisable content is recorded without generating documents', async () => {
  const svc = await mkService();
  const rec = await ingest(svc, 'The weather was lovely and everyone enjoyed the offsite in the countryside.');
  assert.strictEqual(rec.status, 'processed');
  assert.strictEqual(rec.documents.length, 0);
  assert.match(rec.note, /No key financial event/);
});

test('unsupported files fail the record, not the server', async () => {
  const svc = await mkService();
  const rec = svc.createRecord({ buffer: Buffer.from('x'), filename: 'x.xyz', intake: 'unstructured' });
  await svc.processRecord(rec.id);
  assert.strictEqual(svc.getRecord(rec.id).status, 'failed');
  assert.match(svc.getRecord(rec.id).error, /Unsupported/);
});

test('reprocessing replaces draft documents only', async () => {
  const svc = await mkService();
  const rec = await ingest(svc, MEMO);
  const first = rec.documents.map(d => d.id);
  const again = await svc.reprocessRecord(rec.id);
  assert.strictEqual(again.documentIds.length, 4);
  assert.ok(!again.documentIds.some(id => first.includes(id)));
  svc.update(again.documentIds[0], { confirmFigures: true });
  svc.update(again.documentIds[0], { header: { department: 'Claims', costCenter: 'CC' } });
  svc.submit(again.documentIds[0], 'Ada');
  await assert.rejects(() => svc.reprocessRecord(rec.id), e => e.status === 409);
});

test('docx proposal (unstructured) and text-layer PDF invoice (structured) are extracted natively', async () => {
  const svc = await mkService();
  const read = f => fs.readFileSync(path.join(__dirname, '..', 'samples', f));
  const p = svc.createRecord({ buffer: read('proposal_q2_operations.docx'), filename: 'proposal.docx', intake: 'unstructured', uploadedBy: 'Ada' });
  await svc.processRecord(p.id);
  const pr = svc.getRecord(p.id);
  assert.strictEqual(pr.method, 'text');
  assert.deepStrictEqual(pr.documents.map(d => d.sourceDocument).sort(), ['Expense Claim', 'Payment Voucher', 'Vendor Invoice']);
  assert.ok(!pr.summary.events.some(e => /team building/.test(e.text)));
  const preview = await svc.recordPreview(p.id);
  assert.strictEqual(preview.kind, 'html');
  assert.match(preview.html, /Q2 Operations Support/);

  const i = svc.createRecord({ buffer: read('invoice_okafor.pdf'), filename: 'invoice.pdf', intake: 'structured', docType: 'auto', uploadedBy: 'Ada' });
  await svc.processRecord(i.id);
  const ir = svc.getRecord(i.id);
  assert.strictEqual(ir.method, 'text');
  const d = svc.getDocument(ir.documents[0].id);
  assert.strictEqual(d.header.counterparty, 'Okafor & Partners');
  assert.strictEqual(d.totals.gross, 806250);
  assert.strictEqual(d.lines[0].figures.wht, 37500);
  assert.strictEqual((await svc.recordPreview(i.id)).kind, 'pdf');
});

test('scanned (image-only) PDF falls back to OCR', { skip: !require('child_process').spawnSync('pdftoppm', ['-v']).stderr }, async () => {
  const svc = await mkService();
  const rec = svc.createRecord({ buffer: fs.readFileSync(path.join(__dirname, 'fixtures', 'scanned_invoice.pdf')), filename: 'scan.pdf', intake: 'structured', docType: 'invoice_payable', uploadedBy: 'Ada' });
  await svc.processRecord(rec.id);
  const r = svc.getRecord(rec.id);
  assert.strictEqual(r.status, 'processed', r.error);
  assert.strictEqual(r.method, 'ocr');
  assert.strictEqual(svc.getDocument(r.documents[0].id).totals.gross, 2580000);
});
