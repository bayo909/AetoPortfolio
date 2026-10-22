import { h, state, get, post, route, navigate, brand, logo, icon, errToast, toast, field, fmt, cap, tag, badge, bp } from '../core.js';

const COUNTRY_NAMES = { NG: 'Nigeria', US: 'United States', GH: 'Ghana', GB: 'United Kingdom', AU: 'Australia' };
const ROLE_PLAIN = { org_admin: 'Org Admin', employee: 'Employee', procurement_officer: 'Procurement', finance_officer: 'Finance Officer', finance_approver: 'CFO / Approver', accountant: 'Accountant', vendor_owner: 'Vendor Owner', vendor_sales: 'Vendor Sales', platform_admin: 'Platform Admin' };

const pubNav = () => h('nav', { class: 'pub-nav' }, h('a', { href: '#/', style: { color: 'inherit', fontWeight: 800, fontSize: '18px', textDecoration: 'none' } }, brand()), h('div', { class: 'grow' }),
  state.me ? h('a', { class: 'btn primary', href: '#/overview' }, 'Open app') : [h('a', { class: 'btn ghost', href: '#/login' }, 'Sign in'), h('a', { class: 'btn primary', href: '#/register' }, 'Get started')]);

function landing() {
  const feat = (ic, t, d) => h('div', { class: 'feature' }, icon(ic), h('h3', null, t), h('p', { class: 'muted', style: { margin: '6px 0 0' } }, d));
  const plans = (state.config.plans || []).filter(p => p.active);
  return h('div', { class: 'pub' }, pubNav(),
    h('section', { class: 'hero' }, h('div', { class: 'row', style: { marginBottom: '14px' } }, tag('Sandbox build', 'sandbox'), h('span', { style: { color: '#cfe6da', fontWeight: 600 } }, 'AI-powered B2B billing, collaboration & wallet payments')),
      h('h1', null, 'Every Business Document. One Connected Payment Flow.'),
      h('p', null, 'Vendors and corporate finance teams negotiate in secure channels, an AI billing agent prepares drafts for human approval, RT-FEPE turns any document into a controlled bill, and approved bills are paid from company wallets — with a double-entry ledger and a tamper-evident audit trail behind every step.'),
      h('div', { class: 'row wrap', style: { marginTop: '24px' } }, h('a', { class: 'btn light', href: '#/register' }, 'Create your workspace'), h('a', { class: 'btn', style: { background: 'transparent', color: '#fff', borderColor: 'rgba(255,255,255,.4)' }, href: '#/login' }, 'Try the demo accounts')),
      h('div', { class: 'flowline' }, ['Invite vendor', 'RFQ in a channel', 'AI drafts quote', 'Vendor approves', 'Quote accepted', 'Invoice → bill', 'OPEX/CAPEX approval', 'Scan QR & pay', 'Reconcile', 'Journal & audit'].map((s, i) => h('span', null, `${i + 1}. ${s}`)))),
    h('section', { class: 'section' }, h('h2', { style: { fontSize: '28px', marginBottom: '6px' } }, 'Six connected modules'), h('p', { class: 'muted' }, 'One multi-tenant platform. Each business has its own isolated members, vendors, wallets, documents and books.'),
      h('div', { class: 'auto-grid', style: { marginTop: '20px' } }, feat('store', 'Vendor workspace & storefront', 'KYB onboarding, catalogue, customer-specific pricing, quote and invoice approval, subscription plans.'),
        feat('users', 'Employee finance platform', 'OPEX and CAPEX bills, budgets, expense claims, delegated approval limits and segregation of duties.'),
        feat('chat', 'B2B collaboration', 'Invitation-only vendor channels, transaction threads, mentions, attachments and embedded quote, invoice and payment cards.'),
        feat('bot', 'RT-FEPE document engine', 'OCR and extraction for structured documents; summarise and match financial events for unstructured ones; side-by-side billing review.'),
        feat('wallet', 'Wallets & QR payments', 'Signed invoice QR codes, idempotent payments, reservations, limits and dual control — sandbox provider in this build.'),
        feat('book', 'Accounting & audit', 'Atomic double-entry posting, period locks, reversals, reconciliation and a hash-linked audit trail.'))),
    h('section', { class: 'section alt' }, h('h2', { style: { fontSize: '28px', marginBottom: '14px' } }, 'Controls you can see'),
      h('div', { class: 'grid c3' }, ...[
        ['AI drafts, humans decide', 'The billing agent only interprets and drafts. Prices, tax and totals are computed by the server; a different authorised vendor user must approve.'],
        ['Three separate approvals', 'Vendor approval of the document, customer approval of the spend, and wallet authorisation of the payment are distinct controls.'],
        ['Requests, not surprises', 'Vendors cannot push unsolicited payable invoices. Documents without a matching request are quarantined.'],
        ['Tenant isolation', 'Every record is scoped to an organisation on the server and in the database. Vendors only see what was shared with them.'],
        ['OCR is not approval', 'Extraction and matching create drafts with confidence scores. Nothing is paid until an approved, payable bill exists.'],
        ['Honest about the sandbox', 'Balances are simulated and the country KYB rules are placeholders awaiting compliance validation — and the UI says so.']].map(([t, d]) => h('div', { class: 'card flat' }, h('h3', null, t), h('p', { class: 'muted', style: { marginBottom: 0 } }, d))))),
    plans.length ? h('section', { class: 'section' }, h('h2', { style: { fontSize: '28px', marginBottom: '14px' } }, 'Vendor plans'), h('div', { class: 'auto-grid' }, plans.map(p => h('div', { class: 'card' }, h('h3', null, p.name), h('div', { class: 'stat' }, h('div', { class: 'n' }, p.monthlyMinor ? fmt(p.monthlyMinor, p.currency) : 'Free'), h('div', { class: 'l' }, p.monthlyMinor ? 'per month' : '30-day trial')),
      h('ul', { class: 'small', style: { paddingLeft: '18px' } }, h('li', null, p.entitlements.quotes === -1 ? 'Unlimited quotes' : `${p.entitlements.quotes} quotes / month`), h('li', null, p.entitlements.invoices === -1 ? 'Unlimited invoices' : `${p.entitlements.invoices} invoices / month`), h('li', null, p.entitlements.qr_payments ? 'QR invoice payments' : 'No QR payments'), h('li', null, 'AI Billing Agent')))))) : null,
    h('footer', { class: 'section alt small muted' }, 'PayUno Flow MVP — sandbox payment adapter, simulated balances, demo companies. Production use requires licensed payment providers and compliance-validated KYB rules.'));
}

