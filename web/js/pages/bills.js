import { h, state, get, post, patch, api, route, navigate, clear, fmt, major, dt, day, cap, badge, tag, table, kv, stat, pageHead, toast, errToast, formModal, modal, confirmBox, field, can, showIssues } from '../core.js';

const rid = () => 'k' + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now());
const SANDBOX = () => h('div', { class: 'row' }, tag('Sandbox', 'sandbox'), h('span', { class: 'small muted' }, 'Simulated balances and a sandbox payment provider — no real money moves.'));

/* ---------------------------------------------------------------- payment flow */
export async function payFlow(bill, { scan, wallets: pre } = {}) {
  const wallets = pre || await get('/wallets');
  const key = rid();
  const state_ = { walletId: null, intent: null };
  return new Promise(resolve => modal(close => {
    const body = h('div', { class: 'stack' });
    const done = v => { close(); resolve(v); };
    const showResult = async intent => {
      clear(body);
      if (intent.status === 'succeeded') {
        const r = await get(`/payments/intents/${intent.id}/receipt`);
        body.append(h('div', { class: 'notice ok' }, h('b', null, 'Payment successful'), ` — ${r.receiptNo} (sandbox)`), kv([['Paid to', r.bill.party], ['Bill', r.bill.number], ['Amount', fmt(r.amountMinor, r.currency)], ['Wallet', r.wallet], ['Provider ref', r.providerRef], ['Reconciliation', badge(r.reconciliation.status)], ['Ledger', badge(r.accountingStatus)]]),
          h('div', { class: 'row' }, h('a', { class: 'btn primary', href: `#/e/receipt/${intent.id}`, onclick: () => done(true) }, 'View receipt'), h('button', { class: 'btn', onclick: () => { done(true); navigate(location.hash); } }, 'Close')));
      } else if (intent.status === 'failed') {
        body.append(h('div', { class: 'notice bad' }, h('b', null, 'Payment failed — no funds were debited. '), intent.failureReason), h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => { state_.intent = null; choose(); } }, 'Try another wallet'), h('button', { class: 'btn', onclick: () => { done(false); navigate(location.hash); } }, 'Close')));
      } else if (intent.status === 'submitted') {
        body.append(h('div', { class: 'notice warn' }, 'The provider has not confirmed yet. Funds are reserved, not debited. Status updates only after a verified provider result.'), h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => showResult(await post(`/payments/intents/${intent.id}/refresh`)) }, 'Check status'), h('button', { class: 'btn', onclick: () => done(false) }, 'Close')));
      } else {
        body.append(h('div', { class: 'notice info' }, `Payment request ${cap(intent.status)}. A user with payment authority must authorise it.`), h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/e/wallets', onclick: () => done(false) }, 'See pending payments'), h('button', { class: 'btn', onclick: () => done(false) }, 'Close')));
      }
    };
    const authenticate = intent => {
      clear(body);
      const pw = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Your password', 'aria-label': 'Password' });
      body.append(h('h2', null, 'Authenticate to pay'), h('p', { class: 'muted' }, `Re-enter your password to authorise ${fmt(intent.amountMinor, intent.currency)} to ${intent.party}.`), pw, SANDBOX(),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async e => { e.target.disabled = true; try { showResult(await post(`/payments/intents/${intent.id}/execute`, { password: pw.value })); } catch (er) { errToast(er); e.target.disabled = false; } } }, 'Pay now'), h('button', { class: 'btn', onclick: () => done(false) }, 'Cancel')));
      pw.focus();
    };
    const confirmScreen = w => {
      clear(body);
      const after = w.availableMinor - bill.payableMinor;
      body.append(h('h2', null, 'Confirm payment'), h('div', { class: 'card flat' }, kv([['Vendor / payee', bill.party], ['Invoice / bill', bill.number], ['Currency', bill.currency], bill.whtMinor ? ['Gross', fmt(bill.totalMinor, bill.currency)] : null, bill.whtMinor ? ['Less withholding tax', fmt(bill.whtMinor, bill.currency)] : null, ['Amount to pay', h('b', null, fmt(bill.payableMinor, bill.currency))], ['Due', day(bill.dueDate)], ['Wallet', w.name], ['Available after', fmt(after, w.currency)], ['Method', scan ? 'Invoice QR code' : 'Bill page']])),
        SANDBOX(), h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async e => { e.target.disabled = true; try { const i = await post('/payments/intents', { billId: bill.id, walletId: w.id, idempotencyKey: key + w.id.slice(0, 6), scanId: scan }); state_.intent = i; if (i.status === 'succeeded') return showResult(i); if (i.status === 'awaiting_authorization') return showResult(i); can('payment.execute') ? authenticate(i) : showResult(i); } catch (er) { errToast(er); e.target.disabled = false; } } }, 'Confirm payment'), h('button', { class: 'btn', onclick: choose }, 'Back')));
    };
    const choose = () => {
      clear(body);
      body.append(h('h2', null, `Pay ${bill.number}`), h('p', { class: 'muted' }, `${bill.party} · ${fmt(bill.payableMinor, bill.currency)}`), h('div', { class: 'stack tight' }, wallets.filter(w => w.currency === bill.currency).map(w => {
        const reasons = []; if (w.status !== 'active') reasons.push('Wallet is frozen'); if (w.availableMinor < bill.payableMinor) reasons.push(`Insufficient balance (${fmt(w.availableMinor, w.currency)} available)`); if (w.perTxnLimitMinor && bill.payableMinor > w.perTxnLimitMinor) reasons.push('Over the per-transaction limit');
        const kindOk = (bill.source === 'expense' || bill.beneficiaryUserId) ? ['reimbursement', 'opex'].includes(w.kind) : w.kind === bill.classification; if (!kindOk) reasons.push(`Not a ${bill.classification.toUpperCase()} wallet`);
        return h('button', { class: 'card flat row between', style: { textAlign: 'left', cursor: reasons.length ? 'not-allowed' : 'pointer', opacity: reasons.length ? .65 : 1 }, disabled: false, onclick: () => (reasons.length ? toast(reasons[0], true) : confirmScreen(w)) }, h('div', null, h('b', null, w.name), h('div', { class: 'small muted' }, `${w.kind.toUpperCase()} · available ${fmt(w.availableMinor, w.currency)}`), reasons.length ? h('div', { class: 'small', style: { color: 'var(--bad)' } }, reasons.join(' · ')) : null), reasons.length ? badge('failed', 'Unavailable') : badge('active', 'Select'));
      })), h('button', { class: 'btn', onclick: () => done(false) }, 'Cancel'));
    };
    choose();
    return body;
  }));
}

