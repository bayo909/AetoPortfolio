// Matches an extracted line item to Financial Master Data rows using the
// "Financial Event" and "High Frequency Phrase" columns.
const STOP = new Set('a an the of to for from by on in at and or with as is are was were be been this that it its per our your their'.split(' '));
const CANON = {
  supplier: 'vendor', vendors: 'vendor', suppliers: 'vendor', client: 'customer',
  bill: 'invoice', billed: 'invoice', invoiced: 'invoice', invoicing: 'invoice',
  paid: 'payment', pay: 'payment', paying: 'payment', settle: 'settle', settled: 'settle', settlement: 'settle',
  purchased: 'purchase', purchasing: 'purchase', ordered: 'order',
  received: 'receive', receipt: 'receive', receiving: 'receive', receipts: 'receive',
  issued: 'issue', claimed: 'claim', deducted: 'deduct', deduction: 'deduct',
  credited: 'credit', approved: 'approve', approval: 'approve', rendered: 'render',
  sold: 'sale', sell: 'sale', sales: 'sale', granted: 'grant', processed: 'process',
  wages: 'salary', wage: 'salary', travelling: 'travel', travelled: 'travel', trip: 'travel',
  reimbursed: 'reimburse', reimbursement: 'reimburse', utilities: 'utility',
  charges: 'charge', charged: 'charge', disbursed: 'disburse', disbursement: 'disburse',
  repaid: 'repayment', repay: 'repayment', accrued: 'accrue', assessed: 'assess', imposed: 'impose',
  withheld: 'withhold', committed: 'commit', commitment: 'commit', fulfilled: 'fulfil', fulfilment: 'fulfil',
};

// Everyday wording -> extra concept tokens, so memos ("hotel and flights for the Abuja trip, please reimburse")
// can reach master-data phrases such as "Travel Expense Claimed".
const EXPAND = {
  hotel: ['travel'], accommodation: ['travel'], airfare: ['travel'], flight: ['travel'], taxi: ['travel'], transportation: ['travel'], per: [],
  reimburse: ['claim'], payment: ['settle'], refund: ['claim'],
  electricity: ['utility'], water: ['utility'], internet: ['utility'], power: ['utility'],
  legal: ['professional'], audit: ['professional'], consulting: ['professional'], consultancy: ['professional'], advisory: ['professional'], counsel: ['professional'],
  laptop: ['good'], equipment: ['good'], stock: ['good'], material: ['good'],
};

function stem(w) {
  if (CANON[w]) return CANON[w];
  if (w.length > 5 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && /(s|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return CANON[w] || w;
}

function tokenize(text) {
  const out = [];
  for (const raw of String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')) {
    if (!raw || STOP.has(raw) || /^\d+$/.test(raw)) continue;
    const t = stem(raw);
    out.push(t);
    for (const x of EXPAND[t] || []) out.push(x);
  }
  return out;
}

function coverage(phraseTokens, lineSet) {
  if (!phraseTokens.length) return 0;
  return phraseTokens.filter(t => lineSet.has(t)).length / phraseTokens.length;
}

function prepareRows(rows) {
  return rows.filter(r => !r.inactive).map(r => ({ row: r, phraseTokens: tokenize(r.phrase), eventTokens: tokenize(r.financialEvent), phraseNorm: tokenize(r.phrase).join(' ') }));
}

const MIN_SCORE = 0.5; // one generic shared word (e.g. "expense") must not create a match

function scoreLine(lineText, prepared) {
  const tokens = tokenize(lineText);
  const set = new Set(tokens);
  const joined = tokens.join(' ');
  return prepared.map(p => {
    const hfp = p.phraseNorm && joined.includes(p.phraseNorm) ? 1 : coverage(p.phraseTokens, set);
    const evt = coverage(p.eventTokens, set);
    const score = Math.min(1, Math.max(hfp, 0.8 * evt) + 0.2 * Math.min(hfp, evt));
    return { row: p.row, score: Math.round(score * 100) / 100, phraseCoverage: hfp, eventCoverage: evt };
  }).filter(m => m.score > 0).sort((a, b) => b.score - a.score || a.row.index - b.row.index);
}

/** Returns, for a source document type, the ranked candidate events for each line. */
function matchLines(lines, masterRows, sourceDocument) {
  const prepared = prepareRows(masterRows.filter(r => r.sourceDocument === sourceDocument && !r.inactive));
  return lines.map(l => {
    const candidates = scoreLine(l.text, prepared).slice(0, 3);
    const best = candidates[0];
    return { lineNo: l.n, text: l.text, matched: !!best && best.score >= MIN_SCORE, best: best || null, candidates };
  });
}

// When one phrase fits several document types equally well, prefer the type earlier in this list.
const TYPE_PRIORITY = ['Expense Claim', 'Payment Voucher', 'Vendor Invoice', 'Purchase Order', 'Payroll File', 'Tax Assessment',
  'Loan Agreement', 'Contract', 'Inventory Receipt', 'Customer Invoice', 'Sales Invoice', 'Sales Receipt', 'Bank Statement', 'Quote'];

/** Best Financial Event for a sentence across every source-document type (or the allowed subset). */
function bestMatchAcross(text, prepared, allowedTypes) {
  const pool = allowedTypes ? prepared.filter(p => allowedTypes.includes(p.row.sourceDocument)) : prepared;
  const ranked = scoreLine(text, pool);
  if (!ranked.length || ranked[0].score < MIN_SCORE) return { matched: false, best: ranked[0] || null, candidates: ranked.slice(0, 3) };
  const top = ranked[0].score;
  const pri = r => { const i = TYPE_PRIORITY.indexOf(r.sourceDocument); return i < 0 ? 99 : i; };
  const best = ranked.filter(m => m.score >= top - 0.001).sort((a, b) => pri(a.row) - pri(b.row) || a.row.index - b.row.index)[0];
  return { matched: true, best, candidates: ranked.slice(0, 3) };
}

module.exports = { tokenize, matchLines, scoreLine, prepareRows, bestMatchAcross, MIN_SCORE, TYPE_PRIORITY };
