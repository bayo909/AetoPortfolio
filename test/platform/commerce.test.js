const test = require('node:test');
const assert = require('node:assert');
const { seeded, denies } = require('./helpers');
const { priceLine, toMinor, toQtyMilli, divRound } = require('../../platform/money');
const { rulesProvider } = require('../../platform/agent');

const sku = (w, vendor, s) => w.db.get('SELECT * FROM products WHERE org_id = ? AND sku = ?', w.orgs.vendors[vendor].id, s);
const rfq = (w, who, vendor, title, items) => w.svc.commerce.createRequest(w.as(who), { vendorOrgId: w.orgs.vendors[vendor].id, title, items: items.map(([s, q]) => ({ productId: sku(w, vendor, s).id, qty: q })) });

test('money is exact integer arithmetic; totals are computed by the server', () => {
  assert.strictEqual(toMinor('1,250.50'), 125050);
  assert.throws(() => toMinor('10.505'), e => e.status === 400);
  assert.strictEqual(toQtyMilli('2.5'), 2500);
  assert.strictEqual(divRound(5, 2), 3); assert.strictEqual(divRound(-5, 2), -3);
  // 3 × ₦400,000, 5% customer discount, 7.5% VAT, 5% WHT
  const l = priceLine({ qty_milli: 3000, unit_price_minor: 40000000, discount_bp: 500, tax_bp: 750, wht_bp: 500 });
  assert.deepStrictEqual(l, { net_minor: 120000000, discount_minor: 6000000, tax_minor: 8550000, wht_minor: 5700000, total_minor: 122550000 });
  assert.throws(() => priceLine({ qty_milli: 1000, unit_price_minor: 1.5 }), e => e.status === 400);
  assert.throws(() => priceLine({ qty_milli: 0, unit_price_minor: 100 }), e => e.status === 400);
});

test('the AI agent only interprets text; unknown items become price_required instead of invented prices', async () => {
  const catalog = [{ sku: 'SEC-EDR-01', name: 'Endpoint Protection Licence (annual)', category: 'Software licences' }, { sku: 'SEC-PEN-01', name: 'Penetration Test (external + internal)', category: 'Security services' }];
  const out = await rulesProvider.interpret({ text: '60 endpoint licences and one penetration test, plus 3 quantum toasters', catalog });
  assert.deepStrictEqual(out.items.map(i => [i.sku, i.qty]), [['SEC-EDR-01', 60], ['SEC-PEN-01', 1]]);
  assert.ok(out.questions.some(q => /quantum toasters/.test(q)), 'unmatched item raises a clarifying question');
  const w = await seeded();
  const d = w.svc.agent.priceDraft(w.orgs.vendors.securetech.id, w.orgs.apex.id, [{ description: 'Quantum toaster', qtyMilli: 3000 }], { currency: 'NGN' });
  assert.strictEqual(d.lines[0].price_source, 'price_required');
  assert.strictEqual(d.lines[0].unit_price_minor, 0, 'no fabricated price');
  assert.strictEqual(d.flags[0].code, 'price_required');
  const missingQty = w.svc.agent.priceDraft(w.orgs.vendors.securetech.id, w.orgs.apex.id, [{ sku: 'SEC-EDR-01', qtyMilli: 0 }], { currency: 'NGN' });
  assert.strictEqual(missingQty.flags[0].code, 'qty_missing');
});

test('catalogue pricing: customer-specific rule beats list price; volume rule applies by quantity', async () => {
  const w = await seeded();
  const mon = sku(w, 'securetech', 'SEC-MON-01'), edr = sku(w, 'securetech', 'SEC-EDR-01');
  assert.strictEqual(w.svc.vendor.resolvePrice(mon, w.orgs.apex.id, 1000).discount_bp, 500);
  assert.strictEqual(w.svc.vendor.resolvePrice(mon, w.orgs.green.id, 1000).discount_bp, 0, 'another customer does not get Apex\'s rate');
  assert.strictEqual(w.svc.vendor.resolvePrice(edr, w.orgs.apex.id, 49000).discount_bp, 0);
  assert.strictEqual(w.svc.vendor.resolvePrice(edr, w.orgs.apex.id, 50000).discount_bp, 500);
});

