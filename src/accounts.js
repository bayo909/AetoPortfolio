// Chart of Accounts (policy chunks COA-001..COA-OPEX-001) and mapping of the
// account names used in Financial Master Data to COA codes.
const RANGES = {
  asset: [1000, 1999, 'Assets'], liability: [2000, 2999, 'Liabilities'], equity: [3000, 3999, 'Equity'],
  revenue: [4000, 4999, 'Insurance Revenue'], claims: [5000, 5999, 'Claims & Direct Costs'],
  opex: [6000, 6999, 'Operating Expenses'], otherIncome: [7000, 7999, 'Other Income'],
  otherExpense: [8000, 8999, 'Other Expenses'], memo: null,
};

const A = (code, type, coaName, note) => ({ code, type, coaName, note });
const U = type => ({ code: null, type });

// code === null -> the policy COA has no specific account; Finance Reviewer assigns one within the range.
const ACCOUNT_MAP = {
  'Bank': A(1100, 'asset', 'Operating Bank'),
  'Cash': A(1110, 'asset', 'Petty Cash'),
  'Accounts Receivable': A(1200, 'asset', 'Accounts Receivable'),
  'Prepaid Expense': A(1300, 'asset', 'Prepaid Expenses'),
  'Inventory': A(1400, 'asset', 'Inventory'),
  'Raw Material Inventory': A(1400, 'asset', 'Inventory'),
  'Retention Receivable': U('asset'),
  'Accounts Payable': A(2110, 'liability', 'Vendor Payables'),
  'Employee Payable': A(2200, 'liability', 'Employee Payables'),
  'Salary Payable': A(2200, 'liability', 'Employee Payables'),
  'Tax Payable': A(2300, 'liability', 'Tax Payable'),
  'PAYE Payable': A(2300, 'liability', 'Tax Payable'),
  'Income Tax Payable': A(2300, 'liability', 'Tax Payable'),
  'VAT Payable': A(2310, 'liability', 'VAT Payable'),
  'Input VAT': A(2310, 'liability', 'VAT Payable', 'COA has no Input VAT account; recoverable VAT is netted in 2310'),
  'WHT Payable': A(2320, 'liability', 'Withholding Tax Payable'),
  'GRNI Liability': A(2400, 'liability', 'Accrued Expenses'),
  'Deferred Revenue': A(2600, 'liability', 'Unearned Insurance Revenue'),
  'Pension Payable': U('liability'),
  'Loan Payable': U('liability'),
  'Interest Payable': U('liability'),
  'Sales Revenue': U('revenue'), 'Service Revenue': U('revenue'), 'Revenue': U('revenue'), 'Contract Revenue': U('revenue'),
  'Sales Discounts': U('revenue'), 'Sales Returns': U('revenue'),
  'Salary Expense': A(6100, 'opex', 'Salaries and Wages'),
  'Utility Expense': A(6300, 'opex', 'Utilities'),
  'Travel Expense': A(6400, 'opex', 'Travel'),
  'Professional Fee Expense': A(6500, 'opex', 'Professional Fees'),
  'Expense': U('opex'), 'VAT Expense': U('opex'),
  'Inventory Loss Expense': U('opex'), 'Inventory Write-off Expense': U('opex'),
  'Interest Income': U('otherIncome'), 'Inventory Gain': U('otherIncome'),
  'Bank Charges Expense': U('otherExpense'), 'Interest Expense': U('otherExpense'),
  'Income Tax Expense': U('otherExpense'), 'Tax Penalty Expense': U('otherExpense'),
  'Encumbrance': U('memo'), 'Budget Reserve': U('memo'),
};

function resolveAccount(name, overrides = {}) {
  const base = ACCOUNT_MAP[name] || U('opex');
  const range = RANGES[base.type];
  const override = overrides[name];
  const code = base.code || (override ? Number(override) : null);
  return {
    name, type: base.type, code, coaName: base.coaName || null, note: base.note || null,
    memo: base.type === 'memo',
    needsCode: base.type !== 'memo' && !code,
    range: range ? { from: range[0], to: range[1], label: range[2] } : null,
  };
}

function validateOverride(name, code) {
  const base = ACCOUNT_MAP[name] || U('opex');
  const range = RANGES[base.type];
  if (!range) return null;
  const n = Number(code);
  if (!Number.isInteger(n) || n < range[0] || n > range[1]) return `${name}: code must be ${range[0]}–${range[1]} (${range[2]})`;
  return null;
}

module.exports = { ACCOUNT_MAP, RANGES, resolveAccount, validateOverride };
