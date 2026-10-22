// Authentication: scrypt password hashes, random generated passwords, server-side sessions, login profiles.
const crypto = require('crypto');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
// no 0/O/1/l/I so a printed password can be typed without guessing
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generatePassword(length = 14) {
  let out = '';
  while (out.length < length) { const b = crypto.randomBytes(1)[0]; if (b < 256 - (256 % ALPHABET.length)) out += ALPHABET[b % ALPHABET.length]; }
  return out;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [alg, saltHex, hashHex] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Buyer = company staff. Each buyer login carries the policy roles it may act as (FIN-POL-001 / FIN-POL-002).
const BUYERS = [
  { username: 'admin', name: 'System Admin', approvalRoles: ['Admin'], title: 'System Administrator' }, // manages parties and vendor logins; cannot approve or pay
  { username: 'ada.preparer', name: 'Ada Preparer', approvalRoles: ['Preparer'], title: 'Accounts Payable Officer' },
  { username: 'tunde.preparer', name: 'Tunde Preparer', approvalRoles: ['Preparer'], title: 'Procurement Officer' },
  { username: 'dept.manager', name: 'Dayo Manager', approvalRoles: ['Department Manager'], title: 'Department Manager' },
  { username: 'finance.officer', name: 'Funmi Officer', approvalRoles: ['Finance'], title: 'Finance Officer' },
  { username: 'head.dept', name: 'Hauwa Head', approvalRoles: ['Head of Department'], title: 'Head of Department' },
  { username: 'finance.manager', name: 'Femi Manager', approvalRoles: ['Finance Manager'], title: 'Finance Manager' },
  { username: 'bu.head', name: 'Bola Unit', approvalRoles: ['Business Unit Head'], title: 'Business Unit Head' },
  { username: 'cfo', name: 'Chidi Okeke', approvalRoles: ['CFO'], title: 'Chief Financial Officer' },
  { username: 'ceo', name: 'Efe Adebayo', approvalRoles: ['CEO / Executive Committee'], title: 'Chief Executive Officer' },
  { username: 'extra.approver', name: 'Ali Reviewer', approvalRoles: ['Additional Approver'], title: 'Additional Approver' },
  { username: 'finance.reviewer', name: 'Rita Reviewer', approvalRoles: ['Finance Reviewer'], title: 'Finance Reviewer' },
  { username: 'payment.processor', name: 'Pat Processor', approvalRoles: ['Payment Processor'], title: 'Payment Processor' },
];

const slug = s => s.toLowerCase().replace(/&/g, ' and ').replace(/\b(ltd|limited|plc|nigeria)\b/g, ' ').replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');

/** Builds the login profile list: all buyers + one vendor login per vendor party. */
function buildProfiles(parties) {
  const buyers = BUYERS.map(b => ({ ...b, role: 'buyer', partyId: null }));
  const vendors = parties.filter(p => p.kind === 'vendor').map(p => ({
    username: slug(p.name), name: p.name, role: 'vendor', partyId: p.id, approvalRoles: [], title: 'Vendor',
  }));
  return [...buyers, ...vendors];
}

/** Failed-login throttle: 5 failures per key within 10 minutes locks that key until the window passes. */
function createThrottle({ max = 5, windowMs = 10 * 60 * 1000, now = Date.now } = {}) {
  const fails = new Map();
  const recent = k => (fails.get(k) || []).filter(t => now() - t < windowMs);
  return {
    blocked: k => recent(k).length >= max,
    fail: k => fails.set(k, [...recent(k), now()]),
    clear: k => fails.delete(k),
  };
}

module.exports = { SESSION_TTL_MS, sha, generatePassword, hashPassword, verifyPassword, buildProfiles, createThrottle, BUYERS };