function demoPicker(onPick) {
  const users = state.config.demoUsers || [];
  if (!users.length) return null;
  const byOrg = {}; users.forEach(u => (byOrg[u.org] = byOrg[u.org] || []).push(u));
  return h('div', { class: 'card tint' }, h('h3', null, 'Demo accounts'), h('p', { class: 'small muted' }, `All use the password `, h('code', null, state.config.demoPassword), '. Choose one to fill the form.'),
    Object.entries(byOrg).map(([org, list]) => h('div', { style: { marginTop: '10px' } }, h('div', { class: 'small', style: { fontWeight: 800 } }, org), h('div', { class: 'chips', style: { marginTop: '4px' } },
      list.map(u => h('button', { class: 'chip', type: 'button', style: { cursor: 'pointer' }, onclick: () => onPick(u.email), title: u.email }, `${u.name.split(' ')[0]} · ${ROLE_PLAIN[u.role] || u.role}`))))));
}

function loginPage({ reloadShell }) {
  const email = h('input', { type: 'email', name: 'email', required: true, autocomplete: 'username', id: 'email' });
  const pw = h('input', { type: 'password', name: 'password', required: true, autocomplete: 'current-password', id: 'password' });
  const form = h('form', { class: 'stack', onsubmit: async e => {
    e.preventDefault();
    try { await post('/auth/login', { email: email.value, password: pw.value }); await reloadShell(); const next = sessionStorage.getItem('pf_next'); sessionStorage.removeItem('pf_next'); navigate(next && !next.startsWith('#/login') ? next : '#/overview'); } catch (err) { errToast(err); }
  } }, h('h1', null, 'Sign in'), h('label', { class: 'f' }, 'Email', email), h('label', { class: 'f' }, 'Password', pw), h('button', { class: 'btn primary', type: 'submit' }, 'Sign in'),
  h('p', { class: 'small muted' }, 'New here? ', h('a', { href: '#/register' }, 'Create a workspace'), '. Vendors join a customer through an invitation link.'));
  return h('div', { class: 'pub' }, pubNav(), h('div', { class: 'auth-wrap wide' }, h('div', { class: 'grid c2' }, h('div', { class: 'card' }, form), demoPicker(em => { email.value = em; pw.value = state.config.demoPassword; pw.focus(); }))));
}