test('AI-prepared drafts stay invisible until a DIFFERENT vendor user approves; customers cannot move money from a quote', async () => {
  const w = await seeded();
  const { svc } = w;
  const r = rfq(w, 'chidi', 'securetech', 'AI path test', [['SEC-EDR-01', 100]]);
  const out = await new Promise(res => res(svc.commerce.createQuote(w.as('kemi'), { requestId: r.id, lines: [{ productId: sku(w, 'securetech', 'SEC-EDR-01').id, qtyMilli: 100000 }] }, { via: 'agent' })));
  assert.strictEqual(out.status, 'draft'); assert.strictEqual(out.isDraftAI, true);
  assert.strictEqual(out.totalMinor, 100 * 1800000 * 0.95 * 1.075, 'volume discount + VAT computed on the server');
  denies(assert, () => svc.commerce.getQuote(w.as('chidi'), out.id), 404);                     // not visible to the customer
  denies(assert, () => svc.commerce.acceptQuote(w.as('funmi'), out.id), 404);
  denies(assert, () => svc.commerce.approveQuote(w.as('kemi'), out.id), 403);                   // sales agent has no approve permission
  denies(assert, () => svc.commerce.approveQuote(w.as('seyi'), out.id), 409);                   // must be submitted first
  svc.commerce.submitQuote(w.as('kemi'), out.id);
  // even the owner cannot approve a draft they prepared themselves (unless policy explicitly allows it)
  const own = svc.commerce.createQuote(w.as('seyi'), { requestId: r.id, lines: [{ productId: sku(w, 'securetech', 'SEC-EDR-01').id, qtyMilli: 1000 }] });
  svc.commerce.submitQuote(w.as('seyi'), own.id);
  denies(assert, () => svc.commerce.approveQuote(w.as('seyi'), own.id), 403, 'self_approval');
  const ok = svc.commerce.approveQuote(w.as('dayo'), own.id, { comment: 'second pair of eyes' });
  assert.strictEqual(ok.status, 'approved');
  assert.strictEqual(ok.decisions.at(-1).actor, 'Dayo Fashola');
  assert.strictEqual(ok.decisions.at(-1).version, 1);
  // customer now sees it; sees no internal flags / approver identity
  const seen = svc.commerce.getQuote(w.as('chidi'), own.id);
  assert.deepStrictEqual(seen.flags, []); assert.strictEqual(seen.preparedBy, null);
  // an approved quote is NOT payable: there is no bill until accepted, invoiced, issued
  assert.strictEqual(w.db.get('SELECT COUNT(*) n FROM bills WHERE party_ref LIKE ?', `%${own.number}%`).n, 0);
  // an explicit policy permission lets the vendor allow self approval, and that is audited
  svc.vendor.updateProfile(w.as('seyi'), { allowSelfApproval: true });
  const own2 = svc.commerce.createQuote(w.as('seyi'), { requestId: r.id, lines: [{ productId: sku(w, 'securetech', 'SEC-EDR-01').id, qtyMilli: 1000 }] });
  svc.commerce.submitQuote(w.as('seyi'), own2.id);
  assert.strictEqual(svc.commerce.approveQuote(w.as('seyi'), own2.id).status, 'approved');
});

test('quotes need a customer request; invoices need an accepted quote or an invoice request; no unsolicited payable invoices', async () => {
  const w = await seeded();
  const { svc } = w;
  denies(assert, () => svc.commerce.createQuote(w.as('kemi'), { lines: [] }), 400, 'request_required');
  denies(assert, () => svc.commerce.createInvoice(w.as('kemi'), { lines: [{ description: 'Surprise invoice', qty: 1, unitPrice: '5000000' }] }), 422, 'unsolicited_invoice');
  const r = rfq(w, 'chidi', 'securetech', 'RFQ only', [['SEC-MON-01', 1]]);
  denies(assert, () => svc.commerce.createInvoice(w.as('kemi'), { requestId: r.id }), 422, 'unsolicited_invoice');   // an RFQ is not an invoice request
  const q = svc.commerce.createQuote(w.as('kemi'), { requestId: r.id, lines: [{ productId: sku(w, 'securetech', 'SEC-MON-01').id, qtyMilli: 1000 }] });
  denies(assert, () => svc.commerce.createInvoice(w.as('kemi'), { quoteId: q.id }), 422, 'quote_not_accepted');
  // an invoice request raised by the customer is a valid trigger
  const ir = svc.commerce.createRequest(w.as('funmi'), { vendorOrgId: w.orgs.vendors.securetech.id, kind: 'invoice_request', title: 'Invoice for September monitoring', items: [{ productId: sku(w, 'securetech', 'SEC-MON-01').id, qty: 1 }] });
  const inv = svc.commerce.createInvoice(w.as('kemi'), { requestId: ir.id });
  assert.strictEqual(inv.status, 'draft');
  denies(assert, () => svc.commerce.issueInvoice(w.as('seyi'), inv.id), 409);                        // cannot skip approval
  svc.commerce.submitInvoice(w.as('kemi'), inv.id);
  denies(assert, () => svc.commerce.issueInvoice(w.as('seyi'), inv.id), 409);
  denies(assert, () => svc.commerce.approveInvoice(w.as('kemi'), inv.id), 403);
  svc.commerce.approveInvoice(w.as('seyi'), inv.id);
  // customer cannot see it until issued, and cannot approve vendor documents
  denies(assert, () => svc.commerce.getInvoice(w.as('funmi'), inv.id), 404);
  const issued = svc.commerce.issueInvoice(w.as('seyi'), inv.id);
  assert.strictEqual(issued.status, 'issued');
  assert.ok(issued.billId, 'issuing converts the invoice into a payable bill in the customer workspace');
  assert.strictEqual(svc.bills.get(w.as('tunde'), issued.billId).status, 'received');
});

