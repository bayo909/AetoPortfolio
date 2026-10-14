// Parses structured business documents (invoice, quote, receipt) from extracted/OCR'd text lines.
const { amountsIn, datesIn } = require('./money');

const LABEL = {
  total: /\b(grand\s*total|total\s*(?:due|amount|payable)?|amount\s*due|balance\s*due|invoice\s*total)\b/i,
  vat: /\b(vat|value\s*added\s*tax)\b/i,
  wht: /\b(wht|with-?holding(?:\s*tax)?)\b/i,
  net: /\b(sub-?\s*total|net\s*amount|net\s*total|amount|net)\b/i,
  desc: /^\s*(service|item|description|product|goods|particulars)s?\s*[:\-]\s*(.+)$/i,
};
const PARTY_LABEL = {
  payable: /^\s*(from|vendor|supplier|issued\s*by|seller|payee|bill\s*from|company)\s*[:\-]\s*(.+)$/i,
  receivable: /^\s*(bill(?:ed)?\s*to|customer|client|sold\s*to|payer|invoice\s*to)\s*[:\-]\s*(.+)$/i,
  receipt: /^\s*(received\s*from|payer|customer|client)\s*[:\-]\s*(.+)$/i,
};
const COMPANY_WORD = /\b(ltd|limited|plc|inc|llc|enterprises?|partners|brokers|services|nigeria|hotels?|electric|group|associates|company)\b/i;
const HEADER_ROW = /\b(description|qty|quantity|unit\s*price|rate|amount|particulars)\b/i;

