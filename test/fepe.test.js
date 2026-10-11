const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const engine = require('../src/fepe/engine');
const audit = require('../src/fepe/audit');
const { builtIns } = require('../src/fepe/templates');
const { loadRates } = require('../src/fepe/fx');
const { loadMasterData } = require('../src/masterData');

const rates = loadRates({});
const master = loadMasterData();
const invoiceTpl = builtIns().find(t => t.sourceDocument === 'Vendor Invoice');
const sample = f => fs.readFileSync(path.join(__dirname, '..', 'samples', 'invoices', f));
const run = (name, buffer, extra = {}) => engine.process({ template: invoiceTpl, input: { kind: 'file', name, buffer }, today: '2026-10-11', rates, master, vendorOrgName: 'SecureTech Nigeria Ltd', ...extra });
const sum = (j, k) => Math.round(j.reduce((a, l) => a + l[k], 0) * 100) / 100;

test('extracts an unstructured invoice and drafts a balanced USD journal', async () => {
  const r = await run('inv.txt', sample('securetech_invoice_0042.txt'));
  const ex = r.extracted;
  assert.equal(ex.number, 'INV-2026-0042');
  assert.equal(ex.date, '2026-09-12');
  assert.equal(ex.currency, 'NGN');
  assert.equal(ex.lines.length, 2);
  assert.equal(ex.total, 1827500);
  assert.equal(ex.wht, 85000);
  assert.deepEqual(engine.blocking(r.flags), []);
  assert.equal(sum(r.journal, 'debit'), sum(r.journal, 'credit'));
  const ap = r.journal.find(l => l.code === 2110), wht = r.journal.find(l => l.code === 2320), vat = r.journal.find(l => l.code === 1350);
  assert.ok(ap.credit > 0 && wht.credit > 0 && vat.debit > 0);
  assert.equal(r.journal.find(l => l.code === 6600).debit, 780); // 1,200,000 NGN * 0.00065
  assert.equal(r.base.currency, 'USD');
});

test('flags a total that does not equal the line items', async () => {
  const r = await run('bad.txt', sample('securetech_invoice_wrong_total.txt'));
  assert.ok(r.flags.some(f => f.code === 'total_mismatch' && f.severity === 'block'));
});

test('reads structured CSV and JSON', async () => {
  const csv = await run('o.csv', sample('okafor_legal_advisory.csv'), { vendorOrgName: 'Okafor & Partners' });
  assert.equal(csv.method, 'structured');
  assert.equal(csv.extracted.lines.length, 2);
  assert.equal(csv.extracted.vat, 115875);
  assert.equal(csv.extracted.total, 1660875);
  assert.deepEqual(engine.blocking(csv.flags), []);
  const json = await run('o.json', sample('okafor_utility_receipt.json'), { vendorOrgName: 'Okafor & Partners' });
  assert.equal(json.extracted.currency, 'USD');
  assert.equal(json.journal.filter(l => l.code === 6400).reduce((a, l) => a + l.debit, 0), 550);
  assert.equal(sum(json.journal, 'debit'), sum(json.journal, 'credit'));
});

test('detects duplicates by number and by file hash', async () => {
  const buf = sample('securetech_invoice_0042.txt');
  const first = await run('inv.txt', buf);
  const hist = [{ number: 'INV-2026-0042', totalBase: first.base.total, date: '2026-09-12', sha256: first.sha256 }];
  const again = await run('copy.txt', buf, { history: hist });
  assert.ok(again.flags.some(f => f.code === 'duplicate_invoice'));
  const renumbered = await run('x.txt', Buffer.from(buf.toString().replace('Qty', 'Qty ')), { history: [{ ...hist[0], sha256: 'other' }] });
  assert.ok(renumbered.flags.some(f => f.code === 'duplicate_invoice'));
});

test('flags unusual amounts, unknown currencies and unauthorised account mapping', async () => {
  const hist = [1, 2, 3].map(i => ({ number: `H${i}`, totalBase: 100, date: `2026-0${i}-01`, sha256: `h${i}` }));
  const big = await engine.process({ template: invoiceTpl, input: { kind: 'form', form: { fields: { number: 'B1', date: '2026-10-01', currency: 'USD' }, lines: [{ description: 'Consulting', amount: 5000 }] } }, today: '2026-10-11', rates, history: hist });
  assert.ok(big.flags.some(f => f.code === 'unusual_amount'));
  const fx = await engine.process({ template: invoiceTpl, input: { kind: 'form', form: { fields: { number: 'B2', date: '2026-10-01', currency: 'XXX' }, lines: [{ description: 'Consulting', amount: 50 }] } }, today: '2026-10-11', rates });
  assert.ok(fx.flags.some(f => f.code === 'unknown_currency'));
  const bad = await engine.process({ template: invoiceTpl, input: { kind: 'file', name: 'a.csv', buffer: Buffer.from('invoice_number,date,currency,description,amount,account\nZ1,2026-10-01,USD,Consulting,100,1100\n') }, today: '2026-10-11', rates });
  assert.ok(bad.flags.some(f => f.code === 'unauthorized_mapping'));
});

test('images without an OCR engine are stored but not guessed at', async () => {
  const r = await run('scan.png', Buffer.from([137, 80, 78, 71]));
  assert.equal(r.method, 'image-no-ocr');
  assert.ok(r.flags.some(f => f.code === 'no_ocr'));
  const withOcr = await run('scan.png', Buffer.from([137, 80, 78, 71]), { ocr: async () => 'Invoice No: S-1\nDate: 2026-10-01\nCurrency: USD\nConsulting work 200.00\nTotal: 200.00' });
  assert.equal(withOcr.method, 'ocr');
  assert.equal(withOcr.extracted.total, 200);
});

test('audit chain detects tampering', () => {
  const chain = [];
  for (let i = 0; i < 4; i++) audit.append(chain, { at: 't', actor: 'u', action: 'a', subject: String(i), data: { i } });
  assert.equal(audit.verify(chain).ok, true);
  chain[1].data.i = 99;
  assert.deepEqual(audit.verify(chain).brokenAt, 2);
  chain[1].data.i = 1;
  chain.splice(2, 1);
  assert.equal(audit.verify(chain).ok, false);
});
