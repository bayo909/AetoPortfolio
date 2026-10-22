const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { seeded, denies } = require('./helpers');

test('every posted journal entry balances, in transaction and functional currency, with unique posting keys', async () => {
  const w = await seeded();
  const { db } = w;
  const bad = db.all(`SELECT e.number, SUM(CASE WHEN l.side='Dr' THEN l.amount_minor ELSE -l.amount_minor END) d, SUM(CASE WHEN l.side='Dr' THEN l.functional_minor ELSE -l.functional_minor END) f
                      FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id GROUP BY e.id HAVING d <> 0 OR f <> 0`);
  assert.deepStrictEqual(bad, []);
  assert.ok(db.get('SELECT COUNT(*) n FROM journal_entries').n >= 8);
  assert.strictEqual(db.get('SELECT COUNT(*) n FROM (SELECT org_id, posting_key FROM journal_entries GROUP BY 1,2 HAVING COUNT(*) > 1)').n, 0);
  const tb = w.svc.ledger.trialBalance(w.as('ibrahim'));
  assert.strictEqual(tb.balanced, true);
  assert.strictEqual(tb.totalDebitMinor, tb.totalCreditMinor);
  const st = w.svc.ledger.statements(w.as('ibrahim'));
  assert.strictEqual(st.balanceSheet.assetsMinor, st.balanceSheet.liabilitiesMinor + st.balanceSheet.equityMinor);
});

test('posting is atomic and validated: unbalanced, unknown, memo and single-line entries are refused and leave nothing behind', async () => {
  const w = await seeded();
  const { svc, db } = w;
  const n0 = db.get('SELECT COUNT(*) n FROM journal_entries').n;
  const post = lines => svc.ledger.post(w.orgs.apex.id, { postingKey: `t-${crypto.randomUUID()}`, sourceType: 'test', sourceId: 'x', lines });
  denies(assert, () => post([{ code: 6900, side: 'Dr', amountMinor: 100 }, { code: 2110, side: 'Cr', amountMinor: 99 }]), 422, 'unbalanced');
  denies(assert, () => post([{ code: 6900, side: 'Dr', amountMinor: 100 }]), 422, 'invalid_entry');
  denies(assert, () => post([{ code: 6900, side: 'Dr', amountMinor: 0 }, { code: 2110, side: 'Cr', amountMinor: 0 }]), 422, 'invalid_entry');
  denies(assert, () => post([{ code: 6900, side: 'Dr', amountMinor: 1.5 }, { code: 2110, side: 'Cr', amountMinor: 1.5 }]), 422, 'invalid_entry');
  denies(assert, () => post([{ code: 6999, side: 'Dr', amountMinor: 100 }, { code: 2110, side: 'Cr', amountMinor: 100 }]), 422, 'unknown_account');
  svc.ledger.saveAccount(w.as('ibrahim'), { code: 6950, name: 'Retired account', active: false });
  denies(assert, () => post([{ code: 6950, side: 'Dr', amountMinor: 100 }, { code: 2110, side: 'Cr', amountMinor: 100 }]), 422, 'inactive_account');
  assert.strictEqual(db.get('SELECT COUNT(*) n FROM journal_entries').n, n0);
});

