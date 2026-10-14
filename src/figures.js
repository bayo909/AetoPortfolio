// Illustrative ("fictitious") figures for lines generated from unstructured documents.
// Deterministic: the same sentence always gets the same figures, so reprocessing is stable.
const { taxApplicability } = require('./workflow');

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// [min, max, rounding] in NGN by debit account of the event
const RANGES = {
  'Travel Expense': [30000, 250000, 500],
  'Professional Fee Expense': [250000, 1500000, 5000],
  'Utility Expense': [40000, 300000, 500],
  'Inventory': [150000, 2000000, 5000],
  'Accounts Payable': [100000, 2000000, 5000],
  'Prepaid Expense': [200000, 1000000, 5000],
  'Expense': [50000, 500000, 500],
  'Salary Expense': [500000, 5000000, 5000],
};
const DEFAULT_RANGE = [50000, 500000, 500];
const VAT_TYPES = ['Vendor Invoice', 'Customer Invoice', 'Sales Invoice'];

function fictitiousFigures(seed, row) {
  const [min, max, step] = RANGES[row.debitAccount] || DEFAULT_RANGE;
  const h = hash(`${seed}|${row.financialEvent}`);
  const unit = Math.round((min + (h % 10000) / 10000 * (max - min)) / step) * step;
  const tax = taxApplicability(row);
  const vat = tax.vat && VAT_TYPES.includes(row.sourceDocument) ? Math.round(unit * 0.075 * 100) / 100 : 0; // 7.5% as in policy TAX-EVT-001
  const wht = tax.wht && row.sourceDocument === 'Vendor Invoice' && row.debitAccount === 'Professional Fee Expense' ? Math.round(unit * 0.05 * 100) / 100 : 0; // 5% as in TAX-EVT-002
  return { quantity: '1', unitPrice: String(unit), vat: vat ? String(vat) : '', wht: wht ? String(wht) : '' };
}

module.exports = { fictitiousFigures };
