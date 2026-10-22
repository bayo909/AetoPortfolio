import { h, state, get, post, route, navigate, fmt, bp, dt, day, cap, badge, tag, table, kv, stat, pageHead, toast, errToast, formModal, modal, can, field } from '../core.js';
import { documentDetail } from './vendor.js';

let cart = { vendorId: null, lines: [] };
try { const s = sessionStorage.getItem('pf_cart'); if (s) cart = JSON.parse(s); } catch { /* ignore */ }
const saveCart = () => { try { sessionStorage.setItem('pf_cart', JSON.stringify(cart)); } catch { /* ignore */ } };

async function marketplace() {
  const vs = await get('/marketplace/vendors');
  return h('div', { class: 'stack' }, pageHead('Vendor marketplace', 'Storefronts of vendors that invited into — or were invited by — your workspace. Unconnected vendors are never listed.', can('vendor.invite') && h('button', { class: 'btn primary', onclick: inviteVendor }, 'Invite a vendor')),
    vs.length ? h('div', { class: 'auto-grid' }, vs.map(v => h('div', { class: 'card stack' }, h('div', { class: 'row between' }, h('h3', null, v.name), badge(v.relationship === 'active' ? 'verified' : 'pending_kyb', v.relationship === 'active' ? 'Verified vendor' : 'Awaiting vendor KYB')), h('div', { class: 'small muted' }, v.headline || 'No headline'),
      h('div', { class: 'row' }, v.relationship === 'active' ? h('a', { class: 'btn primary sm', href: `#/e/marketplace/${v.orgId}` }, 'Browse catalogue') : h('span', { class: 'small muted' }, 'Not available until the vendor completes KYB'))))) : h('div', { class: 'card empty' }, 'No connected vendors yet. Invite one to get started.'));
}
function inviteVendor() {
  formModal('Invite a vendor', [{ name: 'vendorName', label: 'Vendor business name', required: true }, { name: 'email', label: 'Vendor contact email', type: 'email', required: true, help: 'The invitation only works for this address.' }],
    async d => { const r = await post('/org/invitations', { kind: 'vendor', ...d }); modal(close => h('div', { class: 'stack' }, h('h2', null, 'Invitation created'), h('p', null, `Send this single-use link to ${d.email}. It expires on ${day(r.expiresAt)} and is shown only once.`), h('input', { readOnly: true, value: `${location.origin}/${r.link}`, onclick: e => e.target.select() }), h('div', { class: 'notice info small' }, 'In production this is emailed. The vendor must register, complete KYB, and only then is a private channel opened.'), h('button', { class: 'btn primary', onclick: close }, 'Done'))); }, { submit: 'Create invitation' });
}

const lineEst = (p, qty) => { const net = Math.round(qty * p.unitPriceMinor), disc = Math.round(net * (p.effective.discountBp || 0) / 10000), tax = Math.round((net - disc) * p.taxBp / 10000); return { net, disc, tax, total: net - disc + tax }; };

