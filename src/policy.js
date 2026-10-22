// PayUno Enterprise Finance & Operations Policy: chunk store + the rules coded from it.
const fs = require('fs');
const path = require('path');

const POLICY_FILE = path.join(__dirname, '..', 'data', 'PayUno_Finance_Operations_Policy.docx');

/** Splits extracted policy text into its "CHUNK nnn — title" sections, keyed by Chunk ID. */
function parseChunks(value) {
  const chunks = {};
  const parts = value.split(/\n(?=CHUNK \d{3} — )/);
  for (const p of parts) {
    const head = p.match(/^CHUNK (\d{3}) — (.+)/);
    const id = p.match(/Chunk ID:\s*([A-Z]+(?:-[A-Z]+)*-\d{3})/);
    if (!head || !id) continue;
    const body = p.split('\n').slice(1).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    chunks[id[1]] = { id: id[1], number: head[1], title: head[2].trim(), text: body };
  }
  return chunks;
}

async function loadPolicyChunks(file = POLICY_FILE) {
  if (!fs.existsSync(file)) return {};
  const mammoth = require('mammoth');
  const { value } = await mammoth.extractRawText({ path: file });
  return parseChunks(value);
}

// FIN-POL-001: approval thresholds (NGN)
const APPROVAL_TIERS = [
  { max: 100000, roles: ['Department Manager'] },
  { max: 500000, roles: ['Department Manager', 'Finance'] },
  { max: 2000000, roles: ['Head of Department', 'Finance Manager'] },
  { max: 10000000, roles: ['CFO', 'Business Unit Head'] },
  { max: Infinity, roles: ['CFO', 'CEO / Executive Committee'] },
];

// FIN-POL-001: additional approval categories, keyed by master-data source document.
const ADDITIONAL_APPROVAL = {
  'Payroll File': 'Employee compensation',
  'Tax Assessment': 'Tax / regulatory payment',
  'Loan Agreement': 'Contractual commitment',
  'Contract': 'Contractual commitment',
  'Purchase Order': 'Contractual commitment',
};

const COMPANY = { name: 'Apex Insurance & Financial Services Ltd.', address: 'Lagos, Nigeria', currency: 'NGN' }; // policy document header

const LOW_CONFIDENCE = 0.7; // RAG-CTRL-001: below this the line is routed to a Finance Reviewer for explicit acknowledgement

const THREE_WAY_CHECKS = ['Supplier', 'Quantity', 'Price', 'Description', 'Tax treatment', 'Currency']; // PROC-CTRL-001
const VENDOR_CHECKS = ['Vendor identity', 'Tax information', 'Banking information', 'Contract or quotation', 'Delivery terms']; // PROC-POL-001

function approvalTier(total) {
  return APPROVAL_TIERS.find(t => total <= t.max);
}

function requiredApprovals(total, sourceDocument) {
  const roles = approvalTier(total).roles.map(role => ({ role, reason: 'Amount threshold (FIN-POL-001)' }));
  const extra = ADDITIONAL_APPROVAL[sourceDocument];
  if (extra) roles.push({ role: 'Additional Approver', reason: `${extra} (FIN-POL-001)` });
  return roles;
}

/** Business days between two ISO dates (excludes Sat/Sun). */
function businessDaysBetween(fromIso, toIso) {
  let d = new Date(fromIso + 'T00:00:00Z');
  const end = new Date(toIso + 'T00:00:00Z');
  let n = 0;
  while (d < end) {
    d = new Date(d.getTime() + 86400000);
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) n++;
  }
  return n;
}

module.exports = {
  loadPolicyChunks, parseChunks, approvalTier, requiredApprovals, businessDaysBetween,
  COMPANY, LOW_CONFIDENCE, THREE_WAY_CHECKS, VENDOR_CHECKS, APPROVAL_TIERS, ADDITIONAL_APPROVAL,
};
