// Customer-side payable bills: creation from issued invoices / RT-FEPE / expenses, validation, OPEX-CAPEX classification,
// budget control, policy-driven approval workflow, segregation of duties, disputes and accrual posting.
// Vendor approval (commercial document) and customer approval (expenditure) are separate controls recorded separately.
const { uid, iso } = require('./db');
const { bad, forbidden, notFound, conflict, unprocessable } = require('./errors');
const { sha256, mask } = require('./security');
const { SLOT_ROLES } = require('./rbac');
const { fmt } = require('./money');

const NGN_100K = 10_000_000;   // minor units: purchase request / PO / receipt threshold (PROC-POL-001)
const OUTLIER_X = 3;

module.exports = function billsService(core) {
  const { db, now, audit } = core;
  const year = () => now().getUTCFullYear();
  const orgOf = id => db.get('SELECT * FROM organizations WHERE id = ?', id);
  const userName = id => (id ? (db.get('SELECT name FROM users WHERE id = ?', id) || {}).name : null);

  function toFunctional(orgId, currency, minor) {
    const o = orgOf(orgId);
    if (currency === o.currency) return minor;
    return Math.round(minor * core.svc.ledger.fxRate(orgId, currency, o.currency, core.today()).rate);
  }
  const ngnMajor = (orgId, currency, minor) => {
    const f = toFunctional(orgId, currency, minor);
    const o = orgOf(orgId);
    if (o.currency === 'NGN') return f / 100;
    return core.svc.ledger.fxRate(orgId, o.currency, 'NGN', core.today()).rate * f / 100;
  };
  const nextNumber = orgId => {
    let n = db.get('SELECT COUNT(*) n FROM bills WHERE org_id = ?', orgId).n + 1, num;
    do { num = `BILL-${year()}-${String(n++).padStart(5, '0')}`; } while (db.get('SELECT 1 x FROM bills WHERE org_id = ? AND number = ?', orgId, num));
    return num;
  };

  function insertBill(b, lines) {
    const row = {
      id: uid(), status: 'received', payment_status: 'unpaid', accounting_status: 'none', classification: 'opex', department: '', cost_center: '', project: '', purchase_ref: '', financial_event: '', matched_phrase: '',
      is_demo: 0, is_payable: 1, version: 1, tax_minor: 0, wht_minor: 0, subtotal_minor: 0, party_ref: '', budget_committed_minor: 0, created_at: iso(now()), ...b,
    };
    row.number = row.number || nextNumber(row.org_id);
    db.insert('bills', row);
    lines.forEach((l, i) => db.insert('bill_line_items', { id: uid(), bill_id: row.id, org_id: row.org_id, position: i + 1, description: l.description, qty_milli: l.qty_milli ?? 1000, unit_price_minor: l.unit_price_minor ?? l.net_minor,
      net_minor: l.net_minor, tax_minor: l.tax_minor || 0, wht_minor: l.wht_minor || 0, total_minor: l.total_minor, account_code: l.account_code || null, financial_event: l.financial_event || '', matched_phrase: l.matched_phrase || '' }));
    return db.get('SELECT * FROM bills WHERE id = ?', row.id);
  }
  const fingerprint = (vendorKey, docNo, total, ccy, date) => sha256([String(vendorKey).toLowerCase(), String(docNo).toLowerCase(), total, ccy, date].join('|'));

  function view(b, ctx) {
    const lines = db.all('SELECT * FROM bill_line_items WHERE bill_id = ? ORDER BY position', b.id).map(l => ({ id: l.id, description: l.description, qty: l.qty_milli / 1000, unitPriceMinor: l.unit_price_minor, netMinor: l.net_minor, taxMinor: l.tax_minor, whtMinor: l.wht_minor, totalMinor: l.total_minor, accountCode: l.account_code, financialEvent: l.financial_event, matchedPhrase: l.matched_phrase }));
    const wf = db.get("SELECT * FROM approval_workflows WHERE subject_type = 'bill' AND subject_id = ? ORDER BY created_at DESC LIMIT 1", b.id);
    const steps = wf ? db.all('SELECT * FROM approval_steps WHERE workflow_id = ? ORDER BY position', wf.id).map(s => ({
      id: s.id, slot: s.slot, label: s.label, status: s.status, allowedRoles: s.allowed_roles.split(','),
      decision: db.get('SELECT d.decision, d.comment, d.at, u.name actor FROM approval_decisions d JOIN users u ON u.id = d.actor_id WHERE d.step_id = ? ORDER BY d.at DESC LIMIT 1', s.id) || null })) : [];
    const decisions = db.all("SELECT d.decision, d.comment, d.at, d.subject_version version, u.name actor FROM approval_decisions d JOIN users u ON u.id = d.actor_id WHERE d.subject_type = 'bill' AND d.subject_id = ? ORDER BY d.at", b.id);
    const inv = b.invoice_id && db.get('SELECT number, version, approved_at, approved_by FROM invoices WHERE id = ?', b.invoice_id);
    const vp = b.vendor_org_id && db.get('SELECT bank_changed_at, kyb_status FROM vendor_profiles WHERE org_id = ?', b.vendor_org_id);
    const intent = db.get("SELECT id, status, wallet_id, amount_minor, failure_reason FROM payment_intents WHERE bill_id = ? ORDER BY created_at DESC LIMIT 1", b.id);
    const po = b.purchase_order_id && db.get('SELECT number, status FROM purchase_orders WHERE id = ?', b.purchase_order_id);
    return {
      id: b.id, number: b.number, source: b.source, status: b.status, paymentStatus: b.payment_status, accountingStatus: b.accounting_status, accountingError: b.accounting_error,
      party: b.party_name, vendorOrgId: b.vendor_org_id, currency: b.currency, subtotalMinor: b.subtotal_minor, taxMinor: b.tax_minor, whtMinor: b.wht_minor, totalMinor: b.total_minor, payableMinor: b.payable_minor,
      classification: b.classification, department: b.department, costCenter: b.cost_center, project: b.project, purchaseRef: b.purchase_ref, purchaseOrder: po || null,
      receiptConfirmed: !!b.receipt_confirmed_at, receiptConfirmedBy: userName(b.receipt_confirmed_by), financialEvent: b.financial_event, matchedPhrase: b.matched_phrase,
      dueDate: b.due_date, requestedBy: userName(b.requested_by), requestedById: b.requested_by, beneficiaryUserId: b.beneficiary_user_id, isDemo: !!b.is_demo, isPayable: !!b.is_payable, quarantineReason: b.quarantine_reason,
      invoice: inv ? { id: b.invoice_id, number: inv.number, version: inv.version, vendorApprovedAt: inv.approved_at, vendorApprovedBy: ctx && ctx.orgId === b.org_id ? undefined : userName(inv.approved_by) } : null,
      createdAt: b.created_at, approvedAt: b.approved_at, paidAt: b.paid_at, version: b.version, docflowDocId: b.docflow_doc_id, sourceDocumentId: b.source_document_id,
      lines, workflow: wf ? { id: wf.id, status: wf.status, amountMinor: wf.amount_minor, steps } : null, decisions, latestIntent: intent || null,
      warnings: vp && vp.bank_changed_at && vp.bank_changed_at > b.created_at.slice(0, 10) ? [] : [],
      vendorBankChangedRecently: !!(vp && vp.bank_changed_at && (now().getTime() - new Date(vp.bank_changed_at).getTime()) < 30 * 86400e3),
      beneficiaryMasked: undefined, mask,
    };
  }

  const seesAll = ctx => ctx.can('bill.validate') || ctx.can('bill.approve') || ctx.can('ledger.view') || ctx.can('payment.execute');
  function mustBill(ctx, id) {
    const b = db.get('SELECT * FROM bills WHERE id = ? AND org_id = ?', id, ctx.orgId);
    if (!b || !ctx.can('bill.view') && !ctx.can('bill.approve')) throw notFound('Bill');
    if (!seesAll(ctx) && b.requested_by !== ctx.userId && b.beneficiary_user_id !== ctx.userId) throw notFound('Bill');
    return b;
  }

  /** Every control that gates approval and payment. `errors` block; `warnings` are shown to approvers. */
  function checks(b) {
    const errors = [], warnings = [];
    const e = (code, msg, ref) => errors.push({ level: 'error', code, msg, ref });
    const w = (code, msg, ref) => warnings.push({ level: 'warning', code, msg, ref });
    if (!b.is_payable) e('demo_not_payable', 'DEMO — NOT PAYABLE: this record was built from illustrative figures and cannot enter the payment workflow.');
    if (b.quarantine_reason) e('quarantined', `Quarantined: ${b.quarantine_reason}`);
    if (b.vendor_org_id) {
      const rel = core.svc.vendor.activeRelationship(b.org_id, b.vendor_org_id);
      if (!rel) e('no_relationship', 'There is no active relationship with this vendor in your workspace.');
      if (!core.svc.vendor.vendorKybVerified(b.vendor_org_id)) e('vendor_not_verified', 'Vendor KYB verification is not complete — invalid vendor verification.', 'PROC-POL-001');
      const vp = db.get('SELECT bank_changed_at FROM vendor_profiles WHERE org_id = ?', b.vendor_org_id);
      if (vp && vp.bank_changed_at && now().getTime() - new Date(vp.bank_changed_at).getTime() < 30 * 86400e3) w('bank_changed', 'The vendor changed payment details in the last 30 days — verify with a known contact before paying.', 'PROC-POL-001');
    }
    if (b.fingerprint) {
      const dup = db.get("SELECT number, status FROM bills WHERE org_id = ? AND fingerprint = ? AND id <> ? AND status NOT IN ('cancelled','superseded','rejected')", b.org_id, b.fingerprint, b.id);
      if (dup) e('duplicate', `Possible duplicate of ${dup.number} (${dup.status}): same vendor, document number, amount, currency and date.`);
    }
    if (b.vendor_org_id || b.party_name) {
      const prior = db.all("SELECT total_minor FROM bills WHERE org_id = ? AND party_name = ? AND id <> ? AND status IN ('approved') AND currency = ?", b.org_id, b.party_name, b.id, b.currency);
      if (prior.length >= 3) {
        const avg = prior.reduce((s, r) => s + r.total_minor, 0) / prior.length;
        if (b.total_minor > OUTLIER_X * avg) w('outlier', `Amount is ${(b.total_minor / avg).toFixed(1)}× this vendor's average of ${fmt(Math.round(avg), b.currency)}.`);
      }
    }
    const big = toFunctional(b.org_id, b.currency, b.total_minor) > NGN_100K && orgOf(b.org_id).currency === 'NGN';
    if (b.source === 'invoice' && big) {
      if (!b.purchase_order_id) e('po_required', 'A purchase order is required above ₦100,000 (PROC-POL-001).', 'PROC-POL-001');
      if (!b.receipt_confirmed_at) e('receipt_required', 'Goods / service receipt must be confirmed for three-way match (PO ↔ receipt ↔ invoice).', 'PROC-CTRL-001');
    }
    if (b.source === 'invoice' && b.purchase_order_id) {
      const po = db.get('SELECT amount_minor FROM purchase_orders WHERE id = ?', b.purchase_order_id);
      if (po && b.total_minor > po.amount_minor) e('po_mismatch', 'Invoice total exceeds the purchase order amount.', 'PROC-CTRL-001');
    }
    if (!b.cost_center) e('cost_center', 'Cost centre is required.', 'GOV-001');
    const lines = db.all('SELECT * FROM bill_line_items WHERE bill_id = ?', b.id);
    if (b.source !== 'rtfepe') for (const l of lines) {
      const code = l.account_code;
      if (!code) { e('account_missing', `Line "${l.description}" needs an account code.`); continue; }
      const a = db.get('SELECT * FROM chart_of_accounts WHERE org_id = ? AND code = ? AND active = 1', b.org_id, code);
      if (!a) e('account_invalid', `Account ${code} is not an active account.`);
      else if (b.classification === 'capex' && a.type !== 'asset') e('capex_account', `CAPEX line "${l.description}" must map to an asset (capitalisation) account, not ${a.name}.`);
      else if (b.classification === 'opex' && a.type !== 'expense') e('opex_account', `OPEX line "${l.description}" must map to an expense account, not ${a.name}.`);
    }
    // budget (cost centre × classification × fiscal year)
    const bud = db.get('SELECT * FROM budgets WHERE org_id = ? AND cost_center = ? AND classification = ? AND fiscal_year = ? AND project = ?', b.org_id, b.cost_center, b.classification, year(), b.project || '')
      || db.get('SELECT * FROM budgets WHERE org_id = ? AND cost_center = ? AND classification = ? AND fiscal_year = ? ORDER BY project LIMIT 1', b.org_id, b.cost_center, b.classification, year());
    if (b.cost_center) {
      if (!bud) e('no_budget', `No ${b.classification.toUpperCase()} budget is allocated to cost centre ${b.cost_center} for ${year()}.`, 'FIN-POL-001');
      else {
        const f = toFunctional(b.org_id, b.currency, b.total_minor);
        const remaining = bud.allocated_minor - bud.committed_minor - bud.spent_minor + (b.status === 'pending_approval' || b.status === 'approved' ? b.budget_committed_minor : 0);
        if (f > remaining) e('insufficient_budget', `Insufficient budget: ${fmt(f, orgOf(b.org_id).currency)} requested, ${fmt(Math.max(remaining, 0), orgOf(b.org_id).currency)} remaining.`, 'FIN-POL-001');
      }
    }
    return { errors, warnings, budget: bud && { id: bud.id, allocatedMinor: bud.allocated_minor, committedMinor: bud.committed_minor, spentMinor: bud.spent_minor } };
  }

  function commitBudget(b, sign) {
    const bud = db.get('SELECT * FROM budgets WHERE org_id = ? AND cost_center = ? AND classification = ? AND fiscal_year = ? ORDER BY project = ? DESC LIMIT 1', b.org_id, b.cost_center, b.classification, year(), b.project || '');
    if (!bud) return;
    const f = sign > 0 ? toFunctional(b.org_id, b.currency, b.total_minor) : b.budget_committed_minor;
    db.run('UPDATE budgets SET committed_minor = MAX(0, committed_minor + ?) WHERE id = ?', sign * f, bud.id);
    db.run('UPDATE bills SET budget_committed_minor = ? WHERE id = ?', sign > 0 ? f : 0, b.id);
  }
  function settleBudget(b) {
    const bud = db.get('SELECT * FROM budgets WHERE org_id = ? AND cost_center = ? AND classification = ? AND fiscal_year = ? ORDER BY project = ? DESC LIMIT 1', b.org_id, b.cost_center, b.classification, year(), b.project || '');
    if (!bud || !b.budget_committed_minor) return;
    db.run('UPDATE budgets SET committed_minor = MAX(0, committed_minor - ?), spent_minor = spent_minor + ? WHERE id = ?', b.budget_committed_minor, b.budget_committed_minor, bud.id);
    db.run('UPDATE bills SET budget_committed_minor = 0 WHERE id = ?', b.id);
  }

  /** Accrual: expense/asset against payables. Idempotent; a failure leaves the bill approved with accounting_status = posting_failed. */
  function postAccrual(billId, actorId = null) {
    const b = db.get('SELECT * FROM bills WHERE id = ?', billId);
    const lines = db.all('SELECT * FROM bill_line_items WHERE bill_id = ? ORDER BY position', billId);
    let jl = [];
    if (b.source === 'rtfepe') {
      jl = JSON.parse(b.entries_json || '[]').filter(x => !x.memo && x.amount > 0).map(x => ({ code: x.code, side: x.side, amountMinor: Math.round(x.amount * 100), name: x.account }));
      if (!jl.length) { db.run("UPDATE bills SET accounting_status = 'none', accounting_error = NULL WHERE id = ?", billId); return null; }
      for (const l of jl) core.svc.ledger.ensureAccount(b.org_id, l.code, l.name, core.svc.ledger.typeForCode(l.code));
    } else {
      const payableCode = b.source === 'expense' ? 2200 : 2110;
      let vat = 0, wht = 0;
      for (const l of lines) { jl.push({ code: l.account_code, side: 'Dr', amountMinor: l.net_minor }); vat += l.tax_minor; wht += l.wht_minor; }
      if (vat) jl.push({ code: 2310, side: 'Dr', amountMinor: vat });
      jl.push({ code: payableCode, side: 'Cr', amountMinor: b.total_minor - wht });
      if (wht) jl.push({ code: 2320, side: 'Cr', amountMinor: wht });
    }
    try {
      const r = core.svc.ledger.post(b.org_id, {
        postingKey: `bill:${b.id}:accrual`, sourceType: 'bill', sourceId: b.id, billId: b.id, sourceDocumentId: b.source_document_id, generatedDocumentId: b.docflow_doc_id,
        financialEvent: b.financial_event, memo: `${b.number} — ${b.party_name}`, currency: b.currency, lines: jl, costCenter: b.cost_center, project: b.project, createdBy: actorId,
      });
      db.run("UPDATE bills SET accounting_status = 'posted', accounting_error = NULL WHERE id = ?", billId);
      return r.entry;
    } catch (e) {
      db.run("UPDATE bills SET accounting_status = 'posting_failed', accounting_error = ? WHERE id = ?", e.message, billId);
      audit.record(b.org_id, { actorId, actorOrgId: b.org_id, action: 'journal.posting_failed', objectType: 'bill', objectId: billId, reason: e.message, refs: { code: e.code } });
      return null;
    }
  }

  function approverCandidates(b, steps, amountFunc, exclude) {
    const out = [];
    for (const m of db.all("SELECT user_id, role, approval_limit_minor FROM organization_members WHERE org_id = ? AND status = 'active'", b.org_id)) {
      if (exclude.includes(m.user_id) || !core.permsFor(m.role).has('bill.approve') || m.approval_limit_minor < amountFunc) continue;
      if (steps.some(s => s.allowed_roles.split(',').includes(m.role))) out.push(m.user_id);
    }
    return out;
  }

  const svc = {
    toFunctional, checks, postAccrual, view,

    createFromInvoice(inv, lines) {
      const req = inv.request_id && db.get('SELECT * FROM requests WHERE id = ?', inv.request_id);
      const vendor = db.get('SELECT name FROM organizations WHERE id = ?', inv.vendor_org_id);
      const m = req && db.get('SELECT department, cost_center FROM organization_members WHERE org_id = ? AND user_id = ?', inv.customer_org_id, req.requested_by);
      const wht = lines.reduce((s, l) => s + l.wht_minor, 0);
      const bill = insertBill({
        org_id: inv.customer_org_id, source: 'invoice', invoice_id: inv.id, vendor_org_id: inv.vendor_org_id, party_name: vendor.name, party_ref: inv.number, currency: inv.currency,
        subtotal_minor: lines.reduce((s, l) => s + l.net_minor - l.discount_minor, 0), tax_minor: inv.tax_minor, wht_minor: wht, total_minor: inv.total_minor, payable_minor: inv.total_minor - wht,
        department: m ? m.department : '', cost_center: m ? m.cost_center : '', purchase_order_id: inv.po_id, purchase_ref: req ? req.purchase_ref : '', due_date: inv.due_date, requested_by: req ? req.requested_by : null,
        is_demo: inv.is_demo, fingerprint: fingerprint(inv.vendor_org_id, inv.number, inv.total_minor, inv.currency, inv.issued_at.slice(0, 10)),
        supersedes_id: null, version: inv.version,
      }, lines.map(l => ({ description: l.description, qty_milli: l.qty_milli, unit_price_minor: l.unit_price_minor, net_minor: l.net_minor - l.discount_minor, tax_minor: l.tax_minor, wht_minor: l.wht_minor, total_minor: l.total_minor })));
      audit.record(inv.customer_org_id, { actorId: null, actorOrgId: inv.vendor_org_id, action: 'bill.created', objectType: 'bill', objectId: bill.id, next: { number: bill.number, source: 'invoice', invoice: inv.number, totalMinor: bill.total_minor }, refs: { invoiceId: inv.id, quoteId: inv.quote_id } });
      return bill;
    },
    supersedeForRevision(prevInv, newInv) {
      const b = prevInv.bill_id && db.get('SELECT * FROM bills WHERE id = ?', prevInv.bill_id);
      if (b) {
        if (b.payment_status !== 'unpaid') throw conflict('The previous invoice version has been paid or is being paid and cannot be replaced');
        if (b.budget_committed_minor) commitBudget(b, -1);
        db.run("UPDATE approval_workflows SET status = 'cancelled' WHERE subject_type = 'bill' AND subject_id = ? AND status = 'pending'", b.id);
        db.run("UPDATE bills SET status = 'superseded' WHERE id = ?", b.id);
        audit.record(b.org_id, { action: 'bill.superseded', objectType: 'bill', objectId: b.id, reason: `Replaced by invoice ${newInv.number} v${newInv.version}` });
      }
      db.run("UPDATE invoices SET status = 'superseded' WHERE id = ?", prevInv.id);
    },
    cancelForInvoice(inv, reason) {
      const b = db.get('SELECT * FROM bills WHERE id = ?', inv.bill_id);
      if (!b) return;
      if (b.payment_status !== 'unpaid') throw conflict('A paid or in-flight bill cannot be cancelled');
      if (b.budget_committed_minor) commitBudget(b, -1);
      db.run("UPDATE approval_workflows SET status = 'cancelled' WHERE subject_type = 'bill' AND subject_id = ? AND status = 'pending'", b.id);
      db.run("UPDATE bills SET status = 'cancelled' WHERE id = ?", b.id);
      audit.record(b.org_id, { action: 'bill.cancelled', objectType: 'bill', objectId: b.id, reason });
    },
    /** RT-FEPE hands over a finance-reviewed, fully approved document. Quarantined when the vendor is not a verified relationship. */
    createFromDocflow(orgId, { doc, bill, approvals, sourceDocumentId, reviewer }) {
      const totals = bill.totals;
      const toMinor = n => Math.round(n * 100);
      const org = orgOf(orgId);
      const vid = doc.header.partyId && doc.header.partyId.startsWith('v:') ? doc.header.partyId.slice(2) : null;
      const party = vid ? orgOf(vid) : null;
      const rel = party && core.svc.vendor.activeRelationship(orgId, party.id);
      let quarantine = null;
      const isVendorDoc = ['Vendor Invoice', 'Payment Voucher', 'Purchase Order'].includes(bill.sourceDocument);
      if (isVendorDoc && !rel && !(doc.header.partyKind === 'employee')) quarantine = 'Vendor is not a verified relationship of this workspace; match it to a valid vendor request or approve an exception.';
      else if (party && !core.svc.vendor.vendorKybVerified(party.id)) quarantine = 'Vendor KYB is not verified.';
      const illustrative = doc.lines && doc.lines.some(l => l.figureSource === 'fictitious');
      const first = bill.lines[0] || {};
      const payable = toMinor(bill.amountDue || 0);
      const row = insertBill({
        org_id: orgId, source: 'rtfepe', docflow_doc_id: doc.id, docflow_bill_id: bill.id, source_document_id: sourceDocumentId, vendor_org_id: rel ? party.id : null,
        party_name: bill.counterparty, party_ref: doc.refs.invoice || doc.number, currency: org.currency, subtotal_minor: toMinor(totals.net), tax_minor: toMinor(totals.vat), wht_minor: toMinor(totals.wht),
        total_minor: toMinor(totals.gross), payable_minor: payable, department: bill.department || '', cost_center: bill.costCenter || '', status: quarantine ? 'quarantined' : 'approved',
        classification: /capex|asset|equipment|machinery|vehicle/i.test(`${first.event} ${doc.header.purpose}`) ? 'capex' : 'opex', purchase_ref: doc.refs.purchaseRequest || '', financial_event: first.event || '', matched_phrase: first.phrase || '',
        due_date: null, requested_by: reviewer, is_demo: org.is_demo, is_payable: illustrative ? 0 : 1, quarantine_reason: quarantine, approved_at: quarantine ? null : iso(now()),
        fingerprint: fingerprint(bill.counterparty, doc.refs.invoice || doc.number, toMinor(totals.gross), org.currency, bill.documentDate || ''), entries_json: JSON.stringify(bill.entries),
        beneficiary_user_id: doc.header.partyId && doc.header.partyId.startsWith('e:') ? doc.header.partyId.slice(2) : null,
      }, bill.lines.map((l, i) => ({ description: l.description, qty_milli: 1000, net_minor: toMinor(l.figures.net), tax_minor: toMinor(l.figures.vat), wht_minor: toMinor(l.figures.wht), total_minor: toMinor(l.figures.gross), financial_event: l.event, matched_phrase: l.phrase })));
      for (const a of approvals) db.insert('approval_decisions', { id: uid(), org_id: orgId, subject_type: 'bill', subject_id: row.id, subject_version: 1, actor_id: a.userId, decision: 'approved', comment: a.role, at: a.at });
      audit.record(orgId, { actorId: reviewer, actorOrgId: orgId, action: 'bill.created', objectType: 'bill', objectId: row.id, next: { number: row.number, source: 'rtfepe', status: row.status },
        refs: { sourceDocumentId, generatedDocumentId: doc.id, docflowBillId: bill.id } });
      if (!quarantine) {
        const dup = checks(row).errors.find(x => x.code === 'duplicate');
        if (dup) { db.run("UPDATE bills SET status = 'quarantined', quarantine_reason = ?, approved_at = NULL WHERE id = ?", dup.msg, row.id); }
        else if (row.is_payable) { commitBudget(row, +1); postAccrual(row.id, reviewer); }
      }
      return db.get('SELECT * FROM bills WHERE id = ?', row.id);
    },

    list(ctx, { status, classification, payment } = {}) {
      ctx.require('bill.view');
      let sql = 'SELECT * FROM bills WHERE org_id = ?'; const p = [ctx.orgId];
      if (!seesAll(ctx)) { sql += ' AND (requested_by = ? OR beneficiary_user_id = ?)'; p.push(ctx.userId, ctx.userId); }
      if (status) { sql += ' AND status = ?'; p.push(status); }
      if (classification) { sql += ' AND classification = ?'; p.push(classification); }
      if (payment) { sql += ' AND payment_status = ?'; p.push(payment); }
      return db.all(sql + ' ORDER BY created_at DESC', ...p).map(b => {
        const v = view(b, ctx);
        return { id: v.id, number: v.number, source: v.source, status: v.status, paymentStatus: v.paymentStatus, accountingStatus: v.accountingStatus, party: v.party, currency: v.currency, totalMinor: v.totalMinor, payableMinor: v.payableMinor,
          classification: v.classification, costCenter: v.costCenter, dueDate: v.dueDate, isDemo: v.isDemo, isPayable: v.isPayable, quarantineReason: v.quarantineReason, createdAt: v.createdAt, financialEvent: v.financialEvent,
          overdue: !!(v.dueDate && v.dueDate < core.today() && v.paymentStatus !== 'paid' && v.status === 'approved') };
      });
    },
    get(ctx, id) {
      const b = mustBill(ctx, id);
      const v = view(b, ctx);
      const c = checks(b);
      return { ...v, checks: c, canActOn: svc.allowedActions(ctx, b) };
    },
    allowedActions(ctx, b) {
      const a = [];
      if (b.status === 'received' && ctx.can('bill.validate')) a.push('validate', 'submit');
      if (b.status === 'rejected' && ctx.can('bill.validate')) a.push('reopen');
      if (['received', 'pending_approval'].includes(b.status) && (ctx.can('bill.validate') || b.requested_by === ctx.userId)) a.push('dispute');
      if (['received', 'pending_approval'].includes(b.status) && ctx.can('bill.confirm_receipt') && !b.receipt_confirmed_at && b.source === 'invoice') a.push('confirm_receipt');
      if (b.status === 'approved' && b.payment_status === 'unpaid' && ctx.can('payment.initiate')) a.push('pay');
      if (b.status === 'quarantined' && ctx.can('docs.exception')) a.push('release_quarantine');
      return a;
    },

    /** Finance sets classification, cost centre, project and account codes. Commercial totals are never editable. */
    validate(ctx, id, patch) {
      ctx.require('bill.validate');
      const b = mustBill(ctx, id);
      if (b.status !== 'received') throw conflict(`Bill is ${b.status}; only bills awaiting validation can be edited`);
      const next = {
        classification: patch.classification || b.classification, cost_center: patch.costCenter ?? b.cost_center, project: patch.project ?? b.project,
        department: patch.department ?? b.department, purchase_ref: patch.purchaseRef ?? b.purchase_ref,
      };
      if (!['opex', 'capex'].includes(next.classification)) throw bad('Classification must be opex or capex');
      if (patch.costCenter && !db.get('SELECT 1 x FROM cost_centers WHERE org_id = ? AND code = ?', ctx.orgId, patch.costCenter)) throw bad(`Unknown cost centre ${patch.costCenter}`);
      db.tx(() => {
        db.run('UPDATE bills SET classification=?, cost_center=?, project=?, department=?, purchase_ref=? WHERE id=?', next.classification, next.cost_center, next.project, next.department, next.purchase_ref, id);
        const defaultCode = next.classification === 'capex' ? 1500 : 6900;
        for (const l of db.all('SELECT * FROM bill_line_items WHERE bill_id = ?', id)) {
          const code = patch.lineAccounts && patch.lineAccounts[l.id] != null ? Number(patch.lineAccounts[l.id]) : (patch.classification && patch.classification !== b.classification ? defaultCode : l.account_code || defaultCode);
          db.run('UPDATE bill_line_items SET account_code = ? WHERE id = ?', code, l.id);
        }
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'bill.validated', objectType: 'bill', objectId: id, prior: { classification: b.classification, costCenter: b.cost_center }, next });
      });
      return svc.get(ctx, id);
    },
    confirmReceipt(ctx, id) {
      ctx.require('bill.confirm_receipt');
      const b = mustBill(ctx, id);
      if (b.source !== 'invoice') throw conflict('Receipt confirmation applies to vendor invoices');
      if (['paid', 'cancelled', 'superseded', 'rejected'].includes(b.status) || b.payment_status === 'paid') throw conflict(`Bill is ${b.status}`);
      db.tx(() => {
        db.run('UPDATE bills SET receipt_confirmed_by = ?, receipt_confirmed_at = ? WHERE id = ?', ctx.userId, iso(now()), id);
        if (b.purchase_order_id) db.run("UPDATE purchase_orders SET status = 'received' WHERE id = ?", b.purchase_order_id);
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'bill.receipt_confirmed', objectType: 'bill', objectId: id });
      });
      return svc.get(ctx, id);
    },
    submit(ctx, id) {
      ctx.require('bill.validate');
      const b = mustBill(ctx, id);
      if (b.status !== 'received') throw conflict(`Bill is ${b.status}`);
      if (b.beneficiary_user_id === ctx.userId) throw forbidden('You cannot process a transaction where you are the beneficiary (GOV-001)', 'segregation');
      const c = checks(b);
      if (c.errors.length) throw unprocessable('Bill cannot be submitted for approval yet', c.errors, 'checks_failed');
      const amountNgn = ngnMajor(b.org_id, b.currency, b.total_minor);
      const plan = core.svc.policy.stepsFor(b.org_id, amountNgn, b.classification);
      if (!plan.ok) throw unprocessable(`Approval route cannot be determined: ${plan.reason}`, [{ level: 'error', msg: plan.reason }], 'policy_missing');
      const func = toFunctional(b.org_id, b.currency, b.total_minor);
      const wf = { id: uid(), org_id: b.org_id, subject_type: 'bill', subject_id: id, amount_minor: func, status: 'pending', created_by: ctx.userId, created_at: iso(now()) };
      db.tx(() => {
        db.insert('approval_workflows', wf);
        const steps = plan.slots.map((slot, i) => ({ id: uid(), workflow_id: wf.id, org_id: b.org_id, position: i + 1, slot, label: core.svc.policy.SLOT_LABEL[slot], allowed_roles: SLOT_ROLES[slot].join(','), status: 'pending' }));
        steps.forEach(s => db.insert('approval_steps', s));
        db.run("UPDATE bills SET status = 'pending_approval' WHERE id = ?", id);
        commitBudget({ ...b }, +1);
        db.insert('approval_decisions', { id: uid(), org_id: b.org_id, subject_type: 'bill', subject_id: id, subject_version: b.version, workflow_id: wf.id, actor_id: ctx.userId, decision: 'submitted', comment: `Tier route: ${plan.slots.join(' + ')} (${plan.sourceRef}${plan.isDemo ? ', demo policy' : ''})`, at: iso(now()) });
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'bill.submitted_for_approval', objectType: 'bill', objectId: id, prior: { status: 'received' }, next: { status: 'pending_approval', steps: plan.slots, amountNgn }, refs: { policy: plan.sourceRef } });
        core.notify(approverCandidates(b, steps, func, [ctx.userId, b.requested_by]), { orgId: b.org_id, kind: 'approval', title: `Bill ${b.number} awaits expenditure approval`, body: `${fmt(b.total_minor, b.currency)} · ${b.classification.toUpperCase()}`, link: `#/e/approvals` });
      });
      return svc.get(ctx, id);
    },

    pendingApprovals(ctx) {
      ctx.require('bill.approve');
      const rows = db.all(`SELECT s.id step_id, s.label, s.slot, s.allowed_roles, w.amount_minor, b.id bill_id FROM approval_steps s JOIN approval_workflows w ON w.id = s.workflow_id
                           JOIN bills b ON b.id = w.subject_id WHERE s.org_id = ? AND s.status = 'pending' AND w.status = 'pending' ORDER BY w.created_at`, ctx.orgId);
      return rows.filter(r => r.allowed_roles.split(',').includes(ctx.role)).map(r => {
        const b = db.get('SELECT * FROM bills WHERE id = ?', r.bill_id);
        const blocked = svc.approvalBlock(ctx, b, { amount_minor: r.amount_minor }, r.step_id);
        return { stepId: r.step_id, step: r.label, billId: b.id, number: b.number, party: b.party_name, currency: b.currency, totalMinor: b.total_minor, classification: b.classification, costCenter: b.cost_center, blockedReason: blocked };
      });
    },
    /** Why this user may not decide this step (null if they may). */
    approvalBlock(ctx, b, wf, stepId) {
      const step = db.get('SELECT * FROM approval_steps WHERE id = ?', stepId);
      if (!step.allowed_roles.split(',').includes(ctx.role)) return `Step "${step.label}" needs one of: ${step.allowed_roles.split(',').join(', ')}`;
      if (ctx.member.approval_limit_minor < wf.amount_minor) return `Amount exceeds your delegated approval authority of ${fmt(ctx.member.approval_limit_minor, ctx.org.currency)}`;
      if (b.requested_by === ctx.userId) return 'You requested this purchase (FIN-POL-002)';
      if (b.beneficiary_user_id === ctx.userId) return 'You are the beneficiary of this transaction (GOV-001)';
      const submitted = db.get("SELECT 1 x FROM approval_decisions WHERE subject_type = 'bill' AND subject_id = ? AND decision = 'submitted' AND actor_id = ?", b.id, ctx.userId);
      if (submitted) return 'You submitted this bill for approval (FIN-POL-002)';
      const already = db.get("SELECT 1 x FROM approval_decisions WHERE workflow_id = ? AND actor_id = ? AND decision = 'approved'", step.workflow_id, ctx.userId);
      if (already) return 'Each approval step must be given by a different person';
      return null;
    },
    decide(ctx, stepId, { decision, comment = '' } = {}) {
      ctx.require('bill.approve');
      if (!['approved', 'rejected'].includes(decision)) throw bad('Decision must be approved or rejected');
      const step = db.get('SELECT * FROM approval_steps WHERE id = ? AND org_id = ?', stepId, ctx.orgId);
      if (!step || step.status !== 'pending') throw notFound('Approval step');
      const wf = db.get('SELECT * FROM approval_workflows WHERE id = ?', step.workflow_id);
      if (wf.status !== 'pending') throw conflict(`Workflow is ${wf.status}`);
      const b = db.get('SELECT * FROM bills WHERE id = ?', wf.subject_id);
      if (b.status !== 'pending_approval') throw conflict(`Bill is ${b.status}`);
      const block = svc.approvalBlock(ctx, b, wf, stepId);
      if (block) throw forbidden(block, 'segregation');
      if (decision === 'rejected' && !String(comment).trim()) throw bad('A reason is required to reject');
      db.tx(() => {
        db.run('UPDATE approval_steps SET status = ? WHERE id = ?', decision, stepId);
        db.insert('approval_decisions', { id: uid(), org_id: ctx.orgId, subject_type: 'bill', subject_id: b.id, subject_version: b.version, workflow_id: wf.id, step_id: stepId, actor_id: ctx.userId, decision, comment, at: iso(now()) });
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: `bill.step_${decision}`, objectType: 'bill', objectId: b.id, next: { step: step.label, decision }, reason: comment });
        if (decision === 'rejected') {
          db.run("UPDATE approval_workflows SET status = 'rejected' WHERE id = ?", wf.id);
          db.run("UPDATE bills SET status = 'rejected' WHERE id = ?", b.id);
          commitBudget({ ...b }, -1);
          core.notify([b.requested_by], { orgId: b.org_id, kind: 'approval', title: `Bill ${b.number} was rejected`, body: comment, link: `#/e/bills/${b.id}` });
          return;
        }
        const open = db.get("SELECT COUNT(*) n FROM approval_steps WHERE workflow_id = ? AND status <> 'approved'", wf.id).n;
        if (!open) {
          db.run("UPDATE approval_workflows SET status = 'approved' WHERE id = ?", wf.id);
          db.run("UPDATE bills SET status = 'approved', approved_at = ? WHERE id = ?", iso(now()), b.id);
          audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'bill.approved', objectType: 'bill', objectId: b.id, prior: { status: 'pending_approval' }, next: { status: 'approved' } });
        }
      });
      const after = db.get('SELECT * FROM bills WHERE id = ?', b.id);
      if (after.status === 'approved' && after.accounting_status === 'none') svc.postAccrual(b.id, ctx.userId);
      if (after.status === 'approved') core.notify(db.all("SELECT user_id, role FROM organization_members WHERE org_id = ? AND status='active'", b.org_id).filter(m => core.permsFor(m.role).has('payment.execute')).map(m => m.user_id),
        { orgId: b.org_id, kind: 'payment', title: `Bill ${b.number} approved and ready to pay`, link: `#/e/bills/${b.id}` });
      return svc.get(ctx, b.id);
    },

    dispute(ctx, id, reason) {
      const b = mustBill(ctx, id);
      if (!(ctx.can('bill.validate') || b.requested_by === ctx.userId)) throw forbidden();
      if (!String(reason || '').trim()) throw bad('Explain what is wrong with the bill');
      if (!['received', 'pending_approval'].includes(b.status)) throw conflict(`A ${b.status} bill cannot be disputed`);
      db.tx(() => {
        db.run("UPDATE approval_workflows SET status = 'cancelled' WHERE subject_type = 'bill' AND subject_id = ? AND status = 'pending'", id);
        if (b.budget_committed_minor) commitBudget(b, -1);
        db.run("UPDATE bills SET status = 'disputed' WHERE id = ?", id);
        if (b.invoice_id) db.run("UPDATE invoices SET status = 'disputed', dispute_reason = ? WHERE id = ?", reason, b.invoice_id);
        audit.record([b.org_id, b.vendor_org_id].filter(Boolean), { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'bill.disputed', objectType: 'bill', objectId: id, reason });
        const inv = b.invoice_id && db.get('SELECT request_id, number FROM invoices WHERE id = ?', b.invoice_id);
        const ch = inv && db.get("SELECT id FROM channels WHERE kind='transaction' AND ref_type='request' AND ref_id = ?", inv.request_id);
        if (ch) core.svc.chat.systemMessage(ch.id, `${ctx.user.name} disputed invoice ${inv.number}: ${reason}. The vendor may issue a revised invoice.`);
        if (b.vendor_org_id) core.notify(core.svc.commerce.vendorStaffIds(b.vendor_org_id, 'invoice.draft'), { orgId: b.vendor_org_id, kind: 'document', title: `Invoice ${inv && inv.number} disputed`, body: reason, link: '#/v/documents' });
      });
      return svc.get(ctx, id);
    },
    reopen(ctx, id) {
      ctx.require('bill.validate');
      const b = mustBill(ctx, id);
      if (b.status !== 'rejected') throw conflict(`Bill is ${b.status}`);
      db.tx(() => { db.run("UPDATE bills SET status = 'received' WHERE id = ?", id); audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'bill.reopened', objectType: 'bill', objectId: id }); });
      return svc.get(ctx, id);
    },
    releaseQuarantine(ctx, id, reason) {
      ctx.require('docs.exception');
      const b = mustBill(ctx, id);
      if (b.status !== 'quarantined') throw conflict('Bill is not quarantined');
      if (!String(reason || '').trim()) throw bad('An exception reason is required');
      if (b.requested_by === ctx.userId) throw forbidden('The person who processed this document cannot approve its exception', 'segregation');
      db.tx(() => {
        db.run("UPDATE bills SET status = 'approved', quarantine_reason = NULL, approved_at = ?, fingerprint = ? WHERE id = ?", iso(now()), `exception:${b.id}`, id);
        db.insert('approval_decisions', { id: uid(), org_id: ctx.orgId, subject_type: 'bill', subject_id: id, subject_version: b.version, actor_id: ctx.userId, decision: 'approved', comment: `EXCEPTION: ${reason}`, at: iso(now()) });
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'bill.exception_approved', objectType: 'bill', objectId: id, prior: { quarantine: b.quarantine_reason }, reason });
      });
      const nb = db.get('SELECT * FROM bills WHERE id = ?', id);
      if (nb.is_payable) { commitBudget(nb, +1); postAccrual(id, ctx.userId); }
      return svc.get(ctx, id);
    },
    retryPosting(ctx, id) {
      ctx.require('ledger.post');
      const b = mustBill(ctx, id);
      if (!['approved'].includes(b.status)) throw conflict('Only approved bills are posted');
      svc.postAccrual(id, ctx.userId);
      if (b.payment_status === 'paid') core.svc.payments.postPayment(id, ctx.userId);
      return svc.get(ctx, id);
    },
    settleBudget,

    /* ------------------------------ employee expenses ------------------------------ */
    submitExpense(ctx, b, file) {
      ctx.require('expense.submit');
      const { toMinor } = require('./money');
      const amount = toMinor(b.amount);
      if (amount <= 0) throw bad('Amount must be greater than zero');
      if (!String(b.description || '').trim()) throw bad('Describe the expense');
      const incurred = b.incurredOn || core.today();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(incurred) || incurred > core.today()) throw bad('Expense date must be a past date');
      const days = Math.floor((now().getTime() - new Date(incurred + 'T00:00:00Z').getTime()) / 86400e3);
      const category = b.category || 'general';
      const acct = { travel: 6400, utilities: 6300, professional: 6500, it: 6600, office: 6700 }[category] || 6900;
      const row = insertBill({
        org_id: ctx.orgId, source: 'expense', party_name: ctx.user.name, party_ref: category, currency: ctx.org.currency, subtotal_minor: amount, total_minor: amount, payable_minor: amount, department: ctx.member.department,
        cost_center: b.costCenter || ctx.member.cost_center, requested_by: ctx.userId, beneficiary_user_id: ctx.userId, is_demo: ctx.org.is_demo, purchase_ref: file ? `Receipt: ${file.filename}` : '',
        fingerprint: fingerprint(ctx.userId, `${category}:${incurred}`, amount, ctx.org.currency, incurred), financial_event: category === 'travel' ? 'Travel Expense' : 'Employee Reimbursement',
      }, [{ description: b.description.trim(), net_minor: amount, total_minor: amount, account_code: acct }]);
      db.tx(() => {
        if (file) {
          const key = `bill_${uid()}`; core.putObject(key, file.buffer);
          db.insert('bill_attachments', { id: uid(), org_id: ctx.orgId, bill_id: row.id, filename: file.filename, mime: file.mime, size: file.buffer.length, sha256: sha256(file.buffer), storage_key: key, uploaded_by: ctx.userId, created_at: iso(now()) });
        }
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'expense.submitted', objectType: 'bill', objectId: row.id, next: { amountMinor: amount, category, incurred, lateDays: days > 21 ? days : 0 } });
      });
      return svc.get(ctx, row.id);
    },
    attachments(ctx, id) { mustBill(ctx, id); return db.all('SELECT id, filename, mime, size, sha256, created_at FROM bill_attachments WHERE bill_id = ?', id); },
  };
  return svc;
};