/* ---------------------------------------------------------------- bills list / detail */
async function billsList(ctx) {
  const cls = ctx.query.c, st = ctx.query.s;
  const bills = await get(`/bills${cls || st ? `?${new URLSearchParams({ ...(cls ? { classification: cls } : {}), ...(st ? { status: st } : {}) })}` : ''}`);
  const sts = ['received', 'pending_approval', 'approved', 'rejected', 'disputed', 'quarantined'];
  return h('div', { class: 'stack' }, pageHead(cls ? `${cls.toUpperCase()} bills` : 'Bills', 'Payable bills from vendor invoices, approved documents and expense claims. Only approved, unpaid bills can be paid.'),
    h('div', { class: 'row wrap' }, h('a', { class: `chip ${!st ? 'on' : ''}`, href: `#/e/bills${cls ? `?c=${cls}` : ''}` }, 'All'), sts.map(s => h('a', { class: 'chip', style: st === s ? { background: 'var(--forest-800)', color: '#fff' } : null, href: `#/e/bills?${cls ? `c=${cls}&` : ''}s=${s}` }, cap(s)))),
    table([{ label: 'Bill', render: b => h('div', null, h('b', null, b.number), h('div', { class: 'small muted' }, cap(b.source === 'rtfepe' ? 'document' : b.source))) }, { label: 'Payee', render: b => h('div', null, b.party, b.isDemo && ' ', b.isPayable === false && tag('DEMO — NOT PAYABLE', 'demo')) },
      { label: 'Class', render: b => tag(b.classification.toUpperCase()) }, { label: 'Cost centre', key: 'costCenter' }, { label: 'Status', render: b => h('div', { class: 'row wrap' }, badge(b.status), b.overdue && badge('overdue')) }, { label: 'Payment', render: b => badge(b.paymentStatus) },
      { label: 'Ledger', render: b => (b.accountingStatus === 'none' ? '—' : badge(b.accountingStatus)) }, { label: 'Due', render: b => day(b.dueDate) }, { label: 'Payable', right: true, render: b => fmt(b.payableMinor, b.currency) }], bills, { onRow: b => navigate(`#/e/bills/${b.id}`), empty: 'No bills match.' }));
}

const STEPS = [['Received', b => true], ['Validated & submitted', b => ['pending_approval', 'approved', 'rejected'].includes(b.status) || b.paymentStatus === 'paid'], ['Expenditure approved', b => b.status === 'approved'], ['Paid', b => b.paymentStatus === 'paid'], ['Posted to ledger', b => b.accountingStatus === 'posted' && b.paymentStatus === 'paid']];