test('posting is idempotent and period locks are enforced in the engine and the database', async () => {
  const w = await seeded();
  const { svc, db } = w;
  const spec = { postingKey: 'idem-1', sourceType: 'test', sourceId: '1', lines: [{ code: 6900, side: 'Dr', amountMinor: 500 }, { code: 2110, side: 'Cr', amountMinor: 500 }] };
  const a = svc.ledger.post(w.orgs.apex.id, spec), b = svc.ledger.post(w.orgs.apex.id, spec);
  assert.strictEqual(a.duplicate, false); assert.strictEqual(b.duplicate, true); assert.strictEqual(a.entry.id, b.entry.id);
  assert.strictEqual(db.get("SELECT COUNT(*) n FROM journal_entries WHERE posting_key = 'idem-1'").n, 1);
  const period = w.clock.t.toISOString().slice(0, 7);
  svc.ledger.setPeriod(w.as('ibrahim'), period, true);
  denies(assert, () => svc.ledger.post(w.orgs.apex.id, { ...spec, postingKey: 'idem-2' }), 423, 'period_locked');
  // even raw inserts into a locked period are rejected by the trigger
  const e = db.get('SELECT id FROM journal_entries WHERE org_id = ? LIMIT 1', w.orgs.apex.id);
  const acct = db.get('SELECT id FROM chart_of_accounts WHERE org_id = ? LIMIT 1', w.orgs.apex.id);
  assert.throws(() => db.run("INSERT INTO journal_lines(id, entry_id, org_id, position, account_id, side, amount_minor, functional_minor) VALUES ('z',?,?,9,?, 'Dr', 1, 1)", e.id, w.orgs.apex.id, acct.id), /locked|constraint/i);
  svc.ledger.setPeriod(w.as('ibrahim'), period, false);
  denies(assert, () => svc.ledger.setPeriod(w.as('chidi'), period, true), 403);
});

test('corrections are reversal entries, never edits; a reversal can happen once', async () => {
  const w = await seeded();
  const { svc, db } = w;
  const entry = svc.ledger.journal(w.as('ibrahim'), { billId: w.bills.paid })[0];
  denies(assert, () => svc.ledger.reverse(w.as('ibrahim'), entry.id, ''), 400);
  denies(assert, () => svc.ledger.reverse(w.as('tunde'), entry.id, 'x'), 403);
  const rev = svc.ledger.reverse(w.as('ibrahim'), entry.id, 'Posted to wrong cost centre');
  assert.strictEqual(rev.reversesEntryId, entry.id);
  assert.deepStrictEqual(rev.lines.map(l => [l.code, l.side === 'Dr' ? 'Cr' : 'Dr']).sort(), entry.lines.map(l => [l.code, l.side]).sort());
  assert.strictEqual(svc.ledger.reverse(w.as('ibrahim'), entry.id, 'again').id, rev.id, 'retry returns the same reversal');
  assert.strictEqual(db.get('SELECT COUNT(*) n FROM journal_entries WHERE reverses_entry_id = ?', entry.id).n, 1);
  denies(assert, () => svc.ledger.reverse(w.as('ibrahim'), rev.id, 'undo the undo'), 400);
  assert.strictEqual(svc.ledger.journal(w.as('ibrahim'), { billId: w.bills.paid }).find(j => j.id === entry.id).reversedBy, rev.number);
});

test('foreign currency: functional amounts use a recorded rate; missing rate blocks posting', async () => {
  const w = await seeded();
  const { svc, db } = w;
  const spec = { postingKey: 'fx-1', sourceType: 'test', sourceId: 'fx', currency: 'USD', lines: [{ code: 6900, side: 'Dr', amountMinor: 333 }, { code: 2110, side: 'Cr', amountMinor: 333 }] };
  denies(assert, () => svc.ledger.post(w.orgs.apex.id, spec), 422, 'missing_fx_rate');
  db.run("INSERT INTO fx_rates(org_id, from_ccy, to_ccy, rate, source, as_of) VALUES (?, 'USD', 'NGN', 1512.37, 'CBN official (demo rate)', '2026-01-01')", w.orgs.apex.id);
  const r = svc.ledger.post(w.orgs.apex.id, spec);
  assert.strictEqual(r.entry.fx_rate, 1512.37); assert.match(r.entry.fx_source, /CBN/);
  const lines = db.all('SELECT side, amount_minor, functional_minor FROM journal_lines WHERE entry_id = ?', r.entry.id);
  assert.strictEqual(lines.reduce((s, l) => s + (l.side === 'Dr' ? l.functional_minor : -l.functional_minor), 0), 0);
  assert.strictEqual(lines[0].functional_minor, Math.round(333 * 1512.37));
});