const lastAmount = text => { const a = amountsIn(text); return a.length ? a[a.length - 1].value : null; };
const num = s => { const n = Number(String(s).replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : null; };
const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

function parseRow(cells) {
  const nums = [], words = [];
  for (const c of cells) (/^[₦N]?\s?(?:NGN\s?)?[\d,]+(?:\.\d+)?$/.test(c.trim()) ? nums : words).push(c);
  if (!words.length || !nums.length || HEADER_ROW.test(words.join(' ')) && !nums.length) return null;
  const v = nums.map(num);
  let quantity = 1, unitPrice, net;
  if (v.length >= 3) { [quantity, unitPrice, net] = v.slice(-3); }
  else if (v.length === 2) { if (Number.isInteger(v[0]) && v[0] <= 1000 && v[1] > v[0]) { quantity = v[0]; net = v[1]; unitPrice = r2(net / quantity); } else { unitPrice = v[0]; net = v[1]; } }
  else { net = v[0]; unitPrice = v[0]; }
  return { description: words.join(' ').trim(), quantity, unitPrice, net: r2(net) };
}

/**
 * @param {{n:number,text:string}[]} lines
 * @param {'payable'|'receivable'|'receipt'} direction
 */
function parseStructured(lines, direction = 'payable') {
  const texts = lines.map(l => l.text);
  const items = [];
  const out = { docNumber: null, date: null, partyName: null, poNumber: null, prNumber: null, items, totals: { net: null, vat: null, wht: null, total: null }, warnings: [] };
  let pendingDesc = null;

  for (const text of texts) {
    // --- document / reference numbers
    if (!out.docNumber) {
      const m = text.match(/\b(?:invoice|inv|quotation|quote|qt|receipt|rcpt|ref(?:erence)?)\s*(?:no\.?|number|#)?\s*[:\-#]?\s*([A-Z0-9][A-Z0-9\/\-]{3,})/i);
      if (m && /\d/.test(m[1])) out.docNumber = m[1].replace(/[.,;]$/, '');
    }
    if (!out.poNumber) { const m = text.match(/\b(?:PO|purchase\s*order)\s*(?:no\.?|number|#)?\s*[:\-#]?\s*([A-Z0-9][A-Z0-9\-\/]{3,})/i); if (m && /\d/.test(m[1])) out.poNumber = m[1]; }
    if (!out.prNumber) { const m = text.match(/\b(?:PR|purchase\s*request)\s*(?:no\.?|number|#)?\s*[:\-#]?\s*([A-Z0-9][A-Z0-9\-\/]{3,})/i); if (m && /\d/.test(m[1])) out.prNumber = m[1]; }
    // --- date (prefer a labelled one)
    if (!out.date) { const d = datesIn(text); if (d.length && /\b(date|dated|issued|invoice date)\b/i.test(text)) out.date = d[0].iso; }
    // --- party
    if (!out.partyName) { const m = text.match(PARTY_LABEL[direction]); if (m) out.partyName = m[2].trim(); }

    // --- totals by label (last amount on the line; percentages ignored)
    const amount = lastAmount(text);
    const cells = text.includes('|') ? text.split('|').map(c => c.trim()) : null;
    if (amount != null && !cells) {
      if (LABEL.wht.test(text)) { out.totals.wht = amount; continue; }
      if (LABEL.vat.test(text)) { out.totals.vat = amount; continue; }
      if (LABEL.total.test(text) && !/sub-?\s*total/i.test(text)) { out.totals.total = amount; continue; }
      if (LABEL.net.test(text) && /^\s*(sub-?\s*total|net|amount)\b/i.test(text)) {
        if (/sub-?\s*total|net/i.test(text)) out.totals.net = amount;
        if (pendingDesc) { items.push({ description: pendingDesc, quantity: 1, unitPrice: amount, net: amount }); pendingDesc = null; }
        else if (!/sub-?\s*total|net/i.test(text)) out.totals.net = out.totals.net ?? amount;
        continue;
      }
    }
    const d = text.match(LABEL.desc);
    if (d) { pendingDesc = d[2].replace(/\s+[\d,]+(?:\.\d+)?$/, '').trim(); continue; }

    // --- tabular rows: "desc | qty | unit | amount"  or  "desc  2  50,000  100,000"
    if (cells && cells.length >= 2) {
      if (LABEL.total.test(cells[0]) || LABEL.vat.test(cells[0]) || LABEL.wht.test(cells[0]) || /sub-?\s*total/i.test(cells[0])) {
        const a = lastAmount(cells.slice(1).join(' '));
        if (a != null) { const c0 = cells[0]; if (LABEL.wht.test(c0)) out.totals.wht = a; else if (LABEL.vat.test(c0)) out.totals.vat = a; else if (/sub-?\s*total/i.test(c0)) out.totals.net = a; else out.totals.total = a; }
        continue;
      }
      const row = parseRow(cells);
      if (row && row.net > 0) items.push(row);
      continue;
    }
    const m = text.match(/^(.*?[A-Za-z].*?)\s+(\d{1,4})\s+([\d,]+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)$/);
    if (m && !HEADER_ROW.test(m[1])) items.push({ description: m[1].trim(), quantity: num(m[2]), unitPrice: num(m[3]), net: num(m[4]) });
  }

  if (!out.date) { const all = datesIn(texts.join('\n')); if (all.length) out.date = all[0].iso; }
  if (!out.partyName) {
    const fallback = texts.slice(0, 8).find(t => COMPANY_WORD.test(t) && !/apex insurance/i.test(t) && !/^(invoice|quote|receipt)/i.test(t) && t.length < 80 && !amountsIn(t).length);
    if (fallback) out.partyName = fallback.replace(/^[^A-Za-z0-9]+/, '').trim();
  }
  if (!items.length) {
    const net = out.totals.net ?? (out.totals.total != null ? r2(out.totals.total - (out.totals.vat || 0)) : null);
    if (net) {
      const title = texts.find(t => /[A-Za-z]{4}/.test(t) && !amountsIn(t).length && !/^(invoice|quotation|quote|receipt)\b/i.test(t)) || 'Goods / services per document';
      items.push({ description: pendingDesc || title, quantity: 1, unitPrice: net, net });
    }
  }
  const sum = r2(items.reduce((s, i) => s + i.net, 0));
  if (out.totals.net == null && items.length) out.totals.net = sum;
  if (out.totals.total != null && items.length) {
    const expect = r2(sum + (out.totals.vat || 0));
    if (Math.abs(expect - out.totals.total) > 1) out.warnings.push(`Line items + VAT (${expect.toLocaleString()}) do not equal the stated total (${out.totals.total.toLocaleString()}) — check OCR/figures`);
  }
  if (!items.length) out.warnings.push('No line items or amounts could be read from this document');
  return out;
}

/** Spread document-level VAT/WHT over lines pro-rata to net, fixing rounding on the last line. */
function allocate(total, items) {
  if (!total) return items.map(() => 0);
  const sum = items.reduce((s, i) => s + i.net, 0) || 1;
  let left = total;
  return items.map((i, k) => { const v = k === items.length - 1 ? r2(left) : r2(total * i.net / sum); left -= v; return v; });
}

module.exports = { parseStructured, allocate };
