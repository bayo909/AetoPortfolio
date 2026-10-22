// Deterministic money maths. All amounts are integer minor units; quantities are integer milli-units (1000 = 1).
// The AI agent never computes totals: it proposes lines and this module (server side) prices them.
const { bad } = require('./errors');

const CURRENCIES = { NGN: 2, USD: 2, GBP: 2, GHS: 2, AUD: 2, EUR: 2 };
const SYMBOL = { NGN: '₦', USD: '$', GBP: '£', GHS: 'GH₵', AUD: 'A$', EUR: '€' };

/** round half away from zero on an exact integer ratio num/den (den > 0) */
function divRound(num, den) {
  const sign = num < 0 ? -1 : 1;
  const n = Math.abs(num);
  return sign * Math.floor((2 * n + den) / (2 * den));
}

function assertInt(v, what) {
  if (!Number.isSafeInteger(v)) throw bad(`${what} must be a whole number of minor units`);
  return v;
}

/** Price one line. discount_bp / tax_bp / wht_bp are basis points (10000 = 100%). */
function priceLine({ qty_milli, unit_price_minor, discount_bp = 0, tax_bp = 0, wht_bp = 0 }) {
  assertInt(qty_milli, 'quantity'); assertInt(unit_price_minor, 'unit price');
  if (qty_milli <= 0) throw bad('Quantity must be greater than zero');
  if (unit_price_minor < 0) throw bad('Unit price cannot be negative');
  for (const [k, v] of Object.entries({ discount_bp, tax_bp, wht_bp })) if (!Number.isInteger(v) || v < 0 || v > 10000) throw bad(`${k} must be between 0 and 10000`);
  const net = divRound(qty_milli * unit_price_minor, 1000);
  const discount = divRound(net * discount_bp, 10000);
  const taxable = net - discount;
  const tax = divRound(taxable * tax_bp, 10000);
  const wht = divRound(taxable * wht_bp, 10000);
  return { net_minor: net, discount_minor: discount, tax_minor: tax, wht_minor: wht, total_minor: taxable + tax };
}

function totals(lines) {
  const t = { subtotal_minor: 0, discount_minor: 0, tax_minor: 0, wht_minor: 0, total_minor: 0 };
  for (const l of lines) {
    t.subtotal_minor += l.net_minor; t.discount_minor += l.discount_minor; t.tax_minor += l.tax_minor;
    t.wht_minor += l.wht_minor; t.total_minor += l.total_minor;
  }
  return t;
}

/** "1,250.50" | 1250.5 -> 125050 (rejects more than 2 decimals) */
function toMinor(v) {
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw bad('Invalid amount'); v = String(v); }
  const s = String(v ?? '').replace(/[, ]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw bad(`Invalid amount "${v}"`);
  const [i, f = ''] = s.split('.');
  return Number(i) * 100 + (i.startsWith('-') ? -1 : 1) * Number(f.padEnd(2, '0'));
}
function toQtyMilli(v) {
  const s = String(v ?? '').replace(/,/g, '').trim();
  if (!/^\d+(\.\d{1,3})?$/.test(s)) throw bad(`Invalid quantity "${v}"`);
  const [i, f = ''] = s.split('.');
  const n = Number(i) * 1000 + Number(f.padEnd(3, '0'));
  if (n <= 0) throw bad('Quantity must be greater than zero');
  return n;
}
const fmt = (minor, ccy = 'NGN') => `${SYMBOL[ccy] || ccy + ' '}${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

module.exports = { CURRENCIES, divRound, priceLine, totals, toMinor, toQtyMilli, fmt };
