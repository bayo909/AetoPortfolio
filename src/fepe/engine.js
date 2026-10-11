// RT-FEPE: ingest a submitted document, extract it, validate it, map it to the Chart of Accounts and
// draft a balanced double-entry journal -- all at the point of origin, before anything is posted.
const path = require('path');
const crypto = require('crypto');
const { extractLines } = require('../extract');
const { matchLines } = require('../matcher');
const parse = require('./parse');
const coa = require('./coa');
const { rateFor, r2 } = require('./fx');
const { parseCsv } = require('../csv');

const TEXT_EXT = ['.txt', '.md', '.pdf', '.docx'];
const STRUCTURED_EXT = ['.csv', '.json'];
const IMAGE_EXT = ['.png', '.jpg', '.jpeg'];
const ALLOWED_EXT = [...TEXT_EXT, ...STRUCTURED_EXT, ...IMAGE_EXT];

const flag = (code, severity, message) => ({ code, severity, message });
const normNumber = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const words = s => new Set(String(s || '').toLowerCase().replace(/\b(ltd|limited|plc|inc|llc|co|company|nigeria|the|and)\b/g, ' ').split(/[^a-z0-9]+/).filter(w => w.length > 2));

async function extractFrom(input, template, ocr) {
  if (input.kind === 'form') {
    const f = input.form || {};
    const header = { ...f.fields };
    return { method: 'form', extracted: parse.fromObject(header, f.lines || []), notes: [] };
  }
  const ext = path.extname(input.name || '').toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) throw Object.assign(new Error(`Unsupported file type "${ext}". Upload ${ALLOWED_EXT.join(', ')} or fill the template form.`), { status: 415 });
  if (STRUCTURED_EXT.includes(ext)) {
    let ex = null;
    try { ex = parse.parseStructured(input.buffer, ext); } catch { throw Object.assign(new Error(`The ${ext.slice(1).toUpperCase()} file could not be parsed.`), { status: 422 }); }
    if (ex) return { method: 'structured', extracted: ex, notes: [] };
    if (ext === '.json') throw Object.assign(new Error('The JSON file has no recognisable fields.'), { status: 422 });
  }
  if (IMAGE_EXT.includes(ext)) {
    const txt = ocr ? await ocr(input.buffer, ext) : null;
    if (!txt) return { method: 'image-no-ocr', extracted: parse.parseText([]), notes: ['No OCR engine is configured: the image is stored as evidence but nothing was read from it.'] };
    return { method: 'ocr', extracted: parse.parseText(txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean)), notes: [] };
  }
  const lines = await extractLines(input.buffer, input.name);
  return { method: 'text', extracted: parse.parseText(lines.map(l => l.text)), textLines: lines.map(l => l.text), notes: [] };
}

// Values for template fields the parser doesn't know about (custom fields added by the buyer).
function customValues(template, input, textLines, ext) {
  const custom = template.fields.filter(f => f.custom);
  if (!custom.length) return {};
  const out = {};
  let raw = {};
  if (input.kind === 'form') raw = (input.form && input.form.fields) || {};
  else if (ext === '.json') { try { raw = JSON.parse(input.buffer.toString('utf8')); } catch { raw = {}; } }
  else if (ext === '.csv') { const rows = parseCsv(input.buffer.toString('utf8')); if (rows.length > 1) raw = Object.fromEntries(rows[0].map((k, i) => [k.trim(), rows[1][i]])); }
  const key = k => String(k).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const rawByKey = Object.fromEntries(Object.entries(raw).map(([k, v]) => [key(k), v]));
  for (const f of custom) {
    let v = rawByKey[key(f.key)] ?? rawByKey[key(f.label)];
    if (v == null && textLines) {
      const esc = f.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const line of textLines) { const m = line.match(new RegExp(`^\\s*${esc}\\s*[:#\\-]\\s*(.+)$`, 'i')); if (m) { v = m[1].trim(); break; } }
    }
    if (v != null && String(v).trim() !== '') out[f.key] = String(v).trim().slice(0, 200);
  }
  return out;
}

function toBase(rows, rate) {
  const out = rows.map(r => ({ ...r, base: r2(r.amount * rate) }));
  const sum = side => r2(out.filter(r => r.side === side).reduce((s, r) => s + r.base, 0));
  const diff = r2(sum('D') - sum('C'));
  if (diff !== 0) {
    // rounding residue from converting each line separately: park it on the largest line of the short side
    const short = diff > 0 ? 'C' : 'D';
    const target = out.filter(r => r.side === short).sort((a, b) => b.base - a.base)[0];
    if (!target || Math.abs(diff) > 0.05 * out.length) throw new Error('Journal cannot be balanced after currency conversion');
    target.base = r2(target.base + Math.abs(diff));
  }
  return out;
}

