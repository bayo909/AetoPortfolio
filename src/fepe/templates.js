// Built-in source-document templates. `posting` decides how the RT-FEPE engine journals a document:
//   payable      Dr expense/asset (+ Input VAT)   Cr Accounts Payable (+ WHT Payable)
//   expenseClaim Dr expense (+ Input VAT)         Cr Employee Payables
//   memo         no ledger entry (commitment / supporting evidence)
const text = (key, label, required = false, extra = {}) => ({ key, label, type: 'text', required, ...extra });
const BASE_FIELDS = [
  text('number', 'Document number', true), { key: 'date', label: 'Document date', type: 'date', required: true },
  { key: 'currency', label: 'Currency', type: 'currency', required: true },
];
const TAX_FIELDS = [
  { key: 'vatRate', label: 'VAT rate %', type: 'number', required: false, default: 7.5 },
  { key: 'wht', label: 'Withholding tax amount', type: 'number', required: false },
];

const BUILT_IN = [
  {
    id: 'tpl-vendor-invoice', name: 'Vendor Invoice', sourceDocument: 'Vendor Invoice', posting: 'payable', hasLines: true,
    description: 'Invoice for goods or services supplied. Posts Dr expense / Cr Accounts Payable and becomes payable in chat.',
    fields: [...BASE_FIELDS, text('poRef', 'PO reference'), { key: 'dueDate', label: 'Due date', type: 'date' }, ...TAX_FIELDS],
  },
  {
    id: 'tpl-expense-receipt', name: 'Expense Receipt / Claim', sourceDocument: 'Expense Claim', posting: 'expenseClaim', hasLines: true,
    description: 'Receipt for expenses incurred on the buyer\'s behalf. Posts Dr expense / Cr Employee Payables.',
    fields: [...BASE_FIELDS, ...TAX_FIELDS.slice(0, 1)],
  },
  {
    id: 'tpl-purchase-order-ack', name: 'Purchase Order Acknowledgement', sourceDocument: 'Purchase Order', posting: 'memo', hasLines: true,
    description: 'Vendor confirms a purchase order. Supporting document: kept as evidence for three-way matching, no ledger entry.',
    fields: [...BASE_FIELDS.slice(0, 1), BASE_FIELDS[1], BASE_FIELDS[2], text('poRef', 'PO reference', true)],
  },
  {
    id: 'tpl-tax-exemption', name: 'Tax Exemption / Compliance Certificate', sourceDocument: 'Tax Assessment', posting: 'memo', hasLines: false,
    description: 'Tax clearance, exemption or compliance certificate. Supporting document: stored with the audit trail.',
    fields: [text('number', 'Certificate number', true), { key: 'date', label: 'Issue date', type: 'date', required: true }, { key: 'expiry', label: 'Expiry date', type: 'date' }, text('issuer', 'Issuing authority')],
  },
];

function builtIns() { return BUILT_IN.map(t => ({ ...t, builtIn: true })); }

module.exports = { builtIns, BUILT_IN };
