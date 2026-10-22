import { h, $, clear, state, get, post, api, route, renderRoute, navigate, icon, brand, badge, tag, toast, can, parseHash } from './core.js';
import { registerPublic } from './pages/public.js';
import { registerOverview } from './pages/overview.js';
import { registerChat } from './pages/chat.js';
import { registerVendor } from './pages/vendor.js';
import { registerMarket } from './pages/market.js';
import { registerBills } from './pages/bills.js';
import { registerDocs } from './pages/docs.js';
import { registerFinance } from './pages/finance.js';
import { registerAdmin } from './pages/admin.js';

const theme = (() => { try { return localStorage.getItem('pf_theme'); } catch { return null; } })();
if (theme) document.documentElement.dataset.theme = theme;

export function navFor(me) {
  const org = me.org, P = new Set(me.permissions), sections = [];
  const item = (label, href, ic, perm, extra) => ({ label, href, ic, perm, ...extra });
  const keep = list => list.filter(i => !i.perm || [].concat(i.perm).some(p => P.has(p)));
  if (org.kind === 'platform') {
    sections.push(['Platform', keep([item('Overview', '#/overview', 'home'), item('Tenants', '#/a/tenants', 'users', 'platform.manage'), item('KYB Review', '#/a/kyb', 'shield', 'platform.kyb_review'),
      item('Subscription Administration', '#/a/plans', 'card', 'platform.manage'), item('Country KYB Configuration', '#/a/countries', 'globe', 'platform.manage'), item('System Health & Roles', '#/a/health', 'chart', 'platform.manage')])]);
    return sections;
  }
  if (org.isVendor && P.has('request.respond')) {
    sections.push(['Vendor workspace', keep([item('Overview', '#/overview', 'home'), item('Storefront', '#/v/storefront', 'store', 'storefront.manage'), item('Products & Services', '#/v/products', 'box', ['catalog.manage', 'request.respond']),
      item('RFQs & Requests', '#/v/requests', 'inbox', 'request.respond'), item('Customer Workspaces', '#/v/customers', 'users', 'request.respond'), item('Collaboration Channels', '#/chat', 'chat', 'chat.use', { unread: true }),
      item('AI Billing Agent', '#/v/agent', 'bot', 'agent.use'), item('Quotes & Invoices', '#/v/documents', 'doc', 'request.respond'), item('Payments & Settlements', '#/v/payments', 'wallet', 'request.respond'),
      item('Subscription', '#/v/subscription', 'card', 'subscription.manage'), item('KYB & Compliance', '#/v/kyb', 'shield', 'kyb.manage'), item('Reports', '#/v/reports', 'chart', 'reports.view'), item('Settings', '#/settings', 'gear')])]);
  }
  if (org.isCustomer) {
    sections.push(['Employee portal', keep([item('Finance Overview', '#/overview', 'home'), item('Vendor Marketplace', '#/e/marketplace', 'store', 'marketplace.browse'), item('Collaboration', '#/chat', 'chat', 'chat.use', { unread: true }),
      item('Requests & RFQs', '#/e/requests', 'inbox', 'request.create'), item('Document Inbox', '#/e/inbox', 'clip', 'docs.upload'), item('Billing Review', '#/e/review', 'doc', ['docs.review', 'docs.approve', 'docs.finance_review', 'ledger.view']),
      item('OPEX Bills', '#/e/bills?c=opex', 'receipt', 'bill.view'), item('CAPEX Bills', '#/e/bills?c=capex', 'receipt', 'bill.view'), item('Employee Expenses', '#/e/expenses', 'list', 'expense.submit'),
      item('Approvals', '#/e/approvals', 'check', 'bill.approve', { approvals: true }), item('Wallets & Payments', '#/e/wallets', 'wallet', 'wallet.view'), item('QR Scanner', '#/e/scan', 'scan', 'qr.scan'),
      item('Transactions', '#/e/transactions', 'card', 'wallet.view'), item('Accounting & Reports', '#/e/accounting', 'book', 'ledger.view'), item('Settings', '#/settings', 'gear', null)])]);
    const fin = keep([item('RT-FEPE Processing Monitor', '#/f/monitor', 'bot', ['docs.review', 'ledger.view']), item('Financial Events Mapping', '#/f/events', 'list', 'events.manage'), item('Chart of Accounts', '#/f/coa', 'book', 'ledger.view'),
      item('Budgets & Cost Centers', '#/f/budgets', 'chart', ['budget.manage', 'ledger.view']), item('Payment Reconciliation', '#/f/reconcile', 'check', 'reconcile.run'), item('Audit Trail', '#/f/audit', 'shield', 'audit.view'),
      item('Enterprise Finance Policies', '#/f/policy', 'doc', 'policy.manage'), item('Integrations', '#/f/integrations', 'link', 'integrations.manage'), item('People & Invitations', '#/f/people', 'users', ['org.members', 'vendor.invite'])]);
    if (fin.length) sections.push(['Finance & administration', fin]);
  }
  return sections;
}