async function billDetail(ctx) {
  const id = ctx.params[0];
  const b = await get(`/bills/${id}`);
  const reload = () => navigate(location.hash);
  const act = (label, path, { cls = 'btn', body, prompt, confirm } = {}) => h('button', { class: cls, onclick: async () => { try { let x = body || {}; if (prompt) { const r = window.prompt(prompt); if (r === null) return; x = { ...x, reason: r }; } if (confirm && !(await confirmBox(confirm))) return; await post(`/bills/${id}/${path}`, x); toast(`${label} — done`); reload(); } catch (e) { errToast(e); } } }, label);
  const A = new Set(b.canActOn);
  const errs = b.checks.errors, warns = b.checks.warnings;
  const stepper = h('div', { class: 'steps' }, STEPS.map(([l, f], i) => { const done = f(b); const prev = i === 0 || STEPS[i - 1][1](b); return h('div', { class: `step ${done ? 'done' : prev && !['rejected', 'disputed', 'cancelled', 'quarantined', 'superseded'].includes(b.status) ? 'cur' : ''}` }, h('b', null, l), done ? 'Done' : ''); }));
  // validation form (classification, cost centre, accounts)
  const validation = A.has('validate') ? (() => {
    const cls = h('select', { 'aria-label': 'Classification' }, ['opex', 'capex'].map(c => h('option', { value: c, selected: b.classification === c }, c.toUpperCase())));
    const cc = h('input', { value: b.costCenter, placeholder: 'e.g. CC-IT-40' }), project = h('input', { value: b.project, placeholder: 'Project (optional)' });
    const accts = {}; const lineInputs = b.lines.map(l => { const i = h('input', { type: 'number', value: l.accountCode || '', placeholder: 'GL code', style: { maxWidth: '110px' }, 'aria-label': `Account for ${l.description}` }); accts[l.id] = i; return h('div', { class: 'row between' }, h('span', { class: 'small' }, l.description), i); });
    return h('div', { class: 'card stack' }, h('h2', null, 'Finance validation'), h('p', { class: 'small muted' }, 'Set classification and coding. The commercial total cannot be changed: that needs a revised vendor document.'),
      h('div', { class: 'grid c3' }, h('label', { class: 'f' }, 'Classification', cls), h('label', { class: 'f' }, 'Cost centre', cc), h('label', { class: 'f' }, 'Project', project)), h('div', { class: 'stack tight' }, h('b', { class: 'small' }, 'Account codes (CAPEX → asset accounts 1500–1599, OPEX → expense accounts 6000–6999)'), lineInputs),
      h('button', { class: 'btn', onclick: async () => { try { const lineAccounts = Object.fromEntries(Object.entries(accts).filter(([, i]) => i.value).map(([k, i]) => [k, i.value])); await patch(`/bills/${id}`, { classification: cls.value, costCenter: cc.value, project: project.value, lineAccounts }); toast('Saved'); reload(); } catch (e) { errToast(e); } } }, 'Save classification'));
  })() : null;
  const wf = b.workflow ? h('div', { class: 'card stack' }, h('div', { class: 'row between' }, h('h2', null, 'Expenditure approval'), badge(b.workflow.status)), h('p', { class: 'small muted' }, 'Route set by the active finance policy (FIN-POL-001). Each step must be given by a different, authorised person; requesters and submitters cannot approve.'),
    h('div', { class: 'steps' }, b.workflow.steps.map(s => h('div', { class: `step ${s.status === 'approved' ? 'done' : s.status === 'rejected' ? '' : 'cur'}`, style: s.status === 'rejected' ? { background: 'var(--bad-bg)' } : null }, h('b', null, s.label), s.decision ? `${cap(s.decision.decision)} by ${s.decision.actor}` : `Needs: ${s.allowedRoles.map(cap).join(' / ')}`)))) : null;
  const payBtn = A.has('pay') && h('button', { class: 'btn ok', onclick: async () => { await payFlow(b); } }, `Pay ${fmt(b.payableMinor, b.currency)}`);
  const out = h('div', { class: 'stack loose' }, h('a', { href: '#/e/bills' }, '← All bills'),
    pageHead(`${b.number}`, `${b.party} · ${cap(b.source === 'rtfepe' ? 'document' : b.source)}`, [badge(b.status), badge(b.paymentStatus), b.accountingStatus !== 'none' && badge(b.accountingStatus), tag(b.classification.toUpperCase()), b.isDemo && tag('Demo', 'demo'), !b.isPayable && tag('DEMO — NOT PAYABLE', 'demo')]),
    stepper,
    b.quarantineReason && h('div', { class: 'notice bad' }, h('b', null, 'Quarantined: '), b.quarantineReason),
    b.accountingStatus === 'posting_failed' && h('div', { class: 'notice bad' }, h('b', null, 'Ledger posting failed: '), b.accountingError, ' ', can('ledger.post') ? 'The payment state is unaffected; retry posting after fixing the issue.' : ''),
    b.vendorBankChangedRecently && h('div', { class: 'notice warn' }, 'This vendor changed its payment details in the last 30 days. Verify with a known contact before paying.'),
    errs.length || warns.length ? h('div', { class: 'card stack' }, h('h2', null, 'Controls & warnings'), errs.map(e => h('div', { class: 'notice bad small' }, e.msg, e.ref && h('span', { class: 'muted' }, `  (${e.ref})`))), warns.map(e => h('div', { class: 'notice warn small' }, e.msg))) : null,
    h('div', { class: 'grid c2' }, h('div', { class: 'card stack' }, h('h2', null, 'Details'), kv([['Payee', b.party], b.invoice && ['Vendor invoice', h('a', { href: `#/e/documents/i/${b.invoice.id}` }, `${b.invoice.number} v${b.invoice.version}`)], b.purchaseOrder && ['Purchase order', `${b.purchaseOrder.number} (${b.purchaseOrder.status})`], b.purchaseRef && ['Purchase reference', b.purchaseRef],
      ['Requested by', b.requestedBy], ['Department', b.department], ['Cost centre', b.costCenter], b.project && ['Project', b.project], ['Due', day(b.dueDate)], b.invoice && ['Receipt confirmed', b.receiptConfirmed ? `Yes — ${b.receiptConfirmedBy}` : 'Not yet'], b.financialEvent && ['Financial event', `${b.financialEvent}${b.matchedPhrase ? ` ← “${b.matchedPhrase}”` : ''}`], ['Created', dt(b.createdAt)], b.approvedAt && ['Approved', dt(b.approvedAt)], b.paidAt && ['Paid', dt(b.paidAt)]])),
      h('div', { class: 'card stack' }, h('h2', null, 'Amounts'), h('dl', { class: 'kv' }, h('dt', null, 'Subtotal'), h('dd', null, fmt(b.subtotalMinor, b.currency)), h('dt', null, 'VAT'), h('dd', null, fmt(b.taxMinor, b.currency)), h('dt', null, 'Total'), h('dd', null, h('b', null, fmt(b.totalMinor, b.currency))), b.whtMinor ? [h('dt', null, 'Withholding tax'), h('dd', null, `-${fmt(b.whtMinor, b.currency)}`)] : null, h('dt', null, 'Payable now'), h('dd', null, h('b', null, fmt(b.payableMinor, b.currency)))),
        b.latestIntent && h('div', { class: 'small muted' }, `Latest payment: ${cap(b.latestIntent.status)}${b.latestIntent.failure_reason ? ` — ${b.latestIntent.failure_reason}` : ''}`))),
    table([{ label: 'Line', render: l => h('div', null, l.description, l.financialEvent && h('div', { class: 'small muted' }, l.financialEvent)) }, { label: 'GL', render: l => l.accountCode || '—' }, { label: 'Net', right: true, render: l => fmt(l.netMinor, b.currency) }, { label: 'VAT', right: true, render: l => fmt(l.taxMinor, b.currency) }, { label: 'Total', right: true, render: l => fmt(l.totalMinor, b.currency) }], b.lines),
    validation, wf,
    h('div', { class: 'row wrap' }, A.has('confirm_receipt') && act('Confirm goods / service received', 'confirm-receipt', { cls: 'btn' }), A.has('submit') && act('Submit for approval', 'submit', { cls: 'btn primary' }), payBtn,
      A.has('dispute') && act('Dispute with vendor', 'dispute', { cls: 'btn danger', prompt: 'What is wrong with this bill?' }), A.has('reopen') && act('Reopen for correction', 'reopen'), A.has('release_quarantine') && act('Approve exception & release', 'release-quarantine', { cls: 'btn', prompt: 'Document the exception reason' }),
      b.accountingStatus === 'posting_failed' && can('ledger.post') && act('Retry ledger posting', 'retry-posting', { cls: 'btn primary' }), can('audit.view') && h('a', { class: 'btn', href: `#/f/trace/${b.id}` }, 'Audit trace')),
    b.decisions.length ? h('div', { class: 'card' }, h('h2', null, 'Decision record'), h('div', { class: 'timeline' }, b.decisions.map(d => h('div', null, h('b', null, cap(d.decision)), ` — ${d.actor}`, h('div', { class: 'small muted' }, `${dt(d.at)}${d.comment ? ` · ${d.comment}` : ''}`))))) : null);
  return out;
}

