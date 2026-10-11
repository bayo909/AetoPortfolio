// Turns document text (unstructured) or CSV/JSON (structured) into one normalised shape:
// { number, poRef, date, dueDate, currency, vendorName, lines[], subtotal, vatRate, vat, wht, total }
const { parseCsv } = require('../csv');
const { r2 } = require('./fx');

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = n => String(n).padStart(2, '0');
const validYmd = (y, m, d) => y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= new Date(y, m, 0).getDate();
const iso = (y, m, d) => (validYmd(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null);

function parseDate(s) {
  if (!s) return null;
  s = String(s).trim();
  let m;
  if ((m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) return iso(+m[1], +m[2], +m[3]);
  if ((m = s.match(/(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})/))) return iso(+m[3], +m[2], +m[1]); // day-first
  if ((m = s.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})/))) return MONTHS[m[2].toLowerCase()] ? iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]) : null;
  if ((m = s.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/))) return MONTHS[m[1].toLowerCase()] ? iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2]) : null;
  return null;
}

const CURRENCIES = ['USD', 'EUR', 'GBP', 'NGN', 'GHS', 'KES', 'ZAR', 'CAD', 'INR'];
const SYMBOLS = [['₦', 'NGN'], ['€', 'EUR'], ['£', 'GBP'], ['US$', 'USD'], ['$', 'USD']];

