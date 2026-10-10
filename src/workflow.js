// Pure accounting/workflow logic: figures, journal entries, policy checks.
const { resolveAccount, validateOverride } = require('./accounts');
const policy = require('./policy');

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const cents = n => Math.round(n * 100);

/** '' / null / undefined -> null ; '1,200.50' -> 1200.5 ; garbage -> NaN */
function num(v) {
  if (v === '' || v == null) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : NaN;
}

const PURCHASE_CREDITS = ['Accounts Payable', 'Employee Payable', 'GRNI Liability'];
const SETTLEMENT_DEBITS = ['Accounts Payable', 'Employee Payable'];
const SALE_DEBITS = ['Accounts Receivable', 'Bank', 'Cash'];
const SALE_CREDITS = ['Sales Revenue', 'Service Revenue', 'Revenue', 'Contract Revenue'];

/** none | purchase | sale | other — decides how VAT / WHT split the entry. */
function eventSide(row) {
  const { debitAccount: dr, creditAccount: cr } = row;
  if (!dr || !cr || dr === 'None' || cr === 'None') return 'none';
  if (PURCHASE_CREDITS.includes(cr) && !SETTLEMENT_DEBITS.includes(dr)) return 'purchase';
  if (SALE_DEBITS.includes(dr) && SALE_CREDITS.includes(cr)) return 'sale';
  return 'other';
}

function taxApplicability(row) {
  const side = eventSide(row);
  const vat = (side === 'purchase' && row.debitAccount !== 'Input VAT') || side === 'sale';
  const wht = side === 'purchase' && row.debitAccount !== 'Input VAT';
  return { side, vat, wht };
}

function computeLine(line, row) {
  const qty = num(line.quantity), unit = num(line.unitPrice), vat = num(line.vat), wht = num(line.wht);
  const invalid = [qty, unit, vat, wht].some(Number.isNaN);
  const q = qty == null ? 1 : qty;
  const net = unit == null ? 0 : r2(q * unit);
  const v = r2(vat || 0), w = r2(wht || 0);
  const gross = r2(net + v);
  return { net, vat: v, wht: w, gross, payable: r2(gross - w), invalid, tax: taxApplicability(row) };
}

function journalForLine(line, row, figs, overrides) {
  if (!row.debitAccount || row.debitAccount === 'None' || row.creditAccount === 'None') return [];
  const out = [];
  const add = (account, side, amount) => {
    if (!amount) return;
    const a = resolveAccount(account, overrides);
    out.push({ lineId: line.id, event: row.financialEvent, account, code: a.code, memo: a.memo, side, amount: r2(amount) });
  };
  const side = figs.tax.side;
  if (side === 'purchase') {
    add(row.debitAccount, 'Dr', figs.net);
    add('Input VAT', 'Dr', figs.vat);
    add(row.creditAccount, 'Cr', figs.gross - figs.wht);
    add('WHT Payable', 'Cr', figs.wht);
  } else if (side === 'sale') {
    add(row.debitAccount, 'Dr', figs.gross);
    add(row.creditAccount, 'Cr', figs.net);
    add('VAT Payable', 'Cr', figs.vat);
  } else {
    add(row.debitAccount, 'Dr', figs.net);
    add(row.creditAccount, 'Cr', figs.net);
  }
  return out;
}

const REQUIRED_HEADER = [
  ['counterparty', 'Counterparty (vendor / customer / employee / bank)'],
  ['department', 'Department'],
  ['costCenter', 'Cost center'],
  ['documentDate', 'Document date'],
  ['purpose', 'Business purpose'],
];