/* ---------------------------------------------------------------- approvals */
async function approvalsPage() {
  const items = await get('/approvals');
  const decide = (a, decision) => async () => { try { let comment = ''; if (decision === 'rejected') { comment = window.prompt('Reason for rejection'); if (!comment) return; } await post(`/approvals/${a.stepId}/decide`, { decision, comment }); toast(`${cap(decision)}`); navigate(location.hash); } catch (e) { errToast(e); } };
  return h('div', { class: 'stack' }, pageHead('Approval queue', 'Expenditure approvals for the steps your role can fill. Vendor approval of the document, your approval of the spend, and the wallet payment are separate controls.'),
    table([{ label: 'Bill', render: a => h('a', { href: `#/e/bills/${a.billId}` }, a.number) }, { label: 'Payee', key: 'party' }, { label: 'Class', render: a => tag(a.classification.toUpperCase()) }, { label: 'Cost centre', key: 'costCenter' }, { label: 'Step', key: 'step' }, { label: 'Amount', right: true, render: a => fmt(a.totalMinor, a.currency) },
      { label: '', render: a => a.blockedReason ? h('span', { class: 'small', style: { color: 'var(--bad)' } }, a.blockedReason) : h('div', { class: 'row' }, h('button', { class: 'btn ok sm', onclick: decide(a, 'approved') }, 'Approve'), h('button', { class: 'btn danger sm', onclick: decide(a, 'rejected') }, 'Reject')) }], items, { empty: 'Nothing is waiting for your role.' }));
}