function detectCurrency(text) {
  const explicit = text.match(/currency\s*[:=-]\s*([A-Za-z]{3})\b/i);
  if (explicit && CURRENCIES.includes(explicit[1].toUpperCase())) return explicit[1].toUpperCase();
  const counts = {};
  for (const c of CURRENCIES) { const n = (text.match(new RegExp(`\\b${c}\\b`, 'g')) || []).length; if (n) counts[c] = n; }
  for (const [sym, c] of SYMBOLS) { const n = text.split(sym).length - 1; if (n) counts[c] = (counts[c] || 0) + n; }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

const AMOUNT = /(?<![\w.])-?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?(?![\d])|(?<![\w.])-?\d+\.\d{1,2}(?![\d])|(?<![\w.,])-?\d+(?![\d.,\w])/g;
const toNum = s => Number(String(s).replace(/,/g, ''));
const amountsIn = s => (s.replace(/\d+(?:\.\d+)?\s*%/g, ' ').match(AMOUNT) || []).map(toNum);
const strictAmounts = s => (s.replace(/\d+(?:\.\d+)?\s*%/g, ' ').match(/(?<![\w.])-?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{1,2}(?!\d)|(?<![\w.])-?\d{1,3}(?:,\d{3})+(?!\d)/g) || []).map(toNum);

const RE = {
  subtotal: /^\s*(?:sub\s*-?\s*total|net\s+(?:amount|total)|total\s+before\s+(?:vat|tax))\b/i,
  vat: /\b(?:vat|value\s+added\s+tax|sales\s+tax|gst)\b/i,
  wht: /\b(?:withholding\s+tax|wht)\b/i,
  total: /^\s*(?:grand\s+total|total\s+(?:amount\s+)?(?:due|payable|incl\w*)|amount\s+(?:due|payable)|balance\s+due|total)\b/i,
  number: /^\s*(?:tax\s+)?(?:invoice|inv|bill|receipt|credit\s+note|voucher|certificate|cert)\s*(?:no\.?|number|num|#|ref)?\s*[:#\-]\s*([A-Za-z0-9][A-Za-z0-9\-\/._]*)/i,
  poRef: /^\s*(?:p\.?o\.?|purchase\s+order)\s*(?:no\.?|number|num|#|ref)?\s*[:#\-]\s*([A-Za-z0-9][A-Za-z0-9\-\/._]*)/i,
  date: /^\s*(?:invoice\s+|issue\s+|receipt\s+)?date\s*[:\-]\s*(.+)$/i,
  due: /^\s*(?:due\s+date|payment\s+due|due)\s*[:\-]\s*(.+)$/i,
  vendor: /^\s*(?:from|vendor|supplier|billed\s+by|issued\s+by|seller|payee)\s*[:\-]\s*(.+)$/i,
  tableHead: /\b(?:description|item)\b.*\b(?:amount|total|price|qty|quantity)\b/i,
};

function itemFromLine(raw) {
  const line = raw.trim();
  if (!line || RE.subtotal.test(line) || RE.total.test(line) || RE.tableHead.test(line)) return null;
  if (RE.vat.test(line) || RE.wht.test(line)) return null;
  const hasCells = /\||\t| {2,}/.test(line);
  const cells = line.split(/\s*\|\s*|\t+| {2,}/).map(s => s.trim()).filter(Boolean);
  // "desc | qty | unit | amount" style rows
  if (hasCells && cells.length >= 2) {
    const nums = [];
    let i = cells.length - 1;
    while (i > 0 && /^[^A-Za-z]*-?[\d,]+(\.\d+)?[^A-Za-z]*$/.test(cells[i]) && amountsIn(cells[i]).length === 1) { nums.unshift(amountsIn(cells[i])[0]); i--; }
    const desc = cells.slice(0, i + 1).join(' ');
    if (nums.length && /[A-Za-z]{3}/.test(desc)) return fromNums(desc, nums);
  }
  // "desc  2 x 500.00 = 1,000.00" or "desc ... 1,000.00"
  let m = line.match(/^(.*?[A-Za-z]{3}.*?)\s+(\d+(?:\.\d+)?)\s*(?:x|×|@)\s*[^\d\s-]?\s*([\d,]+(?:\.\d+)?)\s*(?:=|:)?\s*[^\d\s-]?\s*([\d,]+(?:\.\d+)?)?\s*$/i);
  if (m) return fromNums(m[1], [Number(m[2]), toNum(m[3]), ...(m[4] ? [toNum(m[4])] : [])]);
  const amts = strictAmounts(line);
  if (amts.length === 1 && /[A-Za-z]{3}/.test(line) && !/^\w[\w ]*:\s*$/.test(line) && !RE.number.test(line) && !RE.date.test(line) && !RE.due.test(line) && !RE.poRef.test(line)) {
    const desc = line.replace(/[^A-Za-z)]*[\d,]+\.\d+[^A-Za-z]*$/, '').replace(/[.\s:–-]+$/, '').trim();
    if (/[A-Za-z]{3}/.test(desc)) return fromNums(desc, [amts[0]]);
  }
  return null;
}

function fromNums(desc, nums) {
  desc = desc.replace(/^\d+[.)]\s+/, '').trim();
  if (nums.length === 1) return { description: desc, quantity: 1, unitPrice: nums[0], amount: nums[0] };
  if (nums.length === 2) return { description: desc, quantity: 1, unitPrice: nums[0], amount: nums[1] };
  const [quantity, unitPrice, amount] = nums.slice(-3);
  return { description: desc, quantity, unitPrice, amount };
}

function parseText(textLines) {
  const out = { number: null, poRef: null, date: null, dueDate: null, currency: null, vendorName: null, lines: [], subtotal: null, vatRate: null, vat: null, wht: null, total: null };
  const text = textLines.join('\n');
  out.currency = detectCurrency(text);
  for (const raw of textLines) {
    const line = raw.trim();
    let m;
    if ((m = line.match(RE.vendor)) && !out.vendorName) { out.vendorName = m[1].trim(); continue; }
    if ((m = line.match(RE.poRef))) { out.poRef = out.poRef || m[1]; continue; }
    if ((m = line.match(RE.number))) { out.number = out.number || m[1]; continue; }
    if ((m = line.match(RE.due))) { out.dueDate = out.dueDate || parseDate(m[1]); continue; }
    if ((m = line.match(RE.date))) { out.date = out.date || parseDate(m[1]); continue; }
    const amts = amountsIn(line.replace(/\b\d{1,2}\.?\d*\s*%/g, m2 => m2));
    const last = amts.length ? amts[amts.length - 1] : null;
    if (RE.subtotal.test(line)) { if (last != null) out.subtotal = last; continue; }
    if (RE.wht.test(line)) { if (last != null && out.wht == null) out.wht = Math.abs(last); continue; }
    if (RE.vat.test(line)) {
      const pct = line.match(/(\d+(?:\.\d+)?)\s*%/);
      if (pct) out.vatRate = Number(pct[1]);
      if (last != null && !(amts.length === 1 && pct && /^\D*\d+(\.\d+)?\s*%\D*$/.test(line))) out.vat = last;
      continue;
    }
    if (RE.total.test(line)) { if (last != null) out.total = last; continue; }
    const item = itemFromLine(line);
    if (item) out.lines.push(item);
  }
  // fall back: first date anywhere in the text
  if (!out.date) { const m = text.match(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[\/.]\d{1,2}[\/.]\d{4}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\.?,?\s+\d{4}\b/); if (m) out.date = parseDate(m[0]); }
  return finish(out);
}

const HEADER_KEYS = {
  number: ['number', 'invoice_number', 'invoice_no', 'invoice', 'invoiceno', 'reference', 'ref'],
  poRef: ['po', 'po_number', 'po_ref', 'purchase_order'],
  date: ['date', 'invoice_date', 'issue_date'], dueDate: ['due_date', 'due'], currency: ['currency', 'ccy'],
  vendorName: ['vendor', 'vendor_name', 'supplier', 'supplier_name', 'from'],
  vat: ['vat', 'vat_amount', 'tax', 'tax_amount'], vatRate: ['vat_rate', 'tax_rate'], wht: ['wht', 'wht_amount', 'withholding_tax'], total: ['total', 'total_amount', 'grand_total'],
};
const LINE_KEYS = {
  description: ['description', 'item', 'details', 'narration', 'line'], quantity: ['qty', 'quantity'],
  unitPrice: ['unit_price', 'price', 'rate', 'unit_cost'], amount: ['amount', 'line_total', 'net', 'net_amount', 'value'], account: ['account', 'account_code', 'gl'],
};
const norm = k => String(k).trim().replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const pick = (obj, keys) => { const n = {}; for (const k of Object.keys(obj)) n[norm(k)] = obj[k]; for (const k of keys) if (n[k] != null && n[k] !== '') return n[k]; return null; };
const numOrNull = v => { if (v == null || v === '') return null; const n = toNum(String(v).replace(/[^\d.,-]/g, '')); return Number.isFinite(n) ? n : null; };

function normaliseStructured(obj, lines) {
  const out = { lines: [] };
  for (const [k, keys] of Object.entries(HEADER_KEYS)) out[k] = pick(obj, keys);
  out.date = parseDate(out.date); out.dueDate = parseDate(out.dueDate);
  if (out.currency) out.currency = String(out.currency).trim().toUpperCase();
  for (const k of ['vat', 'vatRate', 'wht', 'total']) out[k] = numOrNull(out[k]);
  for (const l of lines || []) {
    const description = pick(l, LINE_KEYS.description); if (!description) continue;
    let quantity = numOrNull(pick(l, LINE_KEYS.quantity)), unitPrice = numOrNull(pick(l, LINE_KEYS.unitPrice)), amount = numOrNull(pick(l, LINE_KEYS.amount));
    if (amount == null && quantity != null && unitPrice != null) amount = r2(quantity * unitPrice);
    if (amount == null) continue;
    if (quantity == null) quantity = 1;
    if (unitPrice == null) unitPrice = r2(amount / quantity);
    const account = numOrNull(pick(l, LINE_KEYS.account));
    out.lines.push({ description: String(description), quantity, unitPrice, amount, ...(account ? { account } : {}) });
  }
  out.number = out.number == null ? null : String(out.number); out.poRef = out.poRef == null ? null : String(out.poRef);
  out.vendorName = out.vendorName == null ? null : String(out.vendorName);
  out.subtotal = null;
  return finish(out);
}

function parseStructured(buffer, ext) {
  const text = buffer.toString('utf8');
  if (ext === '.json') {
    const j = JSON.parse(text);
    const o = Array.isArray(j) ? { lines: j } : j;
    return normaliseStructured(o, o.lines || o.items || o.line_items);
  }
  const rows = parseCsv(text);
  if (rows.length < 2) return null;
  const head = rows[0].map(norm);
  if (head.some(h => LINE_KEYS.description.includes(h)) && head.some(h => LINE_KEYS.amount.includes(h) || LINE_KEYS.unitPrice.includes(h))) {
    const objs = rows.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
    const first = objs[0];
    return normaliseStructured(first, objs);
  }
  // key,value layout
  if (head.length === 2) {
    const kv = Object.fromEntries(rows.map(r => [norm(r[0]), r[1]]));
    return normaliseStructured(kv, []);
  }
  return null;
}

function finish(o) {
  const sum = r2(o.lines.reduce((s, l) => s + l.amount, 0));
  if (o.subtotal == null && o.lines.length) o.subtotal = sum;
  if (!o.lines.length && o.total != null) {
    const net = r2(o.total - (o.vat || 0));
    o.lines.push({ description: 'Per document total', quantity: 1, unitPrice: net, amount: net, synthesised: true });
    o.subtotal = net;
  }
  if (o.vat == null && o.vatRate != null && o.subtotal != null) o.vat = r2(o.subtotal * o.vatRate / 100);
  if (o.total == null && o.subtotal != null) o.total = r2(o.subtotal + (o.vat || 0));
  return o;
}

module.exports = { parseText, parseStructured, fromObject: normaliseStructured, parseDate, detectCurrency };