/** Full assessment of a document: figures, journal, approvals needed, issues per stage. */
function assess(doc, masterRows, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const overrides = (doc.review && doc.review.accountOverrides) || {};
  const lines = doc.lines.map(l => {
    const row = masterRows[l.rowIndex];
    const figs = computeLine(l, row);
    return { ...l, row, figs, journal: journalForLine(l, row, figs, overrides) };
  });
  const totals = lines.reduce((t, l) => ({
    net: r2(t.net + l.figs.net), vat: r2(t.vat + l.figs.vat), wht: r2(t.wht + l.figs.wht),
    gross: r2(t.gross + l.figs.gross), payable: r2(t.payable + l.figs.payable),
  }), { net: 0, vat: 0, wht: 0, gross: 0, payable: 0 });

  const journal = lines.flatMap(l => l.journal);
  const drC = journal.reduce((s, j) => s + (j.side === 'Dr' ? cents(j.amount) : 0), 0);
  const crC = journal.reduce((s, j) => s + (j.side === 'Cr' ? cents(j.amount) : 0), 0);

  const h = doc.header, refs = doc.refs;
  const sd = doc.sourceDocument;
  const e = (msg, ref) => ({ level: 'error', msg, ref });
  const w = (msg, ref) => ({ level: 'warning', msg, ref });

  // ---- Stage 1: ready to submit ----
  const submit = [];
  for (const [k, label] of REQUIRED_HEADER) if (!String(h[k] || '').trim()) submit.push(e(`${label} is required`, 'GOV-001'));
  if (!lines.length) submit.push(e('At least one line item is required'));
  lines.forEach((l, i) => {
    const tag = `Line ${i + 1} (${l.row.financialEvent})`;
    if (l.figs.invalid) submit.push(e(`${tag}: quantity, unit price, VAT and WHT must be numbers`));
    else if (!(l.figs.net > 0)) submit.push(e(`${tag}: enter quantity/unit price — net amount must be greater than 0`));
    if (l.figs.vat < 0 || l.figs.wht < 0) submit.push(e(`${tag}: VAT and WHT cannot be negative`));
    if (l.figs.vat > 0 && !l.figs.tax.vat) submit.push(e(`${tag}: VAT does not apply to this event`, 'TAX-EVT-001'));
    if (l.figs.wht > 0 && !l.figs.tax.wht) submit.push(e(`${tag}: withholding tax does not apply to this event`, 'TAX-EVT-002'));
    if (l.figs.wht > l.figs.gross) submit.push(e(`${tag}: WHT exceeds the gross amount`, 'TAX-EVT-002'));
  });
  if (totals.gross > 100000 && (sd === 'Purchase Order' || sd === 'Vendor Invoice')) {
    if (!String(refs.purchaseRequest || '').trim()) submit.push(e('Purchases above NGN 100,000 need a purchase request reference', 'PROC-POL-001'));
  }
  if (totals.gross > 500000 && (sd === 'Purchase Order' || sd === 'Vendor Invoice')) {
    if (!String(refs.quotation || '').trim() && !String(refs.quotationWaiver || '').trim())
      submit.push(e('Purchases above NGN 500,000 need a quotation reference (or a note why competitive quotes were not practical)', 'PROC-POL-001'));
  }
  if (sd === 'Vendor Invoice' && totals.gross > 100000) {
    if (!String(refs.purchaseOrder || '').trim()) submit.push(e('Vendor invoice needs the purchase order reference for three-way matching', 'PROC-CTRL-001'));
    if (!String(refs.receipt || '').trim()) submit.push(e('Vendor invoice needs the goods/service receipt reference for three-way matching', 'PROC-CTRL-001'));
  }
  if (sd === 'Payment Voucher' && lines.some(l => l.row.financialEvent === 'Vendor Payment') && !String(refs.invoice || '').trim())
    submit.push(e('A vendor payment must reference the vendor invoice', 'AP-EVT-002'));
  if (sd === 'Expense Claim') {
    if (h.documentDate && /^\d{4}-\d{2}-\d{2}$/.test(h.documentDate) && policy.businessDaysBetween(h.documentDate, today) > 15)
      submit.push(w('Claim is older than 15 business days — attach a late-submission justification in the business purpose', 'EXP-POL-001'));
    if (!h.receiptsAttached) submit.push(w('No supporting receipts confirmed (required where available)', 'EXP-POL-001'));
  }
  const unusedCommitment = lines.some(l => l.row.journalEntry === 'No Journal Entry');
  if (unusedCommitment) submit.push(w('At least one line is a commitment with no GL posting — it will convert to a bill with no journal lines', 'PROC-EVT-002'));

  // ---- approvals ----
  const required = policy.requiredApprovals(totals.gross, sd);
  const tier = policy.approvalTier(totals.gross);

  // ---- Stage 2: Finance review ----
  const review = [];
  const accountsNeedingCode = [];
  const seenAcc = new Set();
  for (const j of journal) {
    if (j.memo || seenAcc.has(j.account)) continue;
    seenAcc.add(j.account);
    const a = resolveAccount(j.account, overrides);
    if (a.needsCode) accountsNeedingCode.push({ account: a.name, range: a.range });
  }
  for (const a of accountsNeedingCode) {
    const ov = overrides[a.account];
    review.push(e(ov ? validateOverride(a.account, ov) : `Assign a COA code to "${a.account}" (${a.range.from}–${a.range.to}, ${a.range.label})`, 'COA-001'));
  }
  const lowConf = lines.filter(l => (l.confidence ?? 1) < policy.LOW_CONFIDENCE);
  if (lowConf.length && !(doc.review && doc.review.ackLowConfidence))
    review.push(e(`${lowConf.length} line(s) have classification confidence below ${policy.LOW_CONFIDENCE * 100}% — Finance Reviewer must confirm the event`, 'RAG-CTRL-001'));
  if (sd === 'Vendor Invoice' && totals.gross > 100000) {
    const tw = (doc.review && doc.review.threeWay) || {}, vc = (doc.review && doc.review.vendorChecks) || {};
    const missTw = policy.THREE_WAY_CHECKS.filter(c => !tw[c]);
    const missVc = policy.VENDOR_CHECKS.filter(c => !vc[c]);
    if (missTw.length) review.push(e(`Three-way match (PO ↔ receipt ↔ invoice) not confirmed for: ${missTw.join(', ')}`, 'PROC-CTRL-001'));
    if (missVc.length) review.push(e(`Procurement verification not confirmed for: ${missVc.join(', ')}`, 'PROC-POL-001'));
  }
  if (drC !== crC) review.push(e(`Journal does not balance (Dr ${drC / 100} vs Cr ${crC / 100})`));

  return {
    lines, totals, journal, balanced: drC === crC,
    tier: { max: tier.max === Infinity ? null : tier.max, roles: tier.roles },
    requiredApprovals: required, accountsNeedingCode, lowConfidenceLines: lowConf.map(l => l.id),
    issues: { submit, review },
  };
}

const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Segregation of duties (FIN-POL-002 / GOV-001): returns an error message or null. */
function segregationError(doc, person, role) {
  const p = norm(person);
  if (!p) return 'Name is required';
  const taken = [
    ['prepared this document', doc.header.preparedBy, 'FIN-POL-002'],
    ['is the counterparty/beneficiary', doc.header.counterparty, 'GOV-001'],
    ...doc.approvals.map(a => [`already acted as ${a.role}`, a.by, 'FIN-POL-002']),
    ...(doc.review && doc.review.by ? [['already acted as Finance Reviewer', doc.review.by, 'FIN-POL-002']] : []),
  ];
  const hit = taken.find(t => norm(t[1]) === p);
  return hit ? `${person} ${hit[0]} and cannot act as ${role} (${hit[2]})` : null;
}

module.exports = { assess, computeLine, journalForLine, eventSide, taxApplicability, segregationError, norm, r2, num };
