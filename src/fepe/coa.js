// Chart of Accounts used by the RT-FEPE engine. Codes follow the PayUno policy COA ranges
// (src/accounts.js); accounts the policy does not name get a default code inside the right range.
const COA = [
  [1100, 'Operating Bank', 'asset'], [1110, 'Petty Cash', 'asset'], [1200, 'Accounts Receivable', 'asset'],
  [1300, 'Prepaid Expenses', 'asset'], [1350, 'Input VAT Receivable', 'asset'], [1400, 'Inventory', 'asset'],
  [1500, 'Property, Plant & Equipment', 'asset'],
  [2110, 'Accounts Payable', 'liability'], [2200, 'Employee Payables', 'liability'], [2300, 'Tax Payable', 'liability'],
  [2310, 'VAT Payable', 'liability'], [2320, 'Withholding Tax Payable', 'liability'], [2400, 'Accrued Expenses', 'liability'],
  [4000, 'Sales Revenue', 'revenue'],
  [6100, 'Salaries and Wages', 'expense'], [6200, 'Office Supplies & Printing', 'expense'], [6300, 'Utilities', 'expense'],
  [6400, 'Travel', 'expense'], [6500, 'Professional Fees', 'expense'], [6600, 'IT, Software & Security', 'expense'],
  [6700, 'Rent & Leases', 'expense'], [6750, 'Marketing', 'expense'], [6800, 'Repairs & Maintenance', 'expense'],
  [6900, 'General & Administrative', 'expense'],
];
const BY_CODE = new Map(COA.map(([code, name, type]) => [code, { code, name, type }]));

const account = code => BY_CODE.get(Number(code)) || null;
const accounts = () => [...BY_CODE.values()];

// Keyword -> expense/asset account. First match wins; order matters (specific before generic).
const CATEGORIES = [
  [/\b(laptop|furniture|equipment|machine|machinery|vehicle|generator|server hardware)s?\b/i, 1500],
  [/\b(goods for resale|stock|inventory|raw material|materials)\b/i, 1400],
  [/\b(electricity|power|water|internet|broadband|utility|utilities|diesel)\b/i, 6300],
  [/\b(flight|airfare|hotel|accommodation|taxi|uber|travel|mileage|per diem|fuel)\b/i, 6400],
  [/\b(legal|audit|advisory|consult\w*|professional|accounting|tax advice|counsel)\b/i, 6500],
  [/\b(software|subscription|licen[cs]e|saas|cloud|hosting|domain|cyber\w*|security|monitoring|it support)\b/i, 6600],
  [/\b(rent|lease|tenancy)\b/i, 6700],
  [/\b(advert\w*|marketing|campaign|sponsorship)\b/i, 6750],
  [/\b(repair\w*|maintenance|servicing)\b/i, 6800],
  [/\b(stationery|printing|supplies|toner|office)\b/i, 6200],
];

function classify(description) {
  for (const [re, code] of CATEGORIES) if (re.test(description)) return { code, confident: true };
  return { code: 6900, confident: false };
}

// Which accounts a line of each posting kind may be debited to (unauthorized-mapping control).
const ALLOWED = { payable: c => (c >= 6000 && c <= 6999) || [1300, 1400, 1500].includes(c), expenseClaim: c => c >= 6000 && c <= 6999 };

module.exports = { COA, account, accounts, classify, ALLOWED, AP: 2110, BANK: 1100, INPUT_VAT: 1350, WHT: 2320, EMPLOYEE_PAYABLE: 2200 };
