const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { seeded, denies } = require('./helpers');

const invoiceOf = (w, billId) => w.db.get('SELECT * FROM invoices WHERE bill_id = ?', billId);
const qr = (w, billId) => w.svc.commerce.qrFor(w.as('seyi'), invoiceOf(w, billId).id).token;
const key = () => `k${crypto.randomBytes(8).toString('hex')}`;

test('QR payment: signed opaque reference, resolved by the backend, single use', async () => {
  const w = await seeded();
  const { svc } = w;
  const token = qr(w, w.bills.approved);
  assert.ok(!Buffer.from(token.split('.')[0], 'base64url').toString().includes('2034567890'), 'no bank details in the QR payload');
  const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
  assert.deepStrictEqual(Object.keys(payload).sort(), ['e', 'i', 't', 'v'], 'only invoice id + expiry');
  const r = svc.payments.resolveQr(w.as('chidi'), token);
  assert.strictEqual(r.eligible, true);
  assert.strictEqual(r.vendor.name, 'SecureTech Nigeria Ltd'); assert.strictEqual(r.vendor.kybStatus, 'verified');
  assert.strictEqual(r.invoice.currency, 'NGN'); assert.ok(r.scanId);
  const lowWallet = r.wallets.find(x => x.id === w.wallets.wLow.id);
  assert.ok(lowWallet.reasons.some(x => x.code === 'insufficient_funds'), 'wallet shortfall is shown before paying');
  assert.ok(r.wallets.find(x => x.id === w.wallets.wOpex.id).reasons.length === 0);
  // tampered / forged / foreign / expired
  const [body, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...payload, i: crypto.randomUUID() })).toString('base64url') + '.' + sig;
  denies(assert, () => svc.payments.resolveQr(w.as('chidi'), forged), 400, 'invalid_qr');
  denies(assert, () => svc.payments.resolveQr(w.as('chidi'), body + '.AAAA'), 400, 'invalid_qr');
  denies(assert, () => svc.payments.resolveQr(w.as('chidi'), 'garbage'), 400, 'invalid_qr');
  denies(assert, () => svc.payments.resolveQr(w.as('zainab'), token), 404, 'invoice_not_found');       // another tenant learns nothing
  denies(assert, () => svc.payments.resolveQr(w.as('seyi'), token), 403);                              // the vendor cannot "pay" itself
  // replay: a scan is consumed by the first payment intent
  const a = svc.payments.createIntent(w.as('chidi'), { billId: w.bills.approved, walletId: w.wallets.wOpex.id, idempotencyKey: key(), scanId: r.scanId });
  svc.payments.cancelIntent(w.as('chidi'), a.id);
  denies(assert, () => svc.payments.createIntent(w.as('chidi'), { billId: w.bills.approved, walletId: w.wallets.wOpex.id, idempotencyKey: key(), scanId: r.scanId }), 409, 'qr_replay');
  denies(assert, () => svc.payments.createIntent(w.as('bola'), { billId: w.bills.approved, walletId: w.wallets.wOpex.id, idempotencyKey: key(), scanId: svc.payments.resolveQr(w.as('chidi'), token).scanId }), 403, 'invalid_scan');
  // expiry: QR stops working 30 days after the invoice due date
  w.clock.t = new Date(w.clock.t.getTime() + 60 * 86400e3);
  denies(assert, () => svc.payments.resolveQr(w.as('chidi'), token), 410, 'qr_expired');
});

test('QR resolution reports why a bill is not payable (unapproved, settled)', async () => {
  const w = await seeded();
  const { svc } = w;
  const paidQr = qr(w, w.bills.paid);
  const r = svc.payments.resolveQr(w.as('chidi'), paidQr);
  assert.strictEqual(r.eligible, false); assert.strictEqual(r.scanId, null);
  assert.ok(r.reasons.some(x => x.code === 'already_paid' || x.code === 'not_approved' || /settled|paid/i.test(x.msg)));
  const pendingQr = qr(w, w.bills.capexPending);
  const p = svc.payments.resolveQr(w.as('chidi'), pendingQr);
  assert.strictEqual(p.eligible, false); assert.ok(p.reasons.some(x => x.code === 'not_approved'));
});

