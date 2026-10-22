// Wallet orchestration, QR invoice payment and the payment state machine. MVP uses a clearly-labelled SANDBOX provider with
// simulated balances; no real funds are held. Payment state changes only from a verified provider event.
//   intent: created | awaiting_authorization -> submitted -> succeeded | failed        (cancelled from the first two)
//   bill.payment_status: unpaid -> processing -> paid      (failure returns it to unpaid; ledger posting is a SEPARATE, retryable state)
const crypto = require('crypto');
const { uid, iso } = require('./db');
const { verifyPassword, hmac, safeEqual } = require('./security');
const { bad, forbidden, notFound, conflict, unprocessable, HttpError } = require('./errors');
const { fmt } = require('./money');
const { toCsv } = require('../src/csv');

const SCAN_TTL_MIN = 10;

module.exports = function paymentsService(core) {
  const { db, now, audit } = core;
  const sign = body => hmac(core.secrets.provider, body);

  /* --------------------------- sandbox provider --------------------------- */
  const outcomes = new Map(); // intentId -> eventual outcome for 'timeout' wallets
  const sandbox = {
    name: 'sandbox',
    /** Returns a signed provider event, or null if the provider has not answered yet (timeout). */
    submit({ intentId, amountMinor, currency, behavior }) {
      const base = { event_id: `evt_${crypto.randomUUID()}`, intent_id: intentId, amount_minor: amountMinor, currency, provider: 'sandbox', provider_ref: `SBX-${crypto.randomBytes(5).toString('hex').toUpperCase()}`, simulated: true };
      if (behavior === 'timeout') { outcomes.set(intentId, { ...base, type: 'payment.succeeded' }); return null; }
      const ev = behavior === 'decline' ? { ...base, type: 'payment.failed', code: 'card_declined', reason: 'Sandbox provider declined the payment (simulated decline)' } : { ...base, type: 'payment.succeeded' };
      return { body: JSON.stringify(ev), signature: sign(JSON.stringify(ev)) };
    },
    query(intentId) {
      const ev = outcomes.get(intentId);
      if (!ev) return null;
      outcomes.delete(intentId);
      const body = JSON.stringify({ ...ev, event_id: `evt_${crypto.randomUUID()}` });
      return { body, signature: sign(body) };
    },
  };

  const walletView = w => ({ id: w.id, name: w.name, kind: w.kind, currency: w.currency, balanceMinor: w.balance_minor, reservedMinor: w.reserved_minor, availableMinor: w.balance_minor - w.reserved_minor,
    perTxnLimitMinor: w.per_txn_limit_minor, dualControlMinor: w.dual_control_minor, department: w.department, project: w.project, sandboxBehavior: w.sandbox_behavior, simulated: !!w.is_simulated, status: w.status });

  function walletKindOk(bill, wallet) {
    if (bill.source === 'expense') return ['reimbursement', 'opex'].includes(wallet.kind);
    return wallet.kind === bill.classification;
  }

  function mustBill(ctx, id) {
    const b = db.get('SELECT * FROM bills WHERE id = ? AND org_id = ?', id, ctx.orgId);
    if (!b) throw notFound('Bill');
    return b;
  }

  /** Eligibility = approved, payable, unpaid, no payment in flight, and a wallet that can cover it. */
  function eligibility(bill, wallet) {
    const reasons = [];
    if (bill.status !== 'approved') reasons.push({ code: 'not_approved', msg: bill.status === 'paid' ? 'Already settled' : `Bill is ${bill.status.replace('_', ' ')}; expenditure approval is incomplete` });
    if (!bill.is_payable) reasons.push({ code: 'demo_not_payable', msg: 'DEMO — NOT PAYABLE' });
    if (bill.payment_status === 'paid') reasons.push({ code: 'already_paid', msg: 'This bill has already been paid' });
    else if (bill.payment_status === 'processing') reasons.push({ code: 'in_progress', msg: 'A payment for this bill is already in progress' });
    if (wallet) {
      if (wallet.status !== 'active') reasons.push({ code: 'wallet_frozen', msg: 'Wallet is frozen' });
      if (wallet.currency !== bill.currency) reasons.push({ code: 'currency', msg: `Wallet currency ${wallet.currency} does not match bill currency ${bill.currency}` });
      if (!walletKindOk(bill, wallet)) reasons.push({ code: 'wallet_kind', msg: `A ${bill.classification.toUpperCase()} bill must be paid from a ${bill.source === 'expense' ? 'reimbursement/OPEX' : bill.classification.toUpperCase()} wallet` });
      if (wallet.per_txn_limit_minor && bill.payable_minor > wallet.per_txn_limit_minor) reasons.push({ code: 'wallet_limit', msg: `Exceeds the wallet's per-transaction limit of ${fmt(wallet.per_txn_limit_minor, wallet.currency)}` });
      if (wallet.balance_minor - wallet.reserved_minor < bill.payable_minor) reasons.push({ code: 'insufficient_funds', msg: `Insufficient wallet balance: ${fmt(wallet.balance_minor - wallet.reserved_minor, wallet.currency)} available, ${fmt(bill.payable_minor, wallet.currency)} needed` });
    }
    return reasons;
  }

  function executorBlock(ctx, bill, intent) {
    if (bill.requested_by === ctx.userId) return 'The requester of this purchase cannot execute its payment (FIN-POL-002)';
    if (bill.beneficiary_user_id === ctx.userId) return 'You are the beneficiary of this transaction (GOV-001)';
    const acted = db.get("SELECT 1 x FROM approval_decisions WHERE subject_type = 'bill' AND subject_id = ? AND actor_id = ?", bill.id, ctx.userId);
    if (acted) return 'You approved or submitted this bill; payment must be executed by someone else (FIN-POL-002)';
    if (intent.status === 'awaiting_authorization' && intent.initiated_by === ctx.userId) return 'This wallet requires dual control: a different person must authorise';
    return null;
  }

  const svc = {
    sandbox, walletView, eligibility,

    /* -------------------------------- wallets -------------------------------- */
    listWallets(ctx) { ctx.require('wallet.view'); return db.all('SELECT * FROM wallets WHERE org_id = ? ORDER BY kind, name', ctx.orgId).map(walletView); },
    createWallet(ctx, b) {
      ctx.require('wallet.manage');
      if (!['opex', 'capex', 'reimbursement'].includes(b.kind)) throw bad('Wallet kind must be opex, capex or reimbursement');
      if (!String(b.name || '').trim()) throw bad('Wallet name is required');
      const w = { id: uid(), org_id: ctx.orgId, name: b.name.trim(), kind: b.kind, currency: b.currency || ctx.org.currency, balance_minor: 0, reserved_minor: 0, per_txn_limit_minor: Number(b.perTxnLimitMinor || 0),
        dual_control_minor: Number(b.dualControlMinor || 0), department: b.department || '', project: b.project || '', sandbox_behavior: 'normal', is_simulated: 1, status: 'active', created_at: iso(now()) };
      db.tx(() => { db.insert('wallets', w); audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'wallet.created', objectType: 'wallet', objectId: w.id, next: { name: w.name, kind: w.kind } }); });
      return walletView(w);
    },
    updateWallet(ctx, id, b) {
      ctx.require('wallet.manage');
      const w = db.get('SELECT * FROM wallets WHERE id = ? AND org_id = ?', id, ctx.orgId);
      if (!w) throw notFound('Wallet');
      const n = { per_txn_limit_minor: b.perTxnLimitMinor ?? w.per_txn_limit_minor, dual_control_minor: b.dualControlMinor ?? w.dual_control_minor, status: b.status ?? w.status, sandbox_behavior: b.sandboxBehavior ?? w.sandbox_behavior };
      if (!['active', 'frozen'].includes(n.status) || !['normal', 'decline', 'timeout'].includes(n.sandbox_behavior)) throw bad('Invalid wallet settings');
      db.tx(() => {
        db.run('UPDATE wallets SET per_txn_limit_minor=?, dual_control_minor=?, status=?, sandbox_behavior=? WHERE id=?', Number(n.per_txn_limit_minor), Number(n.dual_control_minor), n.status, n.sandbox_behavior, id);
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'wallet.updated', objectType: 'wallet', objectId: id, prior: { limit: w.per_txn_limit_minor, status: w.status }, next: n });
      });
      return walletView(db.get('SELECT * FROM wallets WHERE id = ?', id));
    },
    /** Sandbox only: credits SIMULATED funds. Never represents real stored value. */
    topup(ctx, id, amountMinor, memo = 'Sandbox top-up (simulated funds)') {
      ctx.require('wallet.manage');
      const w = db.get('SELECT * FROM wallets WHERE id = ? AND org_id = ?', id, ctx.orgId);
      if (!w) throw notFound('Wallet');
      if (!w.is_simulated) throw forbidden('Only simulated wallets can be topped up in the sandbox');
      if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw bad('Amount must be positive');
      db.tx(() => {
        const bal = w.balance_minor + amountMinor;
        db.run('UPDATE wallets SET balance_minor = ? WHERE id = ?', bal, id);
        const ref = `TOP-${uid()}`;
        db.insert('wallet_transactions', { id: uid(), org_id: ctx.orgId, wallet_id: id, kind: 'topup', amount_minor: amountMinor, balance_after_minor: bal, ref, memo, created_at: iso(now()) });
        try {
          core.svc.ledger.post(ctx.orgId, { postingKey: `topup:${ref}`, sourceType: 'wallet_topup', sourceId: ref, memo, currency: w.currency, createdBy: ctx.userId, lines: [{ code: 1120, side: 'Dr', amountMinor }, { code: 1100, side: 'Cr', amountMinor }] });
        } catch (e) { if (e.code !== 'period_locked') throw e; }
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'wallet.topup', objectType: 'wallet', objectId: id, next: { amountMinor, simulated: true } });
      });
      return walletView(db.get('SELECT * FROM wallets WHERE id = ?', id));
    },
    walletTransactions(ctx, id) {
      ctx.require('wallet.view');
      if (!db.get('SELECT 1 x FROM wallets WHERE id = ? AND org_id = ?', id, ctx.orgId)) throw notFound('Wallet');
      return db.all('SELECT kind, amount_minor, balance_after_minor, ref, memo, created_at FROM wallet_transactions WHERE wallet_id = ? ORDER BY created_at DESC, rowid DESC', id).map(t => ({ kind: t.kind, amountMinor: t.amount_minor, balanceAfterMinor: t.balance_after_minor, ref: t.ref, memo: t.memo, createdAt: t.created_at }));
    },
    statementCsv(ctx, id) {
      const w = db.get('SELECT * FROM wallets WHERE id = ? AND org_id = ?', id, ctx.orgId);
      if (!w) throw notFound('Wallet');
      return toCsv([['Wallet', w.name, 'SANDBOX — SIMULATED BALANCES'], ['Currency', w.currency], [], ['Date', 'Type', 'Amount', 'Balance after', 'Reference', 'Memo'],
        ...svc.walletTransactions(ctx, id).reverse().map(t => [t.createdAt, t.kind, (t.amountMinor / 100).toFixed(2), (t.balanceAfterMinor / 100).toFixed(2), t.ref, t.memo])]);
    },

    /* ------------------------------ QR resolution ------------------------------ */
    /** Resolves a scanned QR through the backend. Reveals nothing unless the signed reference belongs to the caller's organisation. */
    resolveQr(ctx, token) {
      ctx.require('qr.scan');
      const p = core.svc.commerce.verifyQr(token);
      if (!p || p.v !== 1 || p.t !== 'inv') throw new HttpError(400, 'This QR code is not valid or has been altered', undefined, 'invalid_qr');
      if (p.e < Math.floor(now().getTime() / 1000)) throw new HttpError(410, 'This invoice QR code has expired', undefined, 'qr_expired');
      const inv = db.get('SELECT * FROM invoices WHERE id = ?', p.i);
      if (!inv || inv.customer_org_id !== ctx.orgId || !inv.issued_at) throw new HttpError(404, 'This invoice is not payable from your organisation', undefined, 'invoice_not_found');
      const rel = core.svc.vendor.activeRelationship(ctx.orgId, inv.vendor_org_id);
      if (!rel) throw forbidden('This vendor is not an authorised relationship of your organisation', 'no_relationship');
      if (core.svc.subscriptions && !core.svc.subscriptions.isEntitled(inv.vendor_org_id, 'qr_payments')) throw forbidden('This vendor has not enabled QR payments — open the bill from your Bills list instead', 'vendor_qr_disabled');
      const bill = db.get('SELECT * FROM bills WHERE id = ?', inv.bill_id);
      const vp = db.get('SELECT legal_name, kyb_status FROM vendor_profiles WHERE org_id = ?', inv.vendor_org_id);
      const wallets = db.all("SELECT * FROM wallets WHERE org_id = ? AND status = 'active' ORDER BY name", ctx.orgId).filter(w => bill && walletKindOk(bill, w)).map(w => ({ ...walletView(w), reasons: eligibility(bill, w) }));
      const base = eligibility(bill, null);
      let scanId = null;
      if (!base.length) {
        scanId = uid();
        db.insert('qr_scans', { id: scanId, org_id: ctx.orgId, invoice_id: inv.id, bill_id: bill.id, scanned_by: ctx.userId, expires_at: iso(new Date(now().getTime() + SCAN_TTL_MIN * 60e3)), created_at: iso(now()) });
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'qr.resolved', objectType: 'invoice', objectId: inv.id, refs: { billId: bill.id } });
      }
      return {
        scanId, expiresInMinutes: SCAN_TTL_MIN, eligible: !base.length, reasons: base,
        vendor: { name: vp.legal_name, kybStatus: vp.kyb_status }, invoice: { number: inv.number, currency: inv.currency, totalMinor: inv.total_minor, payableMinor: bill.payable_minor, whtMinor: bill.wht_minor, dueDate: inv.due_date, status: inv.status },
        billId: bill.id, billNumber: bill.number, billStatus: bill.status, paymentStatus: bill.payment_status, wallets,
      };
    },

    /* ------------------------------ payment intents ------------------------------ */
    createIntent(ctx, { billId, walletId, idempotencyKey, scanId = null }) {
      ctx.require('payment.initiate');
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(idempotencyKey || '')) throw bad('An idempotency key (8–80 URL-safe characters) is required');
      const existing = db.get('SELECT * FROM payment_intents WHERE org_id = ? AND idempotency_key = ?', ctx.orgId, idempotencyKey);
      if (existing) {
        if (existing.bill_id !== billId || existing.wallet_id !== walletId) throw conflict('This idempotency key was already used for a different payment', 'idempotency_conflict');
        return svc.intentView(existing, true);
      }
      const bill = mustBill(ctx, billId);
      const wallet = db.get('SELECT * FROM wallets WHERE id = ? AND org_id = ?', walletId, ctx.orgId);
      if (!wallet) throw notFound('Wallet');
      if (bill.beneficiary_user_id === ctx.userId) throw forbidden('You cannot initiate payment of a transaction you benefit from (GOV-001)', 'segregation');
      const reasons = eligibility(bill, wallet);
      if (reasons.length) throw unprocessable(reasons[0].msg, reasons.map(r => ({ level: 'error', ...r })), reasons[0].code);
      if (scanId) {
        const s = db.get('SELECT * FROM qr_scans WHERE id = ? AND org_id = ?', scanId, ctx.orgId);
        if (!s || s.bill_id !== billId || s.scanned_by !== ctx.userId) throw forbidden('QR scan does not match this payment', 'invalid_scan');
        if (s.consumed_at) throw conflict('This QR scan has already been used (replay blocked)', 'qr_replay');
        if (s.expires_at < iso(now())) throw conflict('QR scan session expired — scan again', 'scan_expired');
      }
      const intent = {
        id: uid(), org_id: ctx.orgId, bill_id: billId, wallet_id: walletId, amount_minor: bill.payable_minor, currency: bill.currency, idempotency_key: idempotencyKey,
        status: wallet.dual_control_minor && bill.payable_minor >= wallet.dual_control_minor ? 'awaiting_authorization' : 'created', initiated_by: ctx.userId, scan_id: scanId, provider: 'sandbox', created_at: iso(now()), updated_at: iso(now()),
      };
      try {
        db.tx(() => {
          db.insert('payment_intents', intent);
          if (scanId) db.run('UPDATE qr_scans SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL', iso(now()), scanId);
          audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'payment.intent_created', objectType: 'payment_intent', objectId: intent.id, next: { billNumber: bill.number, amountMinor: intent.amount_minor, wallet: wallet.name, via: scanId ? 'qr' : 'bill', status: intent.status }, refs: { billId } });
        });
      } catch (e) {
        if (/uq_one_active_intent|UNIQUE/.test(e.message)) throw conflict('A payment for this bill is already in progress or completed', 'payment_in_progress');
        throw e;
      }
      return svc.intentView(db.get('SELECT * FROM payment_intents WHERE id = ?', intent.id));
    },
    intentView(i, replayed = false) {
      const b = db.get('SELECT number, party_name FROM bills WHERE id = ?', i.bill_id);
      const w = db.get('SELECT name FROM wallets WHERE id = ?', i.wallet_id);
      const tx = db.get('SELECT receipt_no, provider_ref FROM payment_transactions WHERE intent_id = ?', i.id);
      return { id: i.id, billId: i.bill_id, billNumber: b.number, party: b.party_name, walletId: i.wallet_id, wallet: w.name, amountMinor: i.amount_minor, currency: i.currency, status: i.status, initiatedBy: (db.get('SELECT name FROM users WHERE id = ?', i.initiated_by) || {}).name,
        failureCode: i.failure_code, failureReason: i.failure_reason, receiptNo: tx && tx.receipt_no, providerRef: tx && tx.provider_ref, idempotentReplay: replayed, createdAt: i.created_at, simulated: true };
    },
    listIntents(ctx) {
      ctx.require('wallet.view');
      return db.all('SELECT * FROM payment_intents WHERE org_id = ? ORDER BY created_at DESC LIMIT 200', ctx.orgId).map(i => svc.intentView(i));
    },
    cancelIntent(ctx, id) {
      const i = db.get('SELECT * FROM payment_intents WHERE id = ? AND org_id = ?', id, ctx.orgId);
      if (!i) throw notFound('Payment');
      if (i.initiated_by !== ctx.userId && !ctx.can('payment.execute')) throw forbidden();
      if (!['created', 'awaiting_authorization'].includes(i.status)) throw conflict(`Payment is ${i.status}`);
      db.tx(() => { db.run("UPDATE payment_intents SET status = 'cancelled', updated_at = ? WHERE id = ?", iso(now()), id); audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'payment.cancelled', objectType: 'payment_intent', objectId: id }); });
      return svc.intentView(db.get('SELECT * FROM payment_intents WHERE id = ?', id));
    },

    /** Step-up authentication (password) + execution. Safe to call twice: a finished payment returns its result and never debits again. */
    execute(ctx, id, { password }) {
      ctx.require('payment.execute');
      const i = db.get('SELECT * FROM payment_intents WHERE id = ? AND org_id = ?', id, ctx.orgId);
      if (!i) throw notFound('Payment');
      if (i.status === 'succeeded') return { ...svc.intentView(i), idempotentReplay: true };
      if (i.status === 'submitted') throw conflict('Payment is already with the provider; refresh its status', 'in_progress');
      if (!['created', 'awaiting_authorization'].includes(i.status)) throw conflict(`Payment is ${i.status}`);
      if (!verifyPassword(String(password || ''), ctx.user.pw_hash)) {
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'payment.authentication_failed', objectType: 'payment_intent', objectId: id });
        throw new HttpError(401, 'Authentication failed — re-enter your password to authorise this payment', undefined, 'reauth_failed');
      }
      const bill = db.get('SELECT * FROM bills WHERE id = ?', i.bill_id);
      const block = executorBlock(ctx, bill, i);
      if (block) throw forbidden(block, 'segregation');
      const wallet = db.get('SELECT * FROM wallets WHERE id = ?', i.wallet_id);
      const reasons = eligibility({ ...bill, payment_status: 'unpaid' }, wallet);
      if (bill.payment_status !== 'unpaid') reasons.unshift({ code: 'in_progress', msg: 'Bill is not unpaid' });
      if (reasons.length) throw unprocessable(reasons[0].msg, reasons.map(r => ({ level: 'error', ...r })), reasons[0].code);
      db.tx(() => {
        db.run("UPDATE payment_intents SET status = 'submitted', authorized_by = ?, updated_at = ? WHERE id = ? AND status IN ('created','awaiting_authorization')", ctx.userId, iso(now()), id);
        db.run('UPDATE wallets SET reserved_minor = reserved_minor + ? WHERE id = ?', i.amount_minor, wallet.id);
        db.insert('wallet_reservations', { id: uid(), org_id: ctx.orgId, wallet_id: wallet.id, payment_intent_id: id, amount_minor: i.amount_minor, status: 'held', created_at: iso(now()) });
        db.run("UPDATE bills SET payment_status = 'processing' WHERE id = ?", bill.id);
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'payment.submitted', objectType: 'payment_intent', objectId: id, prior: { status: i.status }, next: { status: 'submitted', reserved: i.amount_minor }, refs: { billId: bill.id } });
      });
      const ev = sandbox.submit({ intentId: id, amountMinor: i.amount_minor, currency: i.currency, behavior: wallet.sandbox_behavior });
      if (ev) svc.handleProviderEvent(ev.body, ev.signature);
      return svc.intentView(db.get('SELECT * FROM payment_intents WHERE id = ?', id));
    },
    /** Asks the provider for the outcome of a payment that has not been confirmed yet. */
    refresh(ctx, id) {
      const i = db.get('SELECT * FROM payment_intents WHERE id = ? AND org_id = ?', id, ctx.orgId);
      if (!i) throw notFound('Payment');
      if (i.status === 'submitted') { const ev = sandbox.query(id); if (ev) svc.handleProviderEvent(ev.body, ev.signature); }
      return svc.intentView(db.get('SELECT * FROM payment_intents WHERE id = ?', id));
    },

    /** The only place payment status is changed. Verifies the signature, de-duplicates by event id, then applies atomically. */
    handleProviderEvent(rawBody, signature) {
      const valid = safeEqual(signature || '', sign(rawBody));
      let ev;
      try { ev = JSON.parse(rawBody); } catch { throw bad('Malformed provider event'); }
      if (!valid) {
        if (ev && ev.event_id) db.run('INSERT OR IGNORE INTO payment_provider_events(id, provider, event_id, intent_id, type, payload_json, signature_valid, received_at) VALUES (?,?,?,?,?,?,?,?)', uid(), 'sandbox', `invalid:${ev.event_id}:${uid()}`, ev.intent_id || null, ev.type || '?', rawBody, 0, iso(now()));
        throw new HttpError(401, 'Provider event signature is invalid', undefined, 'bad_signature');
      }
      if (db.get('SELECT 1 x FROM payment_provider_events WHERE event_id = ?', ev.event_id)) return { duplicate: true };
      const i = db.get('SELECT * FROM payment_intents WHERE id = ?', ev.intent_id);
      db.run('INSERT INTO payment_provider_events(id, provider, event_id, intent_id, type, payload_json, signature_valid, received_at) VALUES (?,?,?,?,?,?,?,?)', uid(), ev.provider || 'sandbox', ev.event_id, ev.intent_id, ev.type, rawBody, 1, iso(now()));
      if (!i) return { ignored: true };
      if (i.status !== 'submitted') return { ignored: true, reason: `intent is ${i.status}` };
      if (ev.amount_minor !== i.amount_minor || ev.currency !== i.currency) {
        audit.record(i.org_id, { action: 'payment.provider_mismatch', objectType: 'payment_intent', objectId: i.id, reason: `Provider reported ${ev.amount_minor} ${ev.currency}, expected ${i.amount_minor} ${i.currency}` });
        throw unprocessable('Provider event does not match the payment intent', undefined, 'provider_mismatch');
      }
      if (ev.type === 'payment.succeeded') applySuccess(i, ev); else applyFailure(i, ev);
      db.run('UPDATE payment_provider_events SET processed_at = ? WHERE event_id = ?', iso(now()), ev.event_id);
      if (ev.type === 'payment.succeeded') {
        const tx = db.get('SELECT * FROM payment_transactions WHERE intent_id = ?', i.id);
        svc.postPayment(i.bill_id, i.authorized_by);
        try { svc.reconcileOne(tx.id, null); } catch { /* reconciliation can be rerun */ }
      }
      return { applied: ev.type };
    },

    /** Ledger posting for a settled payment. Independent from the payment itself so it can be retried without paying twice. */
    postPayment(billId, actorId = null) {
      const b = db.get('SELECT * FROM bills WHERE id = ?', billId);
      const tx = db.get('SELECT * FROM payment_transactions WHERE bill_id = ? AND status = ?', billId, 'succeeded');
      if (!tx) return null;
      try {
        let accrual = db.get('SELECT * FROM journal_entries WHERE org_id = ? AND posting_key = ?', b.org_id, `bill:${b.id}:accrual`);
        if (!accrual) { core.svc.bills.postAccrual(billId, actorId); accrual = db.get('SELECT * FROM journal_entries WHERE org_id = ? AND posting_key = ?', b.org_id, `bill:${b.id}:accrual`); }
        if (!accrual) { if (b.source === 'rtfepe') return null; throw unprocessable('Accrual entry is missing; retry posting after fixing the accounting issue', undefined, 'accrual_missing'); }
        const apLine = db.get(`SELECT a.code FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.entry_id = ? AND l.side = 'Cr' AND a.code IN (2110, 2200, 2400) ORDER BY l.amount_minor DESC LIMIT 1`, accrual.id);
        const apCode = apLine ? apLine.code : 2110;
        const r = core.svc.ledger.post(b.org_id, {
          postingKey: `payment:${tx.id}`, sourceType: 'payment', sourceId: tx.id, billId: b.id, sourceDocumentId: b.source_document_id, generatedDocumentId: b.docflow_doc_id, financialEvent: b.financial_event || 'Vendor Payment',
          memo: `Payment ${tx.receipt_no} for ${b.number} (sandbox)`, currency: b.currency, costCenter: b.cost_center, project: b.project, createdBy: actorId,
          lines: [{ code: apCode, side: 'Dr', amountMinor: tx.amount_minor }, { code: 1120, side: 'Cr', amountMinor: tx.amount_minor }],
        });
        db.run("UPDATE bills SET accounting_status = 'posted', accounting_error = NULL WHERE id = ?", b.id);
        return r.entry;
      } catch (e) {
        db.run("UPDATE bills SET accounting_status = 'posting_failed', accounting_error = ? WHERE id = ?", e.message, b.id);
        audit.record(b.org_id, { actorId, actorOrgId: b.org_id, action: 'journal.posting_failed', objectType: 'bill', objectId: b.id, reason: e.message, refs: { code: e.code, paymentTransactionId: tx.id } });
        return null;
      }
    },

    receipt(ctx, intentId) {
      const i = db.get('SELECT * FROM payment_intents WHERE id = ? AND org_id = ?', intentId, ctx.orgId);
      if (!i) throw notFound('Payment');
      const tx = db.get('SELECT * FROM payment_transactions WHERE intent_id = ?', i.id);
      if (!tx) throw conflict('No completed payment for this intent yet');
      const b = db.get('SELECT * FROM bills WHERE id = ?', i.bill_id);
      const w = db.get('SELECT name FROM wallets WHERE id = ?', i.wallet_id);
      const rec = db.get('SELECT status, note FROM reconciliation_records WHERE payment_transaction_id = ?', tx.id);
      const je = db.all("SELECT id FROM journal_entries WHERE org_id = ? AND bill_id = ? ORDER BY created_at", ctx.orgId, b.id).map(e => core.svc.ledger.entryView(db.get('SELECT * FROM journal_entries WHERE id = ?', e.id)));
      return { receiptNo: tx.receipt_no, providerRef: tx.provider_ref, provider: tx.provider, simulated: !!tx.is_simulated, paidAt: tx.created_at, amountMinor: tx.amount_minor, currency: tx.currency, bill: { id: b.id, number: b.number, party: b.party_name, totalMinor: b.total_minor, whtMinor: b.wht_minor },
        wallet: w.name, paidBy: (db.get('SELECT name FROM users WHERE id = ?', i.authorized_by) || {}).name, initiatedBy: (db.get('SELECT name FROM users WHERE id = ?', i.initiated_by) || {}).name, reconciliation: rec || { status: 'pending' }, journals: je, accountingStatus: b.accounting_status };
    },

    /* ----------------------------- reconciliation ----------------------------- */
    reconcileOne(txId, actorId) {
      const tx = db.get('SELECT * FROM payment_transactions WHERE id = ?', txId);
      const ev = db.get(`SELECT payload_json FROM payment_provider_events WHERE intent_id = ? AND type = 'payment.succeeded' AND signature_valid = 1 ORDER BY received_at DESC LIMIT 1`, tx.intent_id);
      const provider = ev ? JSON.parse(ev.payload_json) : null;
      const je = db.get('SELECT id FROM journal_entries WHERE org_id = ? AND posting_key = ?', tx.org_id, `payment:${tx.id}`);
      let status = 'matched', note = 'Provider event, wallet debit and ledger entry agree';
      if (!provider) { status = 'exception'; note = 'No verified provider event on file'; }
      else if (provider.amount_minor !== tx.amount_minor || provider.provider_ref !== tx.provider_ref) { status = 'exception'; note = 'Provider amount or reference differs from the recorded payment'; }
      else if (!je) { status = 'exception'; note = 'Ledger payment entry is missing (posting failed) — retry posting'; }
      else {
        const dr = db.get("SELECT COALESCE(SUM(amount_minor),0) n FROM journal_lines WHERE entry_id = ? AND side = 'Dr'", je.id).n;
        if (dr !== tx.amount_minor) { status = 'exception'; note = 'Ledger amount differs from the payment'; }
      }
      db.run(`INSERT INTO reconciliation_records(id, org_id, payment_transaction_id, bill_id, journal_entry_id, provider_amount_minor, status, note, reconciled_by, created_at, reconciled_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(payment_transaction_id) DO UPDATE SET status = excluded.status, note = excluded.note, journal_entry_id = excluded.journal_entry_id, provider_amount_minor = excluded.provider_amount_minor, reconciled_by = excluded.reconciled_by, reconciled_at = excluded.reconciled_at`,
        uid(), tx.org_id, tx.id, tx.bill_id, je ? je.id : null, provider ? provider.amount_minor : null, status, note, actorId, iso(now()), iso(now()));
      audit.record(tx.org_id, { actorId, actorOrgId: tx.org_id, action: `reconciliation.${status}`, objectType: 'payment_transaction', objectId: tx.id, reason: note, refs: { billId: tx.bill_id, journalEntryId: je && je.id } });
      return { status, note };
    },
    runReconciliation(ctx) {
      ctx.require('reconcile.run');
      const txs = db.all('SELECT id FROM payment_transactions WHERE org_id = ?', ctx.orgId);
      txs.forEach(t => svc.reconcileOne(t.id, ctx.userId));
      return svc.reconciliation(ctx);
    },
    reconciliation(ctx) {
      ctx.require('reconcile.run');
      return db.all(`SELECT r.*, t.receipt_no, t.amount_minor, t.currency, b.number bill_number, b.party_name FROM reconciliation_records r JOIN payment_transactions t ON t.id = r.payment_transaction_id JOIN bills b ON b.id = r.bill_id WHERE r.org_id = ? ORDER BY r.created_at DESC`, ctx.orgId)
        .map(r => ({ id: r.id, receiptNo: r.receipt_no, billNumber: r.bill_number, party: r.party_name, amountMinor: r.amount_minor, currency: r.currency, status: r.status, note: r.note, reconciledAt: r.reconciled_at }));
    },
    transactions(ctx) {
      ctx.require('wallet.view');
      return db.all(`SELECT t.*, b.number bill_number, b.party_name, w.name wallet FROM payment_transactions t JOIN bills b ON b.id = t.bill_id JOIN wallets w ON w.id = t.wallet_id WHERE t.org_id = ? ORDER BY t.created_at DESC`, ctx.orgId)
        .map(t => ({ id: t.id, intentId: t.intent_id, receiptNo: t.receipt_no, providerRef: t.provider_ref, billId: t.bill_id, billNumber: t.bill_number, party: t.party_name, wallet: t.wallet, amountMinor: t.amount_minor, currency: t.currency, status: t.status, simulated: !!t.is_simulated, createdAt: t.created_at,
          reconciliation: (db.get('SELECT status FROM reconciliation_records WHERE payment_transaction_id = ?', t.id) || { status: 'pending' }).status }));
    },
  };

  function applySuccess(i, ev) {
    db.tx(() => {
      const w = db.get('SELECT * FROM wallets WHERE id = ?', i.wallet_id);
      const bal = w.balance_minor - i.amount_minor;
      db.run('UPDATE wallets SET balance_minor = ?, reserved_minor = reserved_minor - ? WHERE id = ?', bal, i.amount_minor, w.id);
      db.run("UPDATE wallet_reservations SET status = 'captured' WHERE payment_intent_id = ?", i.id);
      const txId = uid();
      const receiptNo = `RCT-${now().getUTCFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      db.insert('payment_transactions', { id: txId, org_id: i.org_id, intent_id: i.id, bill_id: i.bill_id, wallet_id: w.id, amount_minor: i.amount_minor, currency: i.currency, provider: 'sandbox', provider_ref: ev.provider_ref, receipt_no: receiptNo, status: 'succeeded', is_simulated: 1, created_at: iso(now()) });
      db.insert('wallet_transactions', { id: uid(), org_id: i.org_id, wallet_id: w.id, kind: 'debit', amount_minor: i.amount_minor, balance_after_minor: bal, payment_intent_id: i.id, ref: `DEB-${txId}`, memo: `Payment ${receiptNo} (sandbox)`, created_at: iso(now()) });
      db.run("UPDATE payment_intents SET status = 'succeeded', provider_ref = ?, updated_at = ? WHERE id = ?", ev.provider_ref, iso(now()), i.id);
      const b = db.get('SELECT * FROM bills WHERE id = ?', i.bill_id);
      db.run("UPDATE bills SET payment_status = 'paid', paid_at = ? WHERE id = ?", iso(now()), b.id);
      core.svc.bills.settleBudget(b);
      if (b.invoice_id) core.svc.commerce.markInvoicePaid(b.invoice_id);
      db.run("UPDATE purchase_orders SET status = 'closed' WHERE id = ? AND status IN ('issued','received')", b.purchase_order_id);
      audit.record([i.org_id, b.vendor_org_id].filter(Boolean), { actorId: i.authorized_by, actorOrgId: i.org_id, action: 'payment.succeeded', objectType: 'payment_intent', objectId: i.id, prior: { status: 'submitted' }, next: { status: 'succeeded', receiptNo, providerRef: ev.provider_ref, amountMinor: i.amount_minor }, refs: { billId: b.id, invoiceId: b.invoice_id, paymentTransactionId: txId } });
      if (b.invoice_id) {
        const inv = db.get('SELECT request_id, number FROM invoices WHERE id = ?', b.invoice_id);
        const ch = inv && db.get("SELECT id FROM channels WHERE kind='transaction' AND ref_type='request' AND ref_id = ?", inv.request_id);
        if (ch) core.svc.chat.systemMessage(ch.id, `Invoice ${inv.number} paid — receipt ${receiptNo} (sandbox payment)`);
      }
    });
  }
  function applyFailure(i, ev) {
    db.tx(() => {
      db.run('UPDATE wallets SET reserved_minor = MAX(0, reserved_minor - ?) WHERE id = ?', i.amount_minor, i.wallet_id);
      db.run("UPDATE wallet_reservations SET status = 'released' WHERE payment_intent_id = ?", i.id);
      db.run("UPDATE payment_intents SET status = 'failed', failure_code = ?, failure_reason = ?, provider_ref = ?, updated_at = ? WHERE id = ?", ev.code || 'failed', ev.reason || 'Payment failed', ev.provider_ref, iso(now()), i.id);
      db.run("UPDATE bills SET payment_status = 'unpaid' WHERE id = ?", i.bill_id);
      audit.record(i.org_id, { actorId: i.authorized_by, actorOrgId: i.org_id, action: 'payment.failed', objectType: 'payment_intent', objectId: i.id, prior: { status: 'submitted' }, next: { status: 'failed', code: ev.code }, reason: ev.reason || '', refs: { billId: i.bill_id } });
      core.notify([i.initiated_by, i.authorized_by], { orgId: i.org_id, kind: 'payment', title: 'Payment failed — no funds were debited', body: ev.reason || '', link: `#/e/bills/${i.bill_id}` });
    });
  }
  return svc;
};
