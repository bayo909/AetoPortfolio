// The two processing pipelines.
//  structured   : invoice / quote / receipt -> parse fields + line items -> post as a billing document
//  unstructured : memo / proposal / notes   -> summarise key financial events -> match Financial Events
//                 -> generate source documents (header from master data, illustrative figures)
const { prepareRows, scoreLine, MIN_SCORE } = require('./matcher');
const { findParties } = require('./parties');
const { summarise } = require('./summarize');
const { parseStructured, allocate } = require('./structured');
const { fictitiousFigures } = require('./figures');
const { datesIn } = require('./money');
const { taxApplicability } = require('./workflow');

const STRUCTURED_TYPES = {
  invoice_payable: { label: 'Invoice (payable, from a vendor)', sourceDocument: 'Vendor Invoice', direction: 'payable', kinds: ['vendor'], context: 'invoice received', refField: 'invoice', defaultEvent: 'Expense Recognition' },
  invoice_receivable: { label: 'Invoice (receivable, to a customer)', sourceDocument: 'Customer Invoice', direction: 'receivable', kinds: ['customer'], context: 'customer billed', refField: 'invoice', defaultEvent: 'Revenue Recognition' },
  quote: { label: 'Quote', sourceDocument: 'Quote', direction: 'payable', kinds: ['vendor'], context: 'quotation received', refField: 'quotation', defaultEvent: 'Quotation Received' },
  receipt: { label: 'Receipt', sourceDocument: 'Sales Receipt', direction: 'receipt', kinds: ['customer'], context: 'payment received from customer', refField: 'receipt', defaultEvent: 'Customer Payment' },
};

const PARTY_KINDS = {
  'Expense Claim': ['employee'], 'Payment Voucher': ['vendor', 'employee'], 'Vendor Invoice': ['vendor'], 'Purchase Order': ['vendor'],
  'Payroll File': ['employee'], 'Customer Invoice': ['customer'], 'Sales Invoice': ['customer'], 'Sales Receipt': ['customer'], 'Loan Agreement': ['vendor'],
};

function detectStructuredType(lines) {
  const head = lines.slice(0, 8).map(l => l.text).join(' ').toLowerCase();
  if (/\bquot(e|ation)\b/.test(head)) return 'quote';
  if (/\breceipt\b/.test(head)) return 'receipt';
  return 'invoice_payable';
}

const partyHeader = p => p ? {
  partyId: p.id, partyKind: p.kind, counterparty: p.name, address: p.address || '', accountNumber: p.accountNumber || '', bankName: p.bankName || '',
  taxId: p.taxId || '', email: p.email || '', department: p.department || '', costCenter: p.costCenter || '',
} : {};

function pickParty(text, parties, kinds, preferName) {
  const hits = findParties(text, parties, kinds);
  if (!hits.length) return null;
  if (preferName) { const pn = preferName.toLowerCase(); const m = hits.find(h => pn.includes(h.party.name.toLowerCase().split(' ')[0])); if (m) return m.party; }
  return hits[0].party;
}

