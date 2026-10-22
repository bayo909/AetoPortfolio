import { h, state, get, post, route, fmt, stat, pageHead, badge, tag, table, dt, can, cap, navigate } from '../core.js';

const walletCard = w => h('div', { class: `wallet ${w.kind}` }, h('span', { class: 'sim' }, 'SIMULATED'), h('div', { class: 'small' }, `${w.kind.toUpperCase()} wallet`), h('div', { style: { fontWeight: 700 } }, w.name),
  h('div', { class: 'bal' }, fmt(w.availableMinor, w.currency)), h('div', { class: 'small' }, `Balance ${fmt(w.balanceMinor, w.currency)} · held ${fmt(w.reservedMinor, w.currency)}`));
const budgetBar = b => { const used = b.committedMinor + b.spentMinor, pct = b.allocatedMinor ? Math.min(100, Math.round(used / b.allocatedMinor * 100)) : 0;
  return h('div', null, h('div', { class: 'row between small' }, h('span', null, `${b.costCenter} · ${b.classification.toUpperCase()}`), h('span', null, `${fmt(used)} / ${fmt(b.allocatedMinor)}`)), h('div', { class: `progress ${pct > 90 ? 'bad' : pct > 70 ? 'warn' : ''}` }, h('i', { style: { width: `${pct}%` } }))); };

async function notificationsCard() {
  const notes = (await get('/notifications')).slice(0, 6);
  return h('div', { class: 'card' }, h('div', { class: 'row between' }, h('h2', null, 'Notifications'), notes.some(n => !n.read_at) && h('button', { class: 'btn sm', onclick: async () => { await post('/notifications/read'); navigate(location.hash); } }, 'Mark read')),
    notes.length ? h('div', { class: 'stack tight' }, notes.map(n => h('a', { href: n.link || '#', style: { color: 'inherit', textDecoration: 'none', opacity: n.read_at ? .6 : 1 } }, h('div', { style: { fontWeight: 700 } }, n.title), h('div', { class: 'small muted' }, `${n.body ? n.body + ' · ' : ''}${dt(n.created_at)}`)))) : h('div', { class: 'muted' }, 'You are all caught up.'));
}
const guide = () => h('div', { class: 'card tint stack' }, h('h2', null, 'Guided demo paths'), h('p', { class: 'small muted', style: { margin: 0 } }, 'Seeded data already contains completed and in-flight examples of both paths, plus the exception cases.'),
  h('div', { class: 'grid c2' },
    h('div', null, h('h3', null, 'Path 1 · Vendor RFQ → payment'), h('ol', { class: 'small' }, h('li', null, h('a', { href: '#/e/marketplace' }, 'Marketplace'), ' → request a quote from SecureTech'), h('li', null, 'Sign in as Kemi/Seyi → ', h('a', { href: '#/v/requests' }, 'AI draft & approve')), h('li', null, 'Accept the quote → invoice → bill'), h('li', null, h('a', { href: '#/e/bills' }, 'Approve the bill'), ' → ', h('a', { href: '#/e/scan' }, 'scan the QR'), ' → pay'), h('li', null, h('a', { href: '#/e/accounting' }, 'Journal'), ' and ', h('a', { href: '#/f/audit' }, 'audit trail')))),
    h('div', null, h('h3', null, 'Path 2 · Document → bill'), h('ol', { class: 'small' }, h('li', null, h('a', { href: '#/e/inbox' }, 'Upload'), ' the sample memo or Okafor invoice'), h('li', null, h('a', { href: '#/e/review' }, 'Review side by side'), ', correct figures, submit'), h('li', null, 'Approve with the required roles, run finance review'), h('li', null, 'Pay the bill from a wallet, then check ledger and trace')))));