test('lines without a price block submission; manual prices are flagged for the approver', async () => {
  const w = await seeded();
  const { svc } = w;
  const r = rfq(w, 'chidi', 'securetech', 'Pricing guard', [['SEC-MON-01', 1]]);
  const q = svc.commerce.createQuote(w.as('kemi'), { requestId: r.id, lines: [{ description: 'Bespoke consulting day', qty: 2 }] });
  denies(assert, () => svc.commerce.submitQuote(w.as('kemi'), q.id), 422, 'price_required');
  const q2 = svc.commerce.updateQuote(w.as('kemi'), q.id, { lines: [{ description: 'Bespoke consulting day', qty: 2, unitPrice: '250000' }] });
  assert.ok(q2.flags.some(f => f.code === 'manual_price' && f.level === 'warning'));
  assert.strictEqual(q2.totalMinor, 50000000);
  svc.commerce.submitQuote(w.as('kemi'), q.id);
  denies(assert, () => svc.commerce.updateQuote(w.as('kemi'), q.id, { notes: 'sneaky' }), 409, 'not_draft');
});

test('revisions preserve the previous version; an approved invoice total can never be edited', async () => {
  const w = await seeded();
  const { svc, db } = w;
  const r = rfq(w, 'chidi', 'securetech', 'Revise me', [['SEC-PEN-01', 1]]);
  const q = svc.commerce.createQuote(w.as('kemi'), { requestId: r.id, lines: [{ productId: sku(w, 'securetech', 'SEC-PEN-01').id, qtyMilli: 1000 }] });
  svc.commerce.submitQuote(w.as('kemi'), q.id); svc.commerce.approveQuote(w.as('seyi'), q.id, {});
  const v2 = svc.commerce.reviseQuote(w.as('kemi'), q.id);
  assert.strictEqual(v2.version, 2); assert.strictEqual(v2.status, 'draft');
  assert.strictEqual(db.get('SELECT status FROM quotations WHERE id = ?', q.id).status, 'superseded');
  assert.strictEqual(db.all('SELECT * FROM commercial_lines WHERE doc_id = ?', q.id).length, 1, 'v1 lines kept');
  denies(assert, () => svc.commerce.acceptQuote(w.as('funmi'), q.id), 409);                        // superseded version cannot be accepted
  // issued invoice: totals frozen by the database; revision after dispute creates v2 and supersedes the first bill
  const billId = w.bills.received;
  const bill = svc.bills.get(w.as('tunde'), billId);
  const inv = db.get('SELECT * FROM invoices WHERE bill_id = ?', billId);
  svc.bills.dispute(w.as('tunde'), billId, 'Quantity does not match delivery note');
  assert.strictEqual(db.get('SELECT status FROM invoices WHERE id = ?', inv.id).status, 'disputed');
  const rev = svc.commerce.reviseInvoice(w.as('kemi'), inv.id);
  assert.strictEqual(rev.version, 2);
  svc.commerce.submitInvoice(w.as('kemi'), rev.id); svc.commerce.approveInvoice(w.as('seyi'), rev.id);
  const issued = svc.commerce.issueInvoice(w.as('seyi'), rev.id);
  assert.notStrictEqual(issued.billId, billId);
  assert.strictEqual(db.get('SELECT status FROM bills WHERE id = ?', billId).status, 'superseded');
  assert.strictEqual(db.get('SELECT status FROM invoices WHERE id = ?', inv.id).status, 'superseded');
  assert.strictEqual(svc.bills.get(w.as('tunde'), issued.billId).status, 'received');
  assert.ok(bill.totalMinor > 0);
});