function processStructured(ctx, record) {
  const key = record.docType && STRUCTURED_TYPES[record.docType] ? record.docType : detectStructuredType(record.lines);
  const T = STRUCTURED_TYPES[key];
  const parsed = parseStructured(record.lines, T.direction);
  const rows = ctx.master.rows.filter(r => r.sourceDocument === T.sourceDocument);
  const prepared = prepareRows(rows);
  const fallback = rows.find(r => r.financialEvent === T.defaultEvent) || rows[0];
  const fullText = record.lines.map(l => l.text).join('\n');
  const party = pickParty(fullText, ctx.parties, T.kinds, parsed.partyName);

  const notes = [...parsed.warnings];
  const lines = parsed.items.map(it => {
    const ranked = scoreLine(`${it.description} ${T.context}`, prepared);
    let best = ranked[0] && ranked[0].score >= MIN_SCORE ? ranked[0] : null;
    // on a tie the document type's generic event wins (an invoice with no goods wording is a service invoice)
    if (best) best = ranked.find(m => m.score >= best.score - 0.001 && m.row.index === fallback.index) || best;
    return { it, row: best ? best.row : fallback, confidence: best ? best.score : 0.35 };
  });
  const vatLines = lines.filter(l => taxApplicability(l.row).vat);
  const whtLines = lines.filter(l => taxApplicability(l.row).wht);
  const vatShares = allocate(vatLines.length ? parsed.totals.vat : 0, vatLines.map(l => l.it));
  const whtShares = allocate(whtLines.length ? parsed.totals.wht : 0, whtLines.map(l => l.it));
  if (parsed.totals.vat && !vatLines.length) notes.push(`VAT of ${parsed.totals.vat.toLocaleString()} shown on the document cannot be posted for this event`);
  if (parsed.totals.wht && !whtLines.length) notes.push(`Withholding tax of ${parsed.totals.wht.toLocaleString()} shown on the document cannot be posted for this event`);

  const docLines = lines.map(l => {
    const vi = vatLines.indexOf(l), wi = whtLines.indexOf(l);
    return {
      rowIndex: l.row.index, confidence: l.confidence, description: l.it.description, evidence: l.it.description, figureSource: 'extracted',
      quantity: String(l.it.quantity ?? 1), unitPrice: String(l.it.unitPrice ?? l.it.net),
      vat: vi >= 0 && vatShares[vi] ? String(vatShares[vi]) : '', wht: wi >= 0 && whtShares[wi] ? String(whtShares[wi]) : '',
    };
  });
  const refs = {};
  if (parsed.docNumber) refs[T.refField] = parsed.docNumber;
  if (parsed.poNumber) refs.purchaseOrder = parsed.poNumber;
  if (parsed.prNumber) refs.purchaseRequest = parsed.prNumber;
  const header = party ? partyHeader(party) : { counterparty: parsed.partyName || '' };
  if (!docLines.length) return { summary: null, documentIds: [], note: 'No line items or amounts could be read, so no billing document was created.', structured: { type: key, parsed } };
  const doc = ctx.makeDocument({
    sourceDocument: T.sourceDocument, intake: 'structured', record,
    header: { ...header, documentDate: parsed.date || ctx.today(), purpose: `${T.label.split(' (')[0]} ${parsed.docNumber || ''} ${header.counterparty ? 'from ' + header.counterparty : ''}`.replace(/\s+/g, ' ').trim() },
    refs, lines: docLines, notes,
  });
  return { summary: null, documentIds: [doc.id], structured: { type: key, label: T.label, parsed } };
}

function processUnstructured(ctx, record) {
  const summary = summarise(record.lines, ctx.master, ctx.parties);
  const fullText = record.lines.map(l => l.text).join('\n');
  const docDate = (datesIn(fullText)[0] || {}).iso; // e.g. the memo's own date
  const groups = new Map();
  for (const ev of summary.events) {
    if (!ev.match) continue;
    const sd = ev.match.sourceDocument;
    const kinds = PARTY_KINDS[sd];
    const party = pickParty(ev.text, ctx.parties, kinds) || pickParty(fullText, ctx.parties, kinds);
    const k = `${sd}|${party ? party.id : '?'}`;
    if (!groups.has(k)) groups.set(k, { sd, party, events: [] });
    groups.get(k).events.push(ev);
  }
  const documentIds = [];
  for (const g of groups.values()) {
    const dates = g.events.flatMap(e => e.dates);
    const lines = g.events.map(ev => {
      const row = ctx.master.rows[ev.match.rowIndex];
      const stated = ev.amounts.length ? ev.amounts[0] : null;
      return { rowIndex: row.index, confidence: ev.match.score, description: ev.text, evidence: ev.text, figureSource: 'fictitious', statedAmount: stated, ...fictitiousFigures(`${record.id}|${ev.text}`, row) };
    });
    const notes = [];
    if (!g.party) notes.push(`No ${(PARTY_KINDS[g.sd] || ['party']).join('/')} from the master data was recognised in the document — select the recipient in Billing`);
    const doc = ctx.makeDocument({
      sourceDocument: g.sd, intake: 'unstructured', record, summaryText: g.events.map(e => e.text).join(' '),
      header: { ...partyHeader(g.party), documentDate: dates[0] || docDate || ctx.today(), purpose: g.events[0].text.slice(0, 160) },
      refs: {}, lines, notes,
    });
    documentIds.push(doc.id);
  }
  return { summary, documentIds, note: documentIds.length ? null : 'No key financial event matched the Financial Master Data, so no source document was generated.' };
}

module.exports = { processStructured, processUnstructured, STRUCTURED_TYPES, PARTY_KINDS, detectStructuredType };