test('only eligible, approved bills reach the wallet: unapproved, rejected, disputed, quarantined and settled bills are refused', async () => {
  const w = await seeded();
  const { svc } = w;
  for (const id of [w.bills.received, w.bills.capexPending, w.bills.rejected, w.bills.paid]) {
    denies(assert, () => svc.payments.createIntent(w.as('chidi'), { billId: id, walletId: w.wallets.wOpex.id, idempotencyKey: key() }), 422);
  }
  assert.strictEqual(w.db.get('SELECT COUNT(*) n FROM payment_intents').n, 1, 'only the seeded settled payment exists');
  // a bill built from illustrative figures is DEMO — NOT PAYABLE even if approved
  w.db.run("UPDATE bills SET is_payable = 0 WHERE id = ?", w.bills.approved);
  denies(assert, () => svc.payments.createIntent(w.as('chidi'), { billId: w.bills.approved, walletId: w.wallets.wOpex.id, idempotencyKey: key() }), 422, 'demo_not_payable');
  w.db.run("UPDATE bills SET is_payable = 1 WHERE id = ?", w.bills.approved);
});

test('idempotency: same key returns the same intent; a second live payment for one bill is impossible; execution never double-debits', async () => {
  const w = await seeded();
  const { svc, db } = w;
  const k = key();
  const a = svc.payments.createIntent(w.as('chidi'), { billId: w.bills.approved, walletId: w.wallets.wOpex.id, idempotencyKey: k });
  const again = svc.payments.createIntent(w.as('chidi'), { billId: w.bills.approved, walletId: w.wallets.wOpex.id, idempotencyKey: k });
  assert.strictEqual(again.id, a.id); assert.strictEqual(again.idempotentReplay, true);
  denies(assert, () => svc.payments.createIntent(w.as('chidi'), { billId: w.bills.approved, walletId: w.wallets.wCapex.id, idempotencyKey: k }), 409, 'idempotency_conflict');
  denies(assert, () => svc.payments.createIntent(w.as('bola'), { billId: w.bills.approved, walletId: w.wallets.wOpex.id, idempotencyKey: key() }), 409, 'payment_in_progress');
  denies(assert, () => svc.payments.createIntent(w.as('chidi'), { billId: w.bills.approved, walletId: w.wallets.wOpex.id, idempotencyKey: 'short' }), 400);
  const before = svc.payments.listWallets(w.as('tunde')).find(x => x.id === w.wallets.wOpex.id).balanceMinor;
  // step-up authentication and segregation of duties on execution
  denies(assert, () => svc.payments.execute(w.as('kunle'), a.id, { password: 'wrong' }), 401, 'reauth_failed');
  denies(assert, () => svc.payments.execute(w.as('chidi'), a.id, { password: w.PASSWORD }), 403);       // requester has no execute permission
  denies(assert, () => svc.payments.execute(w.as('tunde'), a.id, { password: w.PASSWORD }), 403, 'segregation');   // submitted the bill
  denies(assert, () => svc.payments.execute(w.as('ngozi'), a.id, { password: w.PASSWORD }), 403);       // CFO has no payment.execute
  const done = svc.payments.execute(w.as('kunle'), a.id, { password: w.PASSWORD });
  assert.strictEqual(done.status, 'succeeded'); assert.ok(done.receiptNo);
  const twice = svc.payments.execute(w.as('kunle'), a.id, { password: w.PASSWORD });
  assert.strictEqual(twice.idempotentReplay, true); assert.strictEqual(twice.receiptNo, done.receiptNo);
  const bill = svc.bills.get(w.as('tunde'), w.bills.approved);
  assert.strictEqual(bill.paymentStatus, 'paid');
  const after = svc.payments.listWallets(w.as('tunde')).find(x => x.id === w.wallets.wOpex.id);
  assert.strictEqual(before - after.balanceMinor, bill.payableMinor, 'exactly one debit');
  assert.strictEqual(after.reservedMinor, 0);
  assert.strictEqual(db.get("SELECT COUNT(*) n FROM payment_transactions WHERE bill_id = ?", w.bills.approved).n, 1);
  denies(assert, () => svc.payments.createIntent(w.as('chidi'), { billId: w.bills.approved, walletId: w.wallets.wOpex.id, idempotencyKey: key() }), 422, 'already_paid');
  // ledger and invoice follow the verified payment
  assert.strictEqual(invoiceOf(w, w.bills.approved).status, 'paid');
  assert.strictEqual(bill.accountingStatus, 'posted');
  assert.strictEqual(svc.ledger.journal(w.as('ibrahim'), { billId: w.bills.approved }).length, 2);
});