/* ---------------------------------------------------------------- expenses */
async function expensesPage() {
  const [bills, ccs] = await Promise.all([get('/bills'), get('/cost-centers')]);
  const mine = bills.filter(b => b.source === 'expense');
  const form = h('form', { class: 'stack', onsubmit: async e => { e.preventDefault(); const fd = new FormData(form); try { await api('POST', '/expenses', fd); toast('Expense submitted for finance review'); navigate(location.hash); } catch (er) { errToast(er); } } },
    field({ name: 'description', label: 'What was the expense for?', required: true }), h('div', { class: 'grid c2' }, field({ name: 'category', label: 'Category', type: 'select', options: ['travel', 'utilities', 'professional', 'it', 'office', 'general'] }), field({ name: 'amount', label: `Amount (${state.me.org.currency})`, type: 'number', step: '0.01', min: '0.01', required: true })),
    h('div', { class: 'grid c2' }, field({ name: 'incurredOn', label: 'Date incurred', type: 'date', required: true, value: new Date().toISOString().slice(0, 10) }), field({ name: 'costCenter', label: 'Cost centre', type: 'select', options: ccs.map(c => ({ value: c.code, label: `${c.code} — ${c.name}`, selected: c.code === state.me.costCenter })), value: state.me.costCenter })),
    h('label', { class: 'f' }, 'Receipt (PDF, image)', h('input', { type: 'file', name: 'file', accept: '.pdf,.png,.jpg,.jpeg' })), h('div', { class: 'small muted' }, 'Personal expenses are not reimbursable (EXP-POL-001). You cannot approve or pay your own claim.'), h('button', { class: 'btn primary', type: 'submit' }, 'Submit expense'));
  return h('div', { class: 'stack loose' }, pageHead('Employee expenses', 'Reimbursement claims go through the same validation, approval and payment controls as vendor bills.'), h('div', { class: 'grid c2' }, h('div', { class: 'card' }, h('h2', null, 'New expense'), form),
    h('div', { class: 'card stack' }, h('h2', null, 'My claims'), table([{ label: 'Claim', render: b => h('a', { href: `#/e/bills/${b.id}` }, b.number) }, { label: 'Status', render: b => badge(b.status) }, { label: 'Payment', render: b => badge(b.paymentStatus) }, { label: 'Amount', right: true, render: b => fmt(b.totalMinor, b.currency) }], mine, { empty: 'No claims yet.' }))));
}