function buildJournal(ex, template, rate, flags) {
  const lines = ex.lines.filter(l => l.amount);
  const rows = [];
  const allowed = template.posting === 'expenseClaim' ? coa.ALLOWED.expenseClaim : coa.ALLOWED.payable;
  lines.forEach((l, i) => {
    let code, confident = true;
    if (l.account != null) {
      if (allowed(Number(l.account)) && coa.account(l.account)) code = Number(l.account);
      else flags.push(flag('unauthorized_mapping', 'block', `Line ${i + 1} asks for account ${l.account}, which this document type may not be posted to.`));
    }
    if (!code) ({ code, confident } = coa.classify(l.description));
    if (!confident) flags.push(flag('low_confidence_classification', 'info', `Line ${i + 1} "${l.description}" has no clear category; defaulted to ${coa.account(code).name}. Reclassify when accepting if needed.`));
    l.mappedAccount = code;
    rows.push({ side: 'D', code, amount: l.amount, memo: l.description });
  });
  const vat = ex.vat || 0, wht = ex.wht || 0, total = r2(lines.reduce((s, l) => s + l.amount, 0) + vat);
  if (vat) rows.push({ side: 'D', code: coa.INPUT_VAT, amount: vat, memo: 'Input VAT' });
  if (template.posting === 'payable') {
    rows.push({ side: 'C', code: coa.AP, amount: r2(total - wht), memo: 'Amount payable to vendor' });
    if (wht) rows.push({ side: 'C', code: coa.WHT, amount: wht, memo: 'Withholding tax deducted' });
  } else rows.push({ side: 'C', code: coa.EMPLOYEE_PAYABLE, amount: total, memo: 'Reimbursement liability' });
  const based = toBase(rows, rate);
  return based.map(r => {
    const a = coa.account(r.code);
    return { code: r.code, name: a.name, memo: r.memo, docAmount: r.amount, debit: r.side === 'D' ? r.base : 0, credit: r.side === 'C' ? r.base : 0 };
  });
}

/**
 * @param {object} p { template, input, vendorOrgName, today, rates, history, ocr, master, largeAmountUsd }
 *   history: prior non-rejected submissions of the same vendor: [{ number, totalBase, date, sha256 }]
 */