test('exception paths: insufficient wallet balance, per-transaction limit, wrong wallet type, provider decline, provider timeout', async () => {
  const w = await seeded();
  const { svc } = w;
  const intent = (wallet, id = w.bills.approved) => svc.payments.createIntent(w.as('chidi'), { billId: id, walletId: wallet.id, idempotencyKey: key() });
  denies(assert, () => intent(w.wallets.wLow), 422, 'insufficient_funds');
  denies(assert, () => intent(w.wallets.wCapex), 422, 'wallet_kind');                                   // OPEX bill, CAPEX wallet
  svc.payments.updateWallet(w.as('ngozi'), w.wallets.wOpex.id, { perTxnLimitMinor: 100_000_00 });
  denies(assert, () => intent(w.wallets.wOpex), 422, 'wallet_limit');
  svc.payments.updateWallet(w.as('ngozi'), w.wallets.wOpex.id, { perTxnLimitMinor: 10_000_000_00 });
  // provider decline: funds untouched, bill still unpaid, reservation released, retry on another wallet works
  const d = intent(w.wallets.wDecline);
  const failed = svc.payments.execute(w.as('kunle'), d.id, { password: w.PASSWORD });
  assert.strictEqual(failed.status, 'failed'); assert.match(failed.failureReason, /declin/i);
  const wd = svc.payments.listWallets(w.as('tunde')).find(x => x.id === w.wallets.wDecline.id);
  assert.strictEqual(wd.balanceMinor, 5_000_000_00); assert.strictEqual(wd.reservedMinor, 0);
  assert.strictEqual(svc.bills.get(w.as('tunde'), w.bills.approved).paymentStatus, 'unpaid');
  assert.strictEqual(w.db.get('SELECT COUNT(*) n FROM wallet_reservations WHERE status = ?', 'released').n, 1);
  // timeout: stays "submitted" with funds held until the provider confirms
  svc.payments.updateWallet(w.as('ngozi'), w.wallets.wOpex.id, { sandboxBehavior: 'timeout' });
  const t = intent(w.wallets.wOpex);
  const sub = svc.payments.execute(w.as('kunle'), t.id, { password: w.PASSWORD });
  assert.strictEqual(sub.status, 'submitted');
  let wo = svc.payments.listWallets(w.as('tunde')).find(x => x.id === w.wallets.wOpex.id);
  assert.ok(wo.reservedMinor > 0); assert.strictEqual(svc.bills.get(w.as('tunde'), w.bills.approved).paymentStatus, 'processing');
  denies(assert, () => svc.payments.execute(w.as('kunle'), t.id, { password: w.PASSWORD }), 409);       // cannot resubmit while the provider is working
  denies(assert, () => svc.payments.createIntent(w.as('chidi'), { billId: w.bills.approved, walletId: w.wallets.wOpex.id, idempotencyKey: key() }), 422);
  const ok = svc.payments.refresh(w.as('kunle'), t.id);
  assert.strictEqual(ok.status, 'succeeded');
  wo = svc.payments.listWallets(w.as('tunde')).find(x => x.id === w.wallets.wOpex.id);
  assert.strictEqual(wo.reservedMinor, 0);
});