async function vendorView() {
  const o = await get('/overview'); const v = o.vendor;
  return [pageHead('Vendor overview', `${o.org} — requests, approvals and settlements at a glance`),
    v.kybStatus !== 'verified' && h('div', { class: 'notice warn', style: { marginBottom: '14px' } }, `KYB status: ${cap(v.kybStatus)}. Customers cannot transact with you until verification completes. `, h('a', { href: '#/v/kyb' }, 'Open KYB & Compliance')),
    h('div', { class: 'grid c4' }, stat('Open requests', v.openRequests, v.openRequests ? 'warn' : '', '#/v/requests'), stat('Quotes awaiting approval', v.quotesPending, v.quotesPending ? 'warn' : '', '#/v/documents'), stat('Invoices awaiting approval', v.invoicesPending, v.invoicesPending ? 'warn' : '', '#/v/documents'), stat('Active customers', v.customers, '', '#/v/customers'),
      stat('Outstanding receivables', fmt(v.outstandingMinor), '', '#/v/payments'), stat('Settled to date', fmt(v.paidMinor), 'ok', '#/v/payments'), stat('Overdue invoices', v.overdue, v.overdue ? 'bad' : '', '#/v/payments')),
    h('div', { class: 'grid c2', style: { marginTop: '16px' } }, await notificationsCard(), state.me.org.isDemo ? guide() : null)];
}
async function customerView() {
  const o = await get('/overview'); const f = o.finance;
  return [pageHead('Finance overview', `${o.org} — bills, approvals, wallets and budgets`),
    h('div', { class: 'grid c4' }, stat('Bills to validate', f.toValidate, f.toValidate ? 'warn' : '', '#/e/bills?s=received'), stat('Pending approval', f.pendingApproval, f.pendingApproval ? 'warn' : '', '#/e/bills?s=pending_approval'), stat('My approvals', f.myApprovals, f.myApprovals ? 'warn' : '', '#/e/approvals'),
      stat('Ready to pay', `${f.readyToPay.n} · ${fmt(f.readyToPay.s)}`, '', '#/e/bills?s=approved'), stat('Paid bills', f.paid.n, 'ok', '#/e/transactions'), stat('Quarantined', f.quarantined, f.quarantined ? 'bad' : '', '#/e/bills?s=quarantined'),
      stat('Disputed', f.disputed, f.disputed ? 'bad' : '', '#/e/bills?s=disputed'), stat('Ledger posting failures', f.postingFailed, f.postingFailed ? 'bad' : '', '#/e/bills'), stat('OPEX in flight', fmt(f.opexMinor)), stat('CAPEX in flight', fmt(f.capexMinor)), stat('Open requests', f.openRequests, '', '#/e/requests'), stat('Documents processed', f.docsInProgress, '', '#/e/review')),
    o.wallets && o.wallets.length ? h('div', { style: { marginTop: '18px' } }, h('div', { class: 'row between' }, h('h2', null, 'Wallets'), tag('Sandbox · simulated balances', 'sandbox')), h('div', { class: 'auto-grid', style: { marginTop: '8px' } }, o.wallets.slice(0, 4).map(walletCard))) : null,
    h('div', { class: 'grid c2', style: { marginTop: '18px' } }, o.budgets ? h('div', { class: 'card stack' }, h('h2', null, 'Budgets'), o.budgets.filter(b => b.allocatedMinor).slice(0, 7).map(budgetBar)) : null, await notificationsCard()),
    state.me.org.isDemo ? h('div', { style: { marginTop: '16px' } }, guide()) : null];
}
async function platformView() {
  const o = await get('/overview');
  return [pageHead('Platform overview', 'Operational view only — tenant financial data is not accessible from here'), h('div', { class: 'grid c4' }, stat('Customer & vendor tenants', o.tenants, '', '#/a/tenants'), stat('Vendor organisations', o.vendors), stat('KYB cases to review', o.kybPending, o.kybPending ? 'warn' : '', '#/a/kyb'))];
}

export function registerOverview() {
  route('/overview', async () => {
    const me = state.me, box = h('div', null);
    if (me.org.kind === 'platform') box.append(...await platformView());
    else if (me.org.isVendor && !me.org.isCustomer) box.append(...await vendorView());
    else if (me.org.isVendor && can('request.respond')) box.append(...await vendorView());
    else box.append(...await customerView());
    return box;
  });
  route('/settings', async () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    return h('div', { class: 'stack' }, pageHead('Settings'), h('div', { class: 'card stack' }, h('h2', null, 'Profile'), h('dl', { class: 'kv' }, h('dt', null, 'Name'), h('dd', null, state.me.user.name), h('dt', null, 'Email'), h('dd', null, state.me.user.email), h('dt', null, 'Organisation'), h('dd', null, state.me.org.name),
      h('dt', null, 'Role'), h('dd', null, state.me.roleLabel), h('dt', null, 'Approval authority'), h('dd', null, fmt(state.me.approvalLimitMinor, state.me.org.currency)), h('dt', null, 'Department / cost centre'), h('dd', null, `${state.me.department || '—'} / ${state.me.costCenter || '—'}`))),
      h('div', { class: 'card stack' }, h('h2', null, 'Appearance'), h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: dark, onchange: e => { const t = e.target.checked ? 'dark' : 'light'; document.documentElement.dataset.theme = t; try { localStorage.setItem('pf_theme', t); } catch { /* ignore */ } } }), 'Dark mode')),
      h('div', { class: 'card stack' }, h('h2', null, 'Your permissions'), h('p', { class: 'small muted' }, 'These are enforced on the server for every request, not just hidden in the menu.'), h('div', { class: 'chips' }, state.me.permissions.map(p => h('span', { class: 'chip mono' }, p)))));
  });
}