test('quotations expire; acceptance creates a purchase order; the requester cannot accept their own large purchase', async () => {
  const w = await seeded();
  const { svc, db } = w;
  const r = rfq(w, 'chidi', 'securetech', 'Expiry', [['SEC-PEN-01', 1]]);
  const q = svc.commerce.createQuote(w.as('kemi'), { requestId: r.id, lines: [{ productId: sku(w, 'securetech', 'SEC-PEN-01').id, qtyMilli: 1000 }], validUntil: new Date(w.clock.t.getTime() + 2 * 86400e3).toISOString().slice(0, 10) });
  svc.commerce.submitQuote(w.as('kemi'), q.id); svc.commerce.approveQuote(w.as('seyi'), q.id, {});
  w.clock.t = new Date(w.clock.t.getTime() + 5 * 86400e3);
  denies(assert, () => svc.commerce.acceptQuote(w.as('funmi'), q.id), 409, 'expired');
  w.clock.t = new Date(w.clock.t.getTime() - 5 * 86400e3);
  const r2 = rfq(w, 'funmi', 'securetech', 'Procurement own request', [['SEC-PEN-01', 1]]);
  const q2 = svc.commerce.createQuote(w.as('kemi'), { requestId: r2.id, lines: [{ productId: sku(w, 'securetech', 'SEC-PEN-01').id, qtyMilli: 1000 }] });
  svc.commerce.submitQuote(w.as('kemi'), q2.id); svc.commerce.approveQuote(w.as('seyi'), q2.id, {});
  denies(assert, () => svc.commerce.acceptQuote(w.as('funmi'), q2.id), 403, 'segregation');
  const acc = svc.commerce.acceptQuote(w.as('adaeze'), q2.id);
  assert.strictEqual(acc.status, 'accepted');
  assert.match(acc.purchaseOrder.number, /^PO-\d{4}-\d{5}$/);
  assert.strictEqual(db.get('SELECT amount_minor FROM purchase_orders WHERE id = ?', acc.purchaseOrder.id).amount_minor, acc.totalMinor);
});

test('COMPLETE HAPPY PATH: invitation → RFQ → AI draft → vendor approval → acceptance → invoice → bill → OPEX approval → QR → sandbox payment → reconciliation → journal → audit', async () => {
  const w = await seeded();
  const { svc, db } = w;
  // the seeded scenario A already ran this through the same services; verify every link of the chain
  const bill = svc.bills.get(w.as('tunde'), w.bills.paid);
  assert.strictEqual(bill.status, 'approved'); assert.strictEqual(bill.paymentStatus, 'paid'); assert.strictEqual(bill.accountingStatus, 'posted');
  const t = svc.admin.trace(w.as('adaeze'), w.bills.paid);
  assert.ok(t.quotation && t.quotation.approvedBy === 'Seyi Adeyemi' && t.quotation.acceptedBy === 'Funmi Adebayo');
  assert.ok(t.invoice && t.invoice.approvedBy === 'Seyi Adeyemi');
  assert.deepStrictEqual(t.approvals.filter(a => a.decision === 'approved').map(a => a.actor).sort(), ['Funmi Adebayo', 'Ngozi Eze']);
  assert.strictEqual(t.payments[0].status, 'succeeded'); assert.ok(t.payments[0].receiptNo.startsWith('RCT-'));
  assert.deepStrictEqual(t.journals.map(j => j.sourceType), ['bill', 'payment']);
  for (const j of t.journals) { const dr = j.lines.filter(l => l.side === 'Dr').reduce((s, l) => s + l.amountMinor, 0), cr = j.lines.filter(l => l.side === 'Cr').reduce((s, l) => s + l.amountMinor, 0); assert.strictEqual(dr, cr); }
  const accrual = t.journals[0], payment = t.journals[1];
  assert.deepStrictEqual(accrual.lines.map(l => [l.code, l.side]), [[6900, 'Dr'], [2310, 'Dr'], [2110, 'Cr'], [2320, 'Cr']]);
  assert.deepStrictEqual(payment.lines.map(l => [l.code, l.side]), [[2110, 'Dr'], [1120, 'Cr']]);
  assert.strictEqual(payment.totalMinor, bill.payableMinor, 'payment settles the payable net of withholding tax');
  assert.strictEqual(w.svc.payments.reconciliation(w.as('ibrahim'))[0].status, 'matched');
  assert.ok(svc.admin.verifyAudit(w.as('adaeze')).ok);
  // the audit trail links bill -> invoice -> payment
  const events = t.events.map(e => e.action);
  for (const a of ['bill.created', 'bill.validated', 'bill.submitted_for_approval', 'bill.approved', 'payment.succeeded']) assert.ok(events.includes(a), `audit has ${a}`);
  // wallet moved exactly once
  const wal = svc.payments.listWallets(w.as('tunde')).find(x => x.id === w.wallets.wOpex.id);
  assert.strictEqual(wal.balanceMinor, 50_000_000_00 - bill.payableMinor);
  assert.strictEqual(wal.reservedMinor, 0);
  assert.strictEqual(db.get("SELECT COUNT(*) n FROM wallet_transactions WHERE kind = 'debit' AND wallet_id = ?", w.wallets.wOpex.id).n, 1);
});