/* ---------------------------------------------------------------- wallets & transactions */
async function walletsPage() {
  const [ws, intents, bills] = await Promise.all([get('/wallets'), get('/payments/intents'), can('bill.view') ? get('/bills?status=approved') : []]);
  const pending = intents.filter(i => ['created', 'awaiting_authorization', 'submitted'].includes(i.status));
  const card = w => h('div', { class: 'stack tight' }, h('div', { class: `wallet ${w.kind}` }, h('span', { class: 'sim' }, 'SIMULATED'), h('div', { class: 'small' }, `${w.kind.toUpperCase()}${w.status === 'frozen' ? ' · FROZEN' : ''}${w.sandboxBehavior !== 'normal' ? ` · test: ${w.sandboxBehavior}` : ''}`), h('div', { style: { fontWeight: 700 } }, w.name), h('div', { class: 'bal' }, fmt(w.availableMinor, w.currency)),
    h('div', { class: 'small' }, `Balance ${fmt(w.balanceMinor, w.currency)} · reserved ${fmt(w.reservedMinor, w.currency)}`), h('div', { class: 'small' }, `Limit/txn ${w.perTxnLimitMinor ? fmt(w.perTxnLimitMinor, w.currency) : 'none'} · dual control ≥ ${w.dualControlMinor ? fmt(w.dualControlMinor, w.currency) : 'off'}`)),
    h('div', { class: 'row wrap' }, h('button', { class: 'btn sm', onclick: async () => showTx(w) }, 'Transactions'), h('a', { class: 'btn sm', href: `/api/wallets/${w.id}/statement.csv` }, 'Statement CSV'),
      can('wallet.manage') && [h('button', { class: 'btn sm', onclick: () => formModal('Top up (sandbox)', [{ name: 'amount', label: `Amount (${w.currency}) — simulated funds`, type: 'number', step: '0.01', min: '1', required: true }], async d => { await post(`/wallets/${w.id}/topup`, { amountMinor: Math.round(Number(d.amount) * 100) }); toast('Simulated funds added'); navigate(location.hash); }) }, 'Top up'),
        h('button', { class: 'btn sm', onclick: () => formModal('Wallet limits', [{ name: 'limit', label: 'Per-transaction limit (0 = none)', type: 'number', value: w.perTxnLimitMinor / 100 }, { name: 'dual', label: 'Dual control from amount (0 = off)', type: 'number', value: w.dualControlMinor / 100 }, { name: 'status', label: 'Status', type: 'select', options: ['active', 'frozen'], value: w.status }, { name: 'beh', label: 'Sandbox behaviour (testing)', type: 'select', options: ['normal', 'decline', 'timeout'], value: w.sandboxBehavior }],
          async d => { await patch(`/wallets/${w.id}`, { perTxnLimitMinor: Math.round(d.limit * 100), dualControlMinor: Math.round(d.dual * 100), status: d.status, sandboxBehavior: d.beh }); navigate(location.hash); }) }, 'Limits')]));
  const showTx = async w => { const tx = await get(`/wallets/${w.id}/transactions`); modal(close => h('div', { class: 'stack' }, h('h2', null, w.name), tag('Simulated balances', 'sandbox'), table([{ label: 'Date', render: t => dt(t.createdAt) }, { label: 'Type', render: t => cap(t.kind) }, { label: 'Memo', key: 'memo' }, { label: 'Amount', right: true, render: t => fmt(t.amountMinor, w.currency) }, { label: 'Balance', right: true, render: t => fmt(t.balanceAfterMinor, w.currency) }], tx), h('button', { class: 'btn', onclick: close }, 'Close')), { wide: true }); };
  const ready = bills.filter(b => b.paymentStatus === 'unpaid');
  return h('div', { class: 'stack loose' }, pageHead('Wallets & payments', 'Company-controlled wallet accounts per business. Balances are simulated in this sandbox build; production uses a licensed payment provider.',
    [SANDBOX(), can('wallet.manage') && h('button', { class: 'btn primary', onclick: () => formModal('New wallet', [{ name: 'name', label: 'Name', required: true }, { name: 'kind', label: 'Kind', type: 'select', options: ['opex', 'capex', 'reimbursement'] }, { name: 'limit', label: 'Per-transaction limit (0 = none)', type: 'number', value: 0 }], async d => { await post('/wallets', { name: d.name, kind: d.kind, perTxnLimitMinor: Math.round(d.limit * 100) }); navigate(location.hash); }) }, 'New wallet')]),
    h('div', { class: 'auto-grid' }, ws.map(card)),
    pending.length ? h('div', { class: 'stack' }, h('h2', null, 'Payments waiting'), table([{ label: 'Bill', render: i => h('a', { href: `#/e/bills/${i.billId}` }, i.billNumber) }, { label: 'Payee', key: 'party' }, { label: 'Wallet', key: 'wallet' }, { label: 'Amount', right: true, render: i => fmt(i.amountMinor, i.currency) }, { label: 'Initiated by', key: 'initiatedBy' }, { label: 'Status', render: i => badge(i.status) },
      { label: '', render: i => (can('payment.execute') && i.status !== 'submitted' ? h('button', { class: 'btn ok sm', onclick: async () => { const b = await get(`/bills/${i.billId}`); authorise(i, b); } }, 'Authorise & pay') : i.status === 'submitted' ? h('button', { class: 'btn sm', onclick: async () => { await post(`/payments/intents/${i.id}/refresh`); navigate(location.hash); } }, 'Check status') : null) }], pending)) : null,
    ready.length ? h('div', { class: 'stack' }, h('h2', null, 'Approved bills ready to pay'), table([{ label: 'Bill', render: b => h('a', { href: `#/e/bills/${b.id}` }, b.number) }, { label: 'Payee', key: 'party' }, { label: 'Class', render: b => tag(b.classification.toUpperCase()) }, { label: 'Due', render: b => day(b.dueDate) }, { label: 'Payable', right: true, render: b => fmt(b.payableMinor, b.currency) }], ready, { onRow: b => navigate(`#/e/bills/${b.id}`) })) : null);
}
async function authorise(i, b) {
  modal(close => { const pw = h('input', { type: 'password', placeholder: 'Your password', autocomplete: 'current-password' }); const out = h('div', { class: 'stack' }, h('h2', null, 'Authenticate to pay'), h('p', null, `${fmt(i.amountMinor, i.currency)} to ${i.party} from ${i.wallet}.`), pw, SANDBOX(),
    h('div', { class: 'row' }, h('button', { class: 'btn ok', onclick: async e => { e.target.disabled = true; try { const r = await post(`/payments/intents/${i.id}/execute`, { password: pw.value }); close(); toast(r.status === 'succeeded' ? `Paid — ${r.receiptNo}` : `Payment ${r.status}`, r.status === 'failed'); navigate(location.hash); } catch (er) { errToast(er); e.target.disabled = false; } } }, 'Pay now'), h('button', { class: 'btn danger', onclick: async () => { await post(`/payments/intents/${i.id}/cancel`); close(); navigate(location.hash); } }, 'Cancel payment'), h('button', { class: 'btn', onclick: close }, 'Close'))); setTimeout(() => pw.focus(), 30); return out; });
  void b;
}