function registerPage({ reloadShell }) {
  const form = h('form', { class: 'stack', onsubmit: async e => {
    e.preventDefault(); const f = form.elements;
    try { await post('/auth/register', { name: f.name.value, email: f.email.value, password: f.password.value, orgName: f.orgName.value, country: f.country.value, type: f.type.value }); await reloadShell(); navigate(f.type.value === 'vendor' ? '#/v/kyb' : '#/overview'); toast('Workspace created'); } catch (err) { errToast(err); }
  } }, h('h1', null, 'Create your workspace'),
  h('div', { class: 'notice info small' }, 'Customers (businesses that buy) and vendors (businesses that sell) both start here. A vendor can only join a customer\'s workspace via that customer\'s invitation.'),
  h('fieldset', { style: { border: 0, padding: 0, margin: 0 } }, h('legend', { class: 'small', style: { fontWeight: 700, marginBottom: '6px' } }, 'I am a…'),
    h('label', { class: 'row' }, h('input', { type: 'radio', name: 'type', value: 'business', checked: true }), 'Business that pays vendors (customer)'), h('label', { class: 'row' }, h('input', { type: 'radio', name: 'type', value: 'vendor' }), 'Vendor that sells to businesses')),
  field({ name: 'orgName', label: 'Organisation name', required: true }), field({ name: 'country', label: 'Country', type: 'select', options: (state.config.countries || []).map(c => ({ value: c, label: COUNTRY_NAMES[c] || c })) }),
  field({ name: 'name', label: 'Your name', required: true, autocomplete: 'name' }), field({ name: 'email', label: 'Work email', type: 'email', required: true, autocomplete: 'email' }),
  field({ name: 'password', label: 'Password', type: 'password', required: true, minlength: 10, help: 'At least 10 characters', autocomplete: 'new-password' }),
  h('button', { class: 'btn primary', type: 'submit' }, 'Create workspace'), h('p', { class: 'small muted' }, 'Already registered? ', h('a', { href: '#/login' }, 'Sign in')));
  return h('div', { class: 'pub' }, pubNav(), h('div', { class: 'auth-wrap' }, h('div', { class: 'card' }, form)));
}

async function invitePage(ctx, { reloadShell }) {
  const token = ctx.params[0];
  let info; try { info = await get(`/invitations/preview/${encodeURIComponent(token)}`); } catch (e) { return h('div', { class: 'pub' }, pubNav(), h('div', { class: 'auth-wrap' }, h('div', { class: 'card' }, h('h1', null, 'Invitation unavailable'), h('p', null, e.message), h('a', { class: 'btn', href: '#/' }, 'Home')))); }
  const signedIn = !!state.me;
  const mismatch = signedIn && state.me.user.email.toLowerCase() !== info.email.toLowerCase();
  const accept = async body => { try { const r = await post('/invitations/accept', { token, ...body }); await reloadShell(); toast(r.relationship === 'pending_kyb' ? 'Joined — waiting for KYB verification before the channel opens' : 'Invitation accepted'); navigate(info.kind === 'vendor' ? '#/v/kyb' : '#/overview'); } catch (err) { errToast(err); } };
  const form = h('form', { class: 'stack', onsubmit: e => { e.preventDefault(); const f = form.elements; accept({ name: f.name.value, password: f.password.value, orgName: f.orgName?.value, country: f.country?.value }); } },
    field({ name: 'name', label: 'Your name', required: true }), info.kind === 'vendor' && field({ name: 'orgName', label: 'Your business name', value: info.invitedOrgName, required: true }),
    info.kind === 'vendor' && field({ name: 'country', label: 'Country', type: 'select', options: (state.config.countries || []).map(c => ({ value: c, label: COUNTRY_NAMES[c] || c })) }),
    field({ name: 'password', label: 'Choose a password', type: 'password', required: true, minlength: 10 }), h('button', { class: 'btn primary', type: 'submit' }, 'Create account & accept'));
  return h('div', { class: 'pub' }, pubNav(), h('div', { class: 'auth-wrap' }, h('div', { class: 'card stack' }, h('h1', null, `Join ${info.inviter}`),
    h('p', null, info.kind === 'vendor' ? `${info.inviter} invited ${info.invitedOrgName || 'your business'} to collaborate as a vendor. You will only see the channels and records they share with you.` : `You were invited to join ${info.inviter} as ${cap(info.role)}.`),
    h('dl', { class: 'kv' }, h('dt', null, 'Invitation for'), h('dd', null, info.email), h('dt', null, 'Expires'), h('dd', null, new Date(info.expiresAt).toLocaleString())),
    signedIn ? (mismatch ? h('div', { class: 'notice bad' }, `You are signed in as ${state.me.user.email}. This invitation was sent to ${info.email}; sign out and use that address.`)
      : h('button', { class: 'btn primary', onclick: () => accept({}) }, 'Accept invitation')) : form,
    !signedIn && h('p', { class: 'small muted' }, 'Already have an account with this email? ', h('a', { href: '#/login', onclick: () => sessionStorage.setItem('pf_next', location.hash) }, 'Sign in first'), ', then reopen this link.'))));
}

export function registerPublic(app) {
  route('/', () => landing());
  route('/login', () => loginPage(app));
  route('/register', () => registerPage(app));
  route('/invite/:token', ctx => invitePage(ctx, app));
  route('/pay', ctx => { sessionStorage.setItem('pf_qr', ctx.query.t || ''); if (state.me) { navigate('#/e/scan'); } else { sessionStorage.setItem('pf_next', '#/e/scan'); navigate('#/login'); } });
}