async function storefront(ctx) {
  const vid = ctx.params[0];
  const sf = await get(`/marketplace/vendors/${vid}`);
  if (cart.vendorId !== vid) cart = { vendorId: vid, lines: [] };
  const state_ = { q: '', cat: '', kind: '', sort: 'name', compare: new Set() };
  const grid = h('div', { class: 'auto-grid' }), cartBox = h('div', { class: 'card stack' }), cmp = h('div', null);
  const cats = [...new Set(sf.products.map(p => p.category).filter(Boolean))];
  const draw = () => {
    grid.replaceChildren(...sf.products.filter(p => (!state_.q || `${p.name} ${p.sku} ${p.description}`.toLowerCase().includes(state_.q.toLowerCase())) && (!state_.cat || p.category === state_.cat) && (!state_.kind || p.kind === state_.kind))
      .sort((a, b) => state_.sort === 'price' ? a.unitPriceMinor - b.unitPriceMinor : a.name.localeCompare(b.name)).map(p => {
        const qty = h('input', { type: 'number', min: '1', value: 1, style: { maxWidth: '84px' }, 'aria-label': `Quantity for ${p.name}` });
        return h('div', { class: 'card stack' }, h('div', { class: 'row between' }, tag(cap(p.kind)), p.effective.discountBp ? tag(`${bp(p.effective.discountBp)} ${p.effective.source === 'customer_rule' ? 'agreed rate' : 'volume'}`, 'ai') : null), h('h3', null, p.name), h('div', { class: 'small muted' }, `${p.sku} · ${p.category}`), p.description && h('div', { class: 'small' }, p.description),
          h('div', { style: { fontSize: '20px', fontWeight: 800 } }, fmt(p.unitPriceMinor, p.currency), h('span', { class: 'small muted' }, ` / ${p.unit}`)), h('div', { class: 'small muted' }, `VAT ${bp(p.taxBp)}${p.whtBp ? ` · WHT ${bp(p.whtBp)}` : ''}${p.inventory != null ? ` · ${p.inventory} in stock` : ''}`),
          h('div', { class: 'row wrap' }, qty, h('button', { class: 'btn primary sm', onclick: () => { const q = Number(qty.value); if (!(q > 0)) return; const ex = cart.lines.find(l => l.productId === p.id); if (ex) ex.qty += q; else cart.lines.push({ productId: p.id, qty: q }); saveCart(); drawCart(); toast(`${p.name} added`); } }, 'Add to cart'),
            h('label', { class: 'small row' }, h('input', { type: 'checkbox', checked: state_.compare.has(p.id), onchange: e => { e.target.checked ? state_.compare.add(p.id) : state_.compare.delete(p.id); if (state_.compare.size > 3) { state_.compare.delete(p.id); e.target.checked = false; toast('Compare up to 3 items'); } drawCmp(); } }), 'Compare')));
      }));
  };
  const drawCmp = () => { const ps = sf.products.filter(p => state_.compare.has(p.id)); cmp.replaceChildren(ps.length > 1 ? h('div', { class: 'card stack' }, h('h3', null, 'Comparison'), table([{ label: '' , render: r => h('b', null, r.k) }, ...ps.map(p => ({ label: p.name, render: r => r.v(p) }))], [{ k: 'Unit price', v: p => fmt(p.unitPriceMinor, p.currency) }, { k: 'Your discount', v: p => (p.effective.discountBp ? bp(p.effective.discountBp) : '—') }, { k: 'VAT', v: p => bp(p.taxBp) }, { k: 'Type', v: p => cap(p.kind) }, { k: 'Stock', v: p => (p.inventory == null ? 'n/a' : p.inventory) }])) : null); };
  const title = h('input', { placeholder: 'e.g. Endpoint licences for Abuja branch', value: '' }), addr = h('input', { placeholder: 'Delivery address / site' }), needBy = h('input', { type: 'date' }), period = h('input', { placeholder: 'Service period (e.g. Jan–Mar 2027)' }), ref = h('input', { placeholder: 'Purchase reference / PR number' }), notes = h('textarea', { rows: 2, placeholder: 'Notes for the vendor' });
  const submit = async kind => {
    if (!cart.lines.length) return toast('Add at least one item', true); if (!title.value.trim()) return toast('Give the request a title', true);
    try { const r = await post('/requests', { vendorOrgId: vid, kind, title: title.value, purchaseRef: ref.value, notes: notes.value, delivery: { address: addr.value, date: needBy.value }, items: cart.lines.map(l => ({ productId: l.productId, qty: l.qty, servicePeriod: period.value })) }); cart.lines = []; saveCart(); toast(`${r.number} sent to ${sf.vendor.name}`); navigate(`#/e/requests/${r.id}`); } catch (e) { errToast(e); } };
  const drawCart = () => {
    let net = 0, tax = 0, disc = 0;
    const rows = cart.lines.map(l => { const p = sf.products.find(x => x.id === l.productId); const e = lineEst(p, l.qty); net += e.net; disc += e.disc; tax += e.tax; return h('div', { class: 'row between' }, h('div', null, h('div', { style: { fontWeight: 700 } }, p.name), h('div', { class: 'small muted' }, `${l.qty} × ${fmt(p.unitPriceMinor, p.currency)}`)), h('div', { class: 'row' }, h('b', null, fmt(e.total, p.currency)), h('button', { class: 'btn sm ghost', 'aria-label': 'Remove', onclick: () => { cart.lines = cart.lines.filter(x => x !== l); saveCart(); drawCart(); } }, '✕'))); });
    cartBox.replaceChildren(h('h2', null, `Cart · ${sf.vendor.name}`), cart.lines.length ? rows : h('div', { class: 'muted' }, 'Your cart is empty.'),
      cart.lines.length ? h('dl', { class: 'kv' }, h('dt', null, 'Subtotal'), h('dd', null, fmt(net)), h('dt', null, 'Discounts'), h('dd', null, `-${fmt(disc)}`), h('dt', null, 'VAT'), h('dd', null, fmt(tax)), h('dt', { style: { fontWeight: 800 } }, 'Estimated total'), h('dd', { style: { fontWeight: 800 } }, fmt(net - disc + tax))) : null,
      h('div', { class: 'notice info small' }, 'Estimate only. The binding price is the vendor-approved quotation or invoice; the server recalculates everything.'),
      h('label', { class: 'f' }, 'Request title', title), h('label', { class: 'f' }, 'Delivery requirements', addr), h('div', { class: 'grid c2' }, h('label', { class: 'f' }, 'Needed by', needBy), h('label', { class: 'f' }, 'Service period', period)), h('label', { class: 'f' }, 'Purchase reference', ref), h('label', { class: 'f' }, 'Notes', notes),
      h('div', { class: 'row wrap' }, h('button', { class: 'btn primary', onclick: () => submit('rfq') }, 'Request quotation'), h('button', { class: 'btn', title: 'Ask the vendor to confirm an order at your agreed prices — still needs vendor approval', onclick: () => submit('order') }, 'Place order at agreed prices')));
  };
  const ask = h('input', { placeholder: 'Ask the vendor\'s AI Billing Agent about prices or items…' }), answer = h('div', null);
  const askNow = async () => { try { const a = await post(`/marketplace/vendors/${vid}/ask`, { question: ask.value }); answer.replaceChildren(h('div', { class: 'notice info', style: { whiteSpace: 'pre-wrap' } }, tag('AI Billing Agent', 'ai'), ' ', a.text)); } catch (e) { errToast(e); } };
  draw(); drawCart();
  return h('div', { class: 'stack' }, h('a', { href: '#/e/marketplace' }, '← Marketplace'), pageHead(sf.vendor.name, sf.vendor.headline || 'Vendor storefront', [badge('verified', 'KYB verified'), h('span', { class: 'chip' }, `Payment terms: ${sf.vendor.paymentTermsDays} days`)]),
    sf.vendor.about && h('p', null, sf.vendor.about), h('div', { class: 'card tint stack' }, h('div', { class: 'row wrap' }, ask, h('button', { class: 'btn', onclick: askNow }, 'Ask')), answer),
    h('div', { class: 'row wrap' }, h('input', { placeholder: 'Search catalogue', 'aria-label': 'Search', style: { maxWidth: '260px' }, oninput: e => { state_.q = e.target.value; draw(); } }), h('select', { 'aria-label': 'Category', style: { maxWidth: '200px' }, onchange: e => { state_.cat = e.target.value; draw(); } }, h('option', { value: '' }, 'All categories'), cats.map(c => h('option', null, c))),
      h('select', { 'aria-label': 'Type', style: { maxWidth: '160px' }, onchange: e => { state_.kind = e.target.value; draw(); } }, h('option', { value: '' }, 'Products & services'), h('option', { value: 'product' }, 'Products'), h('option', { value: 'service' }, 'Services')), h('select', { 'aria-label': 'Sort', style: { maxWidth: '160px' }, onchange: e => { state_.sort = e.target.value; draw(); } }, h('option', { value: 'name' }, 'Sort by name'), h('option', { value: 'price' }, 'Sort by price'))),
    cmp, h('div', { class: 'grid', style: { gridTemplateColumns: 'minmax(0,1.7fr) minmax(300px,1fr)', alignItems: 'start' } }, grid, cartBox));
}