async function transactionsPage() {
  const tx = await get('/transactions');
  return h('div', { class: 'stack' }, pageHead('Transactions', 'Completed payments with provider references and reconciliation status.', SANDBOX()),
    table([{ label: 'Receipt', render: t => h('a', { href: `#/e/receipt/${t.intentId}` }, t.receiptNo) }, { label: 'Date', render: t => dt(t.createdAt) }, { label: 'Bill', render: t => h('a', { href: `#/e/bills/${t.billId}` }, t.billNumber) }, { label: 'Payee', key: 'party' }, { label: 'Wallet', key: 'wallet' }, { label: 'Provider ref', render: t => h('span', { class: 'mono' }, t.providerRef) },
      { label: 'Reconciliation', render: t => badge(t.reconciliation) }, { label: 'Amount', right: true, render: t => fmt(t.amountMinor, t.currency) }], tx, { empty: 'No payments yet.' }));
}
async function receiptPage(ctx) {
  const r = await get(`/payments/intents/${ctx.params[0]}/receipt`);
  return h('div', { class: 'stack' }, h('a', { href: '#/e/transactions' }, '← Transactions'), h('div', { class: 'receipt stack' }, h('div', { class: 'row between' }, h('h1', null, 'Payment receipt'), r.simulated && tag('Sandbox · simulated', 'sandbox')), h('div', { class: 'mono' }, r.receiptNo),
    kv([['Paid to', r.bill.party], ['Bill', r.bill.number], ['Amount paid', h('b', null, fmt(r.amountMinor, r.currency))], r.bill.whtMinor ? ['Withholding tax retained', fmt(r.bill.whtMinor, r.currency)] : null, ['Wallet', r.wallet], ['Initiated by', r.initiatedBy], ['Authorised by', r.paidBy], ['Paid at', dt(r.paidAt)], ['Provider', `${r.provider} · ${r.providerRef}`], ['Reconciliation', badge(r.reconciliation.status)], ['Ledger posting', badge(r.accountingStatus)]]),
    r.journals.length ? h('div', null, h('h3', null, 'Journal entries'), r.journals.map(j => h('div', { class: 'small' }, h('b', null, j.number), ` · ${j.memo}`, h('table', { class: 'journal' }, h('tbody', null, j.lines.map(l => h('tr', null, h('td', null, l.side), h('td', null, `${l.code} ${l.account}`), h('td', { class: 'right' }, fmt(l.amountMinor, j.currency))))))))) : null,
    h('button', { class: 'btn', onclick: () => window.print() }, 'Print')));
}

