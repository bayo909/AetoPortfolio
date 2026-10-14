const test = require('node:test');
const assert = require('node:assert');
const { loadMasterData } = require('../src/masterData');
const { matchLines, tokenize } = require('../src/matcher');

const master = loadMasterData();

test('master data loads the 44 master events plus the supplemental Quote event', () => {
  assert.strictEqual(master.rows.length, 45);
  assert.strictEqual(master.sourceDocuments.length, 14);
});

test('tokenizer folds synonyms and inflections', () => {
  assert.deepStrictEqual(tokenize('Supplier invoice settled'), tokenize('vendor invoices settlement'));
});

test('exact high frequency phrase matches with full confidence', () => {
  const [m] = matchLines([{ n: 1, text: 'Utility bill received for head office' }], master.rows, 'Vendor Invoice');
  assert.strictEqual(m.matched, true);
  assert.strictEqual(m.best.row.financialEvent, 'Utility Expense');
  assert.strictEqual(m.best.score, 1);
});

test('financial event wording also matches (lower confidence)', () => {
  const [m] = matchLines([{ n: 1, text: 'Vendor payment for cybersecurity' }], master.rows, 'Payment Voucher');
  assert.strictEqual(m.best.row.financialEvent, 'Vendor Payment');
  assert.ok(m.best.score >= 0.5 && m.best.score < 1);
});

test('matching is scoped to the selected source document', () => {
  const [m] = matchLines([{ n: 1, text: 'Utility bill received' }], master.rows, 'Payment Voucher');
  assert.strictEqual(m.matched, false);
});

test('unrelated text is unmatched', () => {
  const [m] = matchLines([{ n: 1, text: 'Staff team lunch' }], master.rows, 'Vendor Invoice');
  assert.strictEqual(m.matched, false);
});