test('accounting failures are retryable without double paying or duplicate entries', async () => {
  const w = await seeded();
  const { svc, db } = w;
  // seeded: approved while the period was locked => accrual could not post
  const failed = svc.bills.get(w.as('tunde'), w.bills.postingFailed);
  assert.strictEqual(failed.status, 'approved'); assert.strictEqual(failed.accountingStatus, 'posting_failed'); assert.match(failed.accountingError, /locked/);
  assert.strictEqual(svc.ledger.journal(w.as('ibrahim'), { billId: failed.id }).length, 0);
  // the bill is still payable — payment and ledger posting are separate states
  const period = w.clock.t.toISOString().slice(0, 7);
  svc.ledger.setPeriod(w.as('ibrahim'), period, true);
  const i = svc.payments.createIntent(w.as('chidi'), { billId: failed.id, walletId: w.wallets.wOpex.id, idempotencyKey: `k${crypto.randomBytes(6).toString('hex')}` });
  const paid = svc.payments.execute(w.as('kunle'), i.id, { password: w.PASSWORD });
  assert.strictEqual(paid.status, 'succeeded', 'payment succeeds even though the ledger is closed');
  let b = svc.bills.get(w.as('tunde'), failed.id);
  assert.strictEqual(b.paymentStatus, 'paid'); assert.strictEqual(b.accountingStatus, 'posting_failed');
  assert.strictEqual(svc.payments.reconciliation(w.as('ibrahim')).find(r => r.billNumber === b.number).status, 'exception', 'reconciliation flags the missing entry');
  // retry while still locked: still failing, nothing duplicated
  svc.bills.retryPosting(w.as('ibrahim'), failed.id);
  assert.strictEqual(svc.bills.get(w.as('tunde'), failed.id).accountingStatus, 'posting_failed');
  svc.ledger.setPeriod(w.as('ibrahim'), period, false);
  svc.bills.retryPosting(w.as('ibrahim'), failed.id);
  svc.bills.retryPosting(w.as('ibrahim'), failed.id);
  b = svc.bills.get(w.as('tunde'), failed.id);
  assert.strictEqual(b.accountingStatus, 'posted');
  const entries = svc.ledger.journal(w.as('ibrahim'), { billId: failed.id });
  assert.deepStrictEqual(entries.map(e => e.sourceType), ['bill', 'payment'], 'one accrual and one payment entry, however often retried');
  assert.strictEqual(db.get('SELECT COUNT(*) n FROM payment_transactions WHERE bill_id = ?', failed.id).n, 1);
  svc.payments.runReconciliation(w.as('ibrahim'));
  assert.strictEqual(svc.payments.reconciliation(w.as('ibrahim')).find(r => r.billNumber === b.number).status, 'matched');
  denies(assert, () => svc.bills.retryPosting(w.as('chidi'), failed.id), 403);
});

test('audit trail is hash-linked and tamper-evident', async () => {
  const w = await seeded();
  const { svc, db, core } = w;
  const v = svc.admin.verifyAudit(w.as('adaeze'));
  assert.strictEqual(v.ok, true); assert.ok(v.checked > 50);
  // someone with raw database access disables the append-only trigger and edits history
  db.raw.exec('DROP TRIGGER audit_no_update');
  const row = db.get("SELECT seq FROM audit_events WHERE org_id = ? AND action = 'payment.succeeded'", w.orgs.apex.id);
  db.run("UPDATE audit_events SET reason = 'edited after the fact' WHERE seq = ?", row.seq);
  const after = svc.admin.verifyAudit(w.as('adaeze'));
  assert.strictEqual(after.ok, false); assert.strictEqual(after.brokenAtSeq, row.seq);
  assert.strictEqual(svc.admin.verifyAudit(w.as('emeka')).ok, true, 'other tenants\' chains are independent');
  assert.strictEqual(svc.admin.health(w.as('platform')).status, 'degraded');
  void core;
});