test('provider events are authenticated and idempotent: forged, replayed and mismatching events change nothing', async () => {
  const w = await seeded();
  const { svc, db } = w;
  svc.payments.updateWallet(w.as('ngozi'), w.wallets.wOpex.id, { sandboxBehavior: 'timeout' });
  const i = svc.payments.createIntent(w.as('chidi'), { billId: w.bills.approved, walletId: w.wallets.wOpex.id, idempotencyKey: key() });
  svc.payments.execute(w.as('kunle'), i.id, { password: w.PASSWORD });
  const body = JSON.stringify({ event_id: 'evt_forged_1', intent_id: i.id, type: 'payment.succeeded', amount_minor: i.amountMinor, currency: 'NGN', provider_ref: 'SBX-FORGED' });
  denies(assert, () => svc.payments.handleProviderEvent(body, 'not-a-signature'), 401, 'bad_signature');
  assert.strictEqual(svc.payments.intentView(db.get('SELECT * FROM payment_intents WHERE id = ?', i.id)).status, 'submitted', 'forged success did not complete the payment');
  assert.strictEqual(db.get('SELECT COUNT(*) n FROM payment_provider_events WHERE signature_valid = 0').n, 1);
  // a correctly signed event with the wrong amount is rejected
  const { hmac } = require('../../platform/security');
  const wrong = JSON.stringify({ event_id: 'evt_wrong_amt', intent_id: i.id, type: 'payment.succeeded', amount_minor: 1, currency: 'NGN', provider_ref: 'SBX-X' });
  denies(assert, () => svc.payments.handleProviderEvent(wrong, hmac(w.core.secrets.provider, wrong)), 422, 'provider_mismatch');
  const good = JSON.stringify({ event_id: 'evt_good_1', intent_id: i.id, type: 'payment.succeeded', amount_minor: i.amountMinor, currency: 'NGN', provider_ref: 'SBX-GOOD1' });
  const sig = hmac(w.core.secrets.provider, good);
  assert.deepStrictEqual(svc.payments.handleProviderEvent(good, sig), { applied: 'payment.succeeded' });
  assert.deepStrictEqual(svc.payments.handleProviderEvent(good, sig), { duplicate: true });             // replayed webhook
  const failLater = JSON.stringify({ event_id: 'evt_late_fail', intent_id: i.id, type: 'payment.failed', amount_minor: i.amountMinor, currency: 'NGN', code: 'x' });
  assert.strictEqual(svc.payments.handleProviderEvent(failLater, hmac(w.core.secrets.provider, failLater)).ignored, true);   // cannot un-pay a settled bill
  assert.strictEqual(svc.bills.get(w.as('tunde'), w.bills.approved).paymentStatus, 'paid');
  assert.strictEqual(db.get('SELECT COUNT(*) n FROM payment_transactions WHERE bill_id = ?', w.bills.approved).n, 1);
});

test('dual control: wallets above the threshold need a second person to authorise', async () => {
  const w = await seeded();
  const { svc } = w;
  svc.payments.updateWallet(w.as('ngozi'), w.wallets.wOpex.id, { dualControlMinor: 100_000_00 });
  const i = svc.payments.createIntent(w.as('kunle'), { billId: w.bills.approved, walletId: w.wallets.wOpex.id, idempotencyKey: key() });
  assert.strictEqual(i.status, 'awaiting_authorization');
  denies(assert, () => svc.payments.execute(w.as('kunle'), i.id, { password: w.PASSWORD }), 403, 'segregation');   // initiator cannot authorise their own payment
  svc.payments.cancelIntent(w.as('kunle'), i.id);
});

test('sandbox wallets are labelled simulated and statements say so', async () => {
  const w = await seeded();
  const wal = w.svc.payments.listWallets(w.as('tunde'))[0];
  assert.strictEqual(wal.simulated, true);
  assert.match(w.svc.payments.statementCsv(w.as('tunde'), wal.id), /SANDBOX — SIMULATED BALANCES/);
  assert.strictEqual(w.svc.payments.transactions(w.as('tunde'))[0].simulated, true);
  denies(assert, () => w.svc.payments.topup(w.as('tunde'), wal.id, 100), 403);                           // finance officer cannot mint funds
});