const STAGES = [['Request', r => true], ['Quote approved', r => r.quotes.some(q => ['approved', 'accepted'].includes(q.status))], ['Quote accepted + PO', r => r.quotes.some(q => q.status === 'accepted')], ['Invoice issued', r => r.invoices.some(i => ['issued', 'paid', 'disputed'].includes(i.status))], ['Paid', r => r.invoices.some(i => i.status === 'paid')]];
async function requestsList() {
  const rs = (await get('/requests')).filter(r => r.side === 'customer');
  const vendors = await get('/marketplace/vendors').catch(() => []);
  return h('div', { class: 'stack' }, pageHead('Requests & RFQs', 'Vendors can only produce quotations and invoices in answer to a request you raise.', [can('request.create') && h('button', { class: 'btn primary', onclick: () => formModal('Request an invoice', [{ name: 'vendorOrgId', label: 'Vendor', type: 'select', options: vendors.filter(v => v.relationship === 'active').map(v => ({ value: v.orgId, label: v.name })) }, { name: 'title', label: 'What is the invoice for?', required: true }, { name: 'description', label: 'Item description', required: true }, { name: 'qty', label: 'Quantity', type: 'number', value: 1, min: '0.001', step: '0.001' }, { name: 'purchaseRef', label: 'PO / reference' }],
      async d => { const r = await post('/requests', { vendorOrgId: d.vendorOrgId, kind: 'invoice_request', title: d.title, purchaseRef: d.purchaseRef, items: [{ description: d.description, qty: d.qty }] }); toast(`${r.number} sent`); navigate(`#/e/requests/${r.id}`); }, { submit: 'Send request' }) }, 'Request an invoice'), h('a', { class: 'btn', href: '#/e/marketplace' }, 'New RFQ from catalogue')]),
    table([{ label: 'Number', render: r => h('b', null, r.number) }, { label: 'Type', render: r => cap(r.kind) }, { label: 'Vendor', key: 'vendor' }, { label: 'Title', key: 'title' }, { label: 'Requested by', key: 'requestedBy' }, { label: 'Status', render: r => badge(r.status) }, { label: 'Created', render: r => dt(r.createdAt) }], rs, { onRow: r => navigate(`#/e/requests/${r.id}`), empty: 'No requests yet.' }));
}
async function requestDetail(ctx) {
  const r = await get(`/requests/${ctx.params[0]}`);
  return h('div', { class: 'stack loose' }, h('a', { href: '#/e/requests' }, '← All requests'), pageHead(`${r.number} · ${r.title}`, `${r.vendor} · requested by ${r.requestedBy}`, [badge(r.status), tag(cap(r.kind))]),
    h('div', { class: 'steps' }, STAGES.map(([l, f], i) => { const done = f(r), prevDone = i === 0 || STAGES[i - 1][1](r); return h('div', { class: `step ${done ? 'done' : prevDone ? 'cur' : ''}` }, h('b', null, l), done ? 'Done' : prevDone ? 'Waiting' : ''); })),
    h('div', { class: 'card stack' }, h('h2', null, 'Requested items'), table([{ label: 'Item', key: 'description' }, { label: 'Quantity', render: i => i.qtyMilli / 1000 }, { label: 'Service period', render: i => i.servicePeriod || '—' }], r.items), kv([['Delivery', r.delivery.address], ['Needed by', r.delivery.date], ['Notes', r.delivery.notes], ['Reference', r.purchaseRef]])),
    h('div', { class: 'card stack' }, h('h2', null, 'Vendor documents'), table([{ label: 'Quotation', render: q => h('a', { href: `#/e/documents/q/${q.id}` }, `${q.number} v${q.version}`) }, { label: 'Status', render: q => badge(q.status) }, { label: 'Valid until', render: q => day(q.validUntil) }, { label: 'Total', right: true, render: q => fmt(q.totalMinor, q.currency) }], r.quotes, { empty: 'No vendor-approved quotation yet — the vendor is preparing one.' }),
      table([{ label: 'Invoice', render: i => h('a', { href: `#/e/documents/i/${i.id}` }, `${i.number} v${i.version}`) }, { label: 'Status', render: i => badge(i.displayStatus) }, { label: 'Due', render: i => day(i.dueDate) }, { label: 'Total', right: true, render: i => fmt(i.totalMinor, i.currency) }, { label: '', render: i => i.billId && h('a', { class: 'btn sm', href: `#/e/bills/${i.billId}` }, 'Open bill') }], r.invoices, { empty: 'No invoice issued yet.' })),
    h('div', { class: 'row wrap' }, r.channelId && h('a', { class: 'btn primary', href: `#/chat/${r.channelId}` }, 'Discuss in transaction channel'), ['open', 'quoted'].includes(r.status) && h('button', { class: 'btn danger', onclick: async () => { await post(`/requests/${r.id}/cancel`); navigate(location.hash); } }, 'Cancel request')));
}

export function registerMarket() {
  route('/e/marketplace', marketplace); route('/e/marketplace/:id', storefront); route('/e/requests', requestsList); route('/e/requests/:id', requestDetail);
  route('/e/documents/q/:id', ctx => documentDetail('q', ctx.params[0], '#/e/requests')); route('/e/documents/i/:id', ctx => documentDetail('i', ctx.params[0], '#/e/requests'));
}