/* ---------------------------------------------------------------- QR scanner */
async function scanPage() {
  const out = h('div', { class: 'phone stack' });
  const result = h('div', { class: 'stack' });
  let stream = null, stop = false;
  const resolve = async token => {
    token = String(token || '').trim(); const m = token.match(/[#?&]t=([^&\s]+)/); if (m) token = decodeURIComponent(m[1]);
    if (!token) return toast('No QR payload found', true);
    stop = true; if (stream) stream.getTracks().forEach(t => t.stop());
    try {
      const r = await post('/qr/resolve', { token });
      const bill = await get(`/bills/${r.billId}`);
      clear(result);
      result.append(h('div', { class: 'card stack' }, h('div', { class: 'row between' }, h('h2', null, 'Verified invoice'), badge(r.vendor.kybStatus, `Vendor ${cap(r.vendor.kybStatus)}`)), kv([['Vendor', r.vendor.name], ['Invoice', r.invoice.number], ['Currency', r.invoice.currency], ['Total', fmt(r.invoice.totalMinor, r.invoice.currency)], r.invoice.whtMinor ? ['Withholding tax', `-${fmt(r.invoice.whtMinor, r.invoice.currency)}`] : null, ['Payable', h('b', null, fmt(r.invoice.payableMinor, r.invoice.currency))], ['Due', day(r.invoice.dueDate)], ['Invoice status', badge(r.invoice.status)], ['Bill', h('a', { href: `#/e/bills/${r.billId}` }, `${r.billNumber} · ${cap(r.billStatus)}`)], ['Payment', badge(r.paymentStatus)]]),
        r.eligible ? h('div', { class: 'stack' }, h('div', { class: 'notice ok small' }, 'Eligible: approved, unpaid and within limits. Pick an authorised wallet to continue.'), h('button', { class: 'btn ok', onclick: () => payFlow(bill, { scan: r.scanId, wallets: r.wallets }) }, 'Choose wallet & pay'))
          : h('div', { class: 'stack' }, r.reasons.map(x => h('div', { class: 'notice bad' }, x.msg)), h('a', { class: 'btn', href: `#/e/bills/${r.billId}` }, 'Open bill'))));
    } catch (e) { clear(result); result.append(h('div', { class: 'notice bad' }, e.message), h('button', { class: 'btn', onclick: () => navigate(location.hash) }, 'Scan again')); }
  };
  const video = h('video', { playsinline: true, muted: true, 'aria-label': 'Camera preview' });
  const box = h('div', { class: 'scan-box' }, h('span', null, 'Camera preview'), h('div', { class: 'frame' }));
  const hasDetector = 'BarcodeDetector' in window;
  const startCam = async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); video.srcObject = stream; await video.play(); box.replaceChildren(video, h('div', { class: 'frame' }));
      if (hasDetector) { const det = new BarcodeDetector({ formats: ['qr_code'] }); const tick = async () => { if (stop) return; try { const codes = await det.detect(video); if (codes.length) return resolve(codes[0].rawValue); } catch { /* keep scanning */ } requestAnimationFrame(tick); }; tick(); }
      else toast('This browser cannot decode QR codes from the camera. Upload a photo or paste the link below.', true);
    } catch { toast('Camera unavailable — upload a photo of the QR or paste the link.', true); }
  };
  const fileIn = h('input', { type: 'file', accept: 'image/*', capture: 'environment', style: { display: 'none' }, id: 'qrfile', onchange: async e => { const f = e.target.files[0]; if (!f) return; if (!hasDetector) return toast('QR image decoding is not supported in this browser — paste the link instead.', true); try { const bmp = await createImageBitmap(f); const codes = await new BarcodeDetector({ formats: ['qr_code'] }).detect(bmp); codes.length ? resolve(codes[0].rawValue) : toast('No QR code found in that image', true); } catch (er) { errToast(er); } } });
  const paste = h('input', { placeholder: 'Paste the QR link or token', 'aria-label': 'QR link or token' });
  out.append(pageHead('QR invoice scanner', 'Scan a vendor invoice QR code. The code holds only a signed reference — the backend verifies the invoice, vendor and your eligibility.'), box,
    h('div', { class: 'row wrap' }, h('button', { class: 'btn primary', onclick: startCam }, 'Start camera'), h('label', { class: 'btn', for: 'qrfile' }, 'Scan from photo'), fileIn),
    h('div', { class: 'row' }, paste, h('button', { class: 'btn', onclick: () => resolve(paste.value) }, 'Resolve')), SANDBOX(), result);
  const pre = sessionStorage.getItem('pf_qr'); if (pre) { sessionStorage.removeItem('pf_qr'); resolve(pre); }
  window.addEventListener('hashchange', () => { stop = true; if (stream) stream.getTracks().forEach(t => t.stop()); }, { once: true });
  return out;
}

export function registerBills() {
  route('/e/bills', billsList); route('/e/bills/:id', billDetail); route('/e/approvals', approvalsPage); route('/e/expenses', expensesPage);
  route('/e/wallets', walletsPage); route('/e/transactions', transactionsPage); route('/e/receipt/:id', receiptPage); route('/e/scan', scanPage);
}