async function process(p) {
  const { template, input, today, rates, history = [], master, largeAmountUsd = 50000 } = p;
  const flags = [];
  const sha256 = input.kind === 'file' ? crypto.createHash('sha256').update(input.buffer).digest('hex') : null;
  const { method, extracted: ex, textLines, notes } = await extractFrom(input, template, p.ocr);
  ex.custom = customValues(template, input, textLines, input.kind === 'file' ? path.extname(input.name || '').toLowerCase() : null);
  notes.forEach(n => flags.push(flag('no_ocr', 'block', n)));
  const result = { method, sha256, extracted: ex, journal: null, event: null, flags, confidence: 0, base: { currency: 'USD', rate: null, total: null } };

  // required template fields
  for (const f of template.fields.filter(f => f.required)) {
    const v = f.custom ? ex.custom[f.key] : ex[f.key];
    if (v == null || v === '') flags.push(flag('missing_field', 'block', `${f.label} was not found in the document.`));
  }
  if (template.hasLines && !ex.lines.length && method !== 'image-no-ocr') flags.push(flag('missing_field', 'block', 'No amount or line items were found in the document.'));
  if (template.posting === 'memo') {
    result.confidence = confidence(ex, method);
    if (ex.date && ex.date > today && template.id !== 'tpl-tax-exemption') flags.push(flag('future_date', 'warn', `Document date ${ex.date} is in the future.`));
    if (sha256) duplicate(flags, ex, history, sha256, null);
    return result;
  }

  // arithmetic
  const sum = r2(ex.lines.reduce((s, l) => s + l.amount, 0));
  if (ex.lines.length && !ex.lines.some(l => l.synthesised)) {
    if (ex.subtotal != null && Math.abs(ex.subtotal - sum) > 0.01) flags.push(flag('total_mismatch', 'block', `Subtotal ${ex.subtotal.toFixed(2)} does not equal the sum of line items ${sum.toFixed(2)}.`));
    const expected = r2(sum + (ex.vat || 0));
    if (ex.total != null && Math.abs(ex.total - expected) > 0.01) flags.push(flag('total_mismatch', 'block', `Stated total ${ex.total.toFixed(2)} does not equal line items plus VAT (${expected.toFixed(2)}).`));
    ex.lines.forEach((l, i) => { if (Math.abs(r2(l.quantity * l.unitPrice) - l.amount) > 0.01) flags.push(flag('line_math', 'warn', `Line ${i + 1}: quantity × unit price is ${r2(l.quantity * l.unitPrice).toFixed(2)}, document says ${l.amount.toFixed(2)}.`)); });
  }
  const grossAfterVat = r2(sum + (ex.vat || 0));
  if (ex.wht && ex.wht > grossAfterVat) flags.push(flag('wht_exceeds', 'block', 'Withholding tax is larger than the invoice total.'));
  if (ex.lines.some(l => l.amount < 0) || grossAfterVat <= 0) flags.push(flag('non_positive', 'block', 'Amounts must be positive. Credit notes are not supported in this version.'));

  // currency + date sanity
  const rate = ex.currency ? rateFor(ex.currency, rates) : null;
  if (!ex.currency) flags.push(flag('missing_field', 'block', 'Currency was not found in the document.'));
  else if (!rate) flags.push(flag('unknown_currency', 'block', `No USD conversion rate is configured for ${ex.currency}.`));
  if (ex.date && ex.date > today) flags.push(flag('future_date', 'warn', `Document date ${ex.date} is in the future.`));
  if (ex.date && ex.date < new Date(Date.parse(today) - 365 * 864e5).toISOString().slice(0, 10)) flags.push(flag('stale_date', 'warn', `Document date ${ex.date} is more than a year old.`));
  if (ex.vendorName && p.vendorOrgName) {
    const a = words(ex.vendorName), b = words(p.vendorOrgName);
    if (a.size && b.size && ![...a].some(w => b.has(w))) flags.push(flag('vendor_name_mismatch', 'warn', `Document is issued by "${ex.vendorName}" but was submitted by ${p.vendorOrgName}.`));
  }

  if (rate && ex.lines.length && grossAfterVat > 0 && !flags.some(f => f.code === 'non_positive')) {
    result.journal = buildJournal(ex, template, rate, flags);
    result.base = { currency: 'USD', rate, total: r2(result.journal.reduce((s, l) => s + l.debit, 0)) };
    const apLine = result.journal.find(l => l.code === coa.AP || l.code === coa.EMPLOYEE_PAYABLE);
    result.base.payable = apLine ? apLine.credit : 0;
    if (result.base.total > largeAmountUsd) flags.push(flag('large_amount', 'warn', `Amount is USD ${result.base.total.toLocaleString('en-US')}, above the USD ${largeAmountUsd.toLocaleString('en-US')} review threshold.`));
    const prior = history.map(h => h.totalBase).filter(n => n > 0);
    if (prior.length >= 3) {
      const mean = prior.reduce((s, n) => s + n, 0) / prior.length;
      if (result.base.total > 3 * mean) flags.push(flag('unusual_amount', 'warn', `Amount is ${(result.base.total / mean).toFixed(1)}× this vendor's average (USD ${mean.toFixed(2)} over ${prior.length} documents).`));
    }
  }
  duplicate(flags, ex, history, sha256, result.base.total);

  if (master && ex.lines.length) {
    const m = matchLines(ex.lines.slice(0, 1).map((l, i) => ({ n: i + 1, text: `${template.sourceDocument} ${l.description}` })), master.rows, template.sourceDocument)[0];
    if (m && m.matched) result.event = { sourceDocument: template.sourceDocument, financialEvent: m.best.row.financialEvent, phrase: m.best.row.phrase, journalTemplate: m.best.row.journalEntry, score: m.best.score };
  }
  result.confidence = confidence(ex, method);
  result.textLines = textLines;
  return result;
}

function duplicate(flags, ex, history, sha256, totalBase) {
  const n = normNumber(ex.number);
  if (sha256 && history.some(h => h.sha256 === sha256)) flags.push(flag('duplicate_invoice', 'block', 'This exact file was already submitted by this vendor.'));
  else if (n && history.some(h => normNumber(h.number) === n)) flags.push(flag('duplicate_invoice', 'block', `Document number ${ex.number} was already submitted by this vendor.`));
  else if (totalBase && ex.date && history.some(h => h.totalBase === totalBase && h.date === ex.date)) flags.push(flag('possible_duplicate', 'block', 'A document with the same date and amount was already submitted by this vendor.'));
}

function confidence(ex, method) {
  if (method === 'form') return 1;
  const have = [ex.number, ex.date, ex.currency, ex.total, ex.vendorName, ex.lines.length && !ex.lines.every(l => l.synthesised)].filter(Boolean).length;
  return Math.round((have / 6) * 100) / 100;
}

const blocking = flags => flags.filter(f => f.severity === 'block');

/** Re-draft the journal after an accountant reclassifies lines (l.account set by the caller). */
function rebuildJournal(ex, template, rate) {
  const flags = [];
  const journal = buildJournal(ex, template, rate, flags);
  return { journal, flags };
}

module.exports = { process, rebuildJournal, ALLOWED_EXT, blocking, normNumber, toBase };