async function loadMe() {
  try { state.me = await get('/auth/me'); } catch { state.me = null; }
  return state.me;
}
let es = null;
function startStream() {
  if (es || !window.EventSource) return;
  es = new EventSource('/api/stream');
  es.addEventListener('message', e => { document.dispatchEvent(new CustomEvent('pf-message', { detail: JSON.parse(e.data) })); refreshBadges(); });
  es.addEventListener('notify', e => { toast(JSON.parse(e.data).title); refreshBadges(); });
}
export async function refreshBadges() {
  if (!state.me) return;
  try {
    const [chs, ap] = await Promise.all([can('chat.use') ? get('/channels') : [], can('bill.approve') ? get('/approvals') : []]);
    state.unread = chs.reduce((s, c) => s + c.unread, 0); state.pendingApprovals = ap.filter(a => !a.blockedReason).length;
    document.querySelectorAll('[data-badge=unread]').forEach(e => { e.textContent = state.unread; e.style.display = state.unread ? '' : 'none'; });
    document.querySelectorAll('[data-badge=approvals]').forEach(e => { e.textContent = state.pendingApprovals; e.style.display = state.pendingApprovals ? '' : 'none'; });
  } catch { /* badges are best effort */ }
}

const PUBLIC = [/^\/$/, /^\/login/, /^\/register/, /^\/invite\//];
function shell() {
  const me = state.me;
  const here = location.hash;
  const side = h('aside', { class: 'side', id: 'side', 'aria-label': 'Main navigation' },
    h('div', { class: 'brand' }, brand(true)),
    navFor(me).map(([title, items]) => [h('div', { class: 'grp' }, title), items.map(i => {
      const on = here === i.href || (i.href !== '#/overview' && here.startsWith(i.href.split('?')[0]) && (!i.href.includes('?') || here.includes(i.href.split('?')[1])));
      return h('a', { class: `nav ${on ? 'on' : ''}`, href: i.href, onclick: () => $('#side').classList.remove('open') }, icon(i.ic), i.label,
        i.unread && h('span', { class: 'count', 'data-badge': 'unread', style: { display: 'none' } }, '0'), i.approvals && h('span', { class: 'count', 'data-badge': 'approvals', style: { display: 'none' } }, '0'));
    })]));
  const orgSel = me.memberships.length > 1 ? h('select', { 'aria-label': 'Switch organisation', style: { maxWidth: '230px' }, onchange: async e => { await post('/auth/switch-org', { orgId: e.target.value }); location.hash = '#/overview'; location.reload(); } },
    me.memberships.map(m => h('option', { value: m.orgId, selected: m.orgId === me.org.id }, `${m.orgName} — ${m.role.replace(/_/g, ' ')}`))) : null;
  return h('div', { class: 'app' }, side, h('div', { class: 'main' },
    h('div', { class: 'topbar' },
      h('button', { class: 'btn ghost menu-btn', 'aria-label': 'Menu', onclick: () => $('#side').classList.toggle('open') }, icon('menu')),
      h('div', { class: 'grow' }), orgSel,
      h('div', { class: 'who' }, h('div', { style: { fontWeight: 700 } }, me.user.name), h('div', { class: 'small muted' }, `${me.org.name} · ${me.roleLabel}`)),
      h('button', { class: 'btn sm', onclick: async () => { await post('/auth/logout'); state.me = null; location.hash = '#/login'; location.reload(); } }, 'Sign out')),
    me.org.isDemo && h('div', { class: 'banner' }, tag('Demo', 'demo'), tag('Sandbox', 'sandbox'), 'Fictional companies and simulated balances. Payments run through a sandbox provider — no real money moves. Demo data is kept separate from production tenants.'),
    h('div', { id: 'view' }, h('div', { class: 'empty' }, 'Loading…'))));
}

async function boot() {
  const root = $('#root');
  try { state.config = await get('/public/config'); } catch { state.config = { countries: [], plans: [] }; }
  await loadMe();
  const markNav = () => {
    const here = location.hash;
    document.querySelectorAll('#side a.nav').forEach(a => {
      const target = a.getAttribute('href'), [base, q] = target.split('?');
      const on = here === target || (target !== '#/overview' && here.startsWith(base) && (!q || here.includes(q)));
      a.classList.toggle('on', on);
    });
  };
  const draw = async () => {
    const { path } = parseHash();
    const isPublic = PUBLIC.some(r => r.test(path));
    if (state.me && !isPublic) {
      if (!$('#side')) { clear(root); root.append(shell()); startStream(); refreshBadges(); }
      markNav();
    } else {
      if ($('#side') || !$('#view')) { clear(root); root.append(h('div', { id: 'view' })); }
      if (!state.me && !isPublic) { sessionStorage.setItem('pf_next', location.hash); location.hash = '#/login'; return; }
    }
    await renderRoute();
  };
  window.addEventListener('hashchange', draw);
  [registerPublic, registerOverview, registerChat, registerVendor, registerMarket, registerBills, registerDocs, registerFinance, registerAdmin].forEach(f => f({ reloadShell: async () => { await loadMe(); clear(root); await draw(); } }));
  await draw();
}
boot();
export { loadMe };
