import { h, state, get, post, patch, put, api, route, navigate, clear, fmt, major, dt, day, cap, bp, badge, tag, table, kv, stat, pageHead, toast, errToast, formModal, modal, confirmBox, field, can, loading, showIssues } from '../core.js';

/* ------------------------------ shared commercial document view ------------------------------ */
export function linesTable(lines, ccy) {
  return h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ['Item', 'Qty', 'Unit price', 'Discount', 'VAT', 'WHT', 'Line total'].map((c, i) => h('th', { class: i ? 'right' : '' }, c)))),
    h('tbody', null, lines.map(l => h('tr', null, h('td', null, h('div', null, l.description), h('div', { class: 'small muted' }, `${l.sku || 'no SKU'} · ${l.priceSource === 'customer_rule' ? 'agreed customer price' : l.priceSource === 'manual' ? 'manual price' : l.priceSource === 'price_required' ? 'PRICE REQUIRED' : 'catalogue price'}`)),
      h('td', { class: 'right' }, l.qty), h('td', { class: 'right' }, fmt(l.unitPriceMinor, ccy)), h('td', { class: 'right' }, l.discountBp ? `-${fmt(l.discountMinor, ccy)} (${bp(l.discountBp)})` : '—'), h('td', { class: 'right' }, l.taxBp ? `${fmt(l.taxMinor, ccy)} (${bp(l.taxBp)})` : '—'),
      h('td', { class: 'right' }, l.whtMinor ? fmt(l.whtMinor, ccy) : '—'), h('td', { class: 'right' }, fmt(l.totalMinor, ccy)))))));
}
export const totalsBox = (d) => h('dl', { class: 'kv', style: { maxWidth: '360px', marginLeft: 'auto' } }, h('dt', null, 'Subtotal'), h('dd', { class: 'right' }, fmt(d.subtotalMinor, d.currency)), d.discountMinor ? [h('dt', null, 'Discount'), h('dd', { class: 'right' }, `-${fmt(d.discountMinor, d.currency)}`)] : null,
  h('dt', null, 'VAT'), h('dd', { class: 'right' }, fmt(d.taxMinor, d.currency)), h('dt', { style: { fontWeight: 800 } }, 'Total'), h('dd', { class: 'right', style: { fontWeight: 800 } }, fmt(d.totalMinor, d.currency)),
  d.whtMinor ? [h('dt', null, 'Less WHT (customer remits)'), h('dd', { class: 'right' }, fmt(d.whtMinor, d.currency)), h('dt', null, 'Net payable'), h('dd', { class: 'right' }, fmt(d.totalMinor - d.whtMinor, d.currency))] : null);

export function flagsView(flags) {
  if (!flags || !flags.length) return null;
  return h('div', { class: 'stack tight' }, flags.map(f => h('div', { class: `notice ${f.level === 'error' ? 'bad' : f.level === 'warning' ? 'warn' : 'info'} small` }, f.level === 'info' && f.code === 'explain' ? `Calculation: ${f.msg}` : f.msg)));
}
export function decisionsView(decisions) {
  if (!decisions || !decisions.length) return null;
  return h('div', null, h('h3', null, 'Approval record'), h('div', { class: 'timeline' }, decisions.map(d => h('div', null, h('b', null, `${cap(d.decision)} · v${d.version}`), h('div', { class: 'small' }, `${d.actor} · ${dt(d.at)}`), d.comment && h('div', { class: 'small muted' }, d.comment)))));
}

/** Quote / invoice detail with the actions this user may take. */
export async function documentDetail(type, id, back) {
  const d = await get(`/${type === 'q' ? 'quotes' : 'invoices'}/${id}`);
  const isQ = type === 'q', vendor = d.side === 'vendor';
  const reload = () => navigate(location.hash === '#x' ? '#/v/documents' : location.hash) || renderAgain();
  const renderAgain = async () => { const host = box.parentNode; if (host) { const nb = await documentDetail(type, id, back); box.replaceWith(nb); } };
  const act = (label, path, { cls = 'btn', body, confirm, prompt } = {}) => h('button', { class: cls, onclick: async () => {
    try {
      let b = body || {};
      if (prompt) { const r = window.prompt(prompt); if (r === null) return; b = { ...b, reason: r, comment: r }; }
      if (confirm && !(await confirmBox(confirm))) return;
      const out = await post(`/${isQ ? 'quotes' : 'invoices'}/${id}/${path}`, b);
      toast(`${label} — done`); if (path === 'revise' && out.id) return navigate(`#/v/documents/${type}/${out.id}`); renderAgain();
    } catch (e) { errToast(e); }
  } }, label);
  const acts = [];
  if (vendor) {
    if (isQ) {
      if (d.status === 'draft' && can('quote.draft')) acts.push(act('Submit for approval', 'submit', { cls: 'btn primary' }));
      if (d.status === 'pending_approval' && can('quote.approve')) acts.push(act('Approve & deliver to customer', 'approve', { cls: 'btn ok', prompt: 'Approval comment (optional)' }), act('Reject', 'reject', { cls: 'btn danger', prompt: 'Reason for rejection' }));
      if (['pending_approval', 'approved', 'rejected'].includes(d.status) && can('quote.draft')) acts.push(act('Revise (new version)', 'revise'));
      if (d.status === 'accepted' && can('invoice.draft')) acts.push(h('button', { class: 'btn primary', onclick: async () => { try { const inv = await post('/invoices', { quoteId: id }); navigate(`#/v/documents/i/${inv.id}`); } catch (e) { errToast(e); } } }, 'Create invoice from accepted quote'));
    } else {
      if (d.status === 'draft' && can('invoice.draft')) acts.push(act('Submit for approval', 'submit', { cls: 'btn primary' }));
      if (d.status === 'submitted' && can('invoice.approve')) acts.push(act('Approve invoice', 'approve', { cls: 'btn ok' }), act('Return for changes', 'reject', { cls: 'btn danger', prompt: 'What needs to change?' }));
      if (d.status === 'approved' && can('invoice.issue')) acts.push(act('Issue to customer (creates their payable bill)', 'issue', { cls: 'btn primary', confirm: 'Issue this invoice? It will be delivered to the customer and converted into a bill in their finance queue.' }));
      if (['draft', 'submitted', 'approved', 'disputed', 'issued'].includes(d.status) && can('invoice.draft')) acts.push(act('Revise (new version)', 'revise'));
      if (['draft', 'submitted', 'approved', 'issued', 'disputed'].includes(d.status) && can('invoice.approve')) acts.push(act('Cancel', 'cancel', { cls: 'btn danger', prompt: 'Reason for cancelling' }));
    }
  } else if (isQ && d.status === 'approved' && can('quote.accept')) acts.push(act('Accept quote & issue purchase order', 'accept', { cls: 'btn ok', confirm: 'Accepting issues a purchase order for this amount. Continue?' }), act('Decline', 'decline', { cls: 'btn danger', prompt: 'Reason (optional)' }));
  const box = h('div', { class: 'stack loose' },
    h('a', { href: back || '#/v/documents' }, '← Back'),
    pageHead(`${isQ ? 'Quotation' : 'Invoice'} ${d.number}`, `${d.vendor} → ${d.customer} · version ${d.version}`, [badge(d.displayStatus || d.status), d.isDraftAI && tag('AI-prepared draft', 'ai'), d.isDemo && tag('Demo', 'demo')]),
    d.isDraftAI && vendor && h('div', { class: 'notice info' }, 'This document was prepared by the AI Billing Agent. All prices come from your catalogue and pricing rules and all totals were calculated by the server. It remains a DRAFT until a different authorised vendor user approves it.'),
    d.status === 'disputed' && h('div', { class: 'notice bad' }, `Disputed by the customer: ${d.disputeReason}`),
    h('div', { class: 'card stack' }, kv([['Status', badge(d.displayStatus || d.status)], [isQ ? 'Valid until' : 'Due date', day(isQ ? d.validUntil : d.dueDate)], vendor && ['Prepared by', d.preparedBy], vendor && ['Approved by', d.approvedBy ? `${d.approvedBy} · ${dt(d.approvedAt)}` : null],
      ['Created', dt(d.createdAt)], d.terms && ['Terms', d.terms], d.notes && ['Notes', d.notes], d.versions && d.versions.length > 1 && ['Versions', h('span', { class: 'row wrap' }, d.versions.map(v => h('a', { class: 'chip', href: `#/${vendor ? 'v' : 'e'}/documents/${type}/${v.id}` }, `v${v.version} ${v.status}`)))]]),
      linesTable(d.lines, d.currency), totalsBox(d), vendor && flagsView(d.flags), vendor && decisionsView(d.decisions)),
    !isQ && !vendor && d.billId && h('a', { class: 'btn primary', href: `#/e/bills/${d.billId}` }, 'Open payable bill'),
    !isQ && vendor && d.billId && ['issued', 'paid'].includes(d.status) && h('div', { class: 'card stack' }, h('h2', null, 'Payment QR'), h('p', { class: 'small muted' }, 'Customers can scan this signed reference to open the invoice for payment. It carries no bank details.'), await qrBlock(id)),
    acts.length ? h('div', { class: 'row wrap' }, acts) : null);
  return box;
}
async function qrBlock(invoiceId) {
  try { const q = await get(`/invoices/${invoiceId}/qr`); const holder = h('div', { class: 'qr-img' }); holder.innerHTML = q.svg; return h('div', { class: 'row wrap' }, holder, h('div', { class: 'stack tight' }, h('div', { class: 'small mono', style: { wordBreak: 'break-all', maxWidth: '420px' } }, q.url), h('button', { class: 'btn sm', onclick: () => { navigator.clipboard && navigator.clipboard.writeText(q.url); toast('Link copied'); } }, 'Copy link'))); }
  catch (e) { return h('div', { class: 'notice warn' }, e.message); }
}
export { qrBlock };

/* ------------------------------ line editor (manual quotes) ------------------------------ */
function lineEditor(products, initial = []) {
  const rows = h('div', { class: 'stack tight' });
  const add = (l = {}) => {
    const sel = h('select', { 'aria-label': 'Product' }, h('option', { value: '' }, 'Custom item (price required)'), products.map(p => h('option', { value: p.id, selected: l.productId === p.id }, `${p.sku} — ${p.name}`)));
    const desc = h('input', { placeholder: 'Description (custom items)', value: l.description || '' }), qty = h('input', { type: 'number', min: '0.001', step: '0.001', value: l.qty || 1, 'aria-label': 'Quantity', style: { maxWidth: '90px' } });
    const price = h('input', { type: 'number', min: '0', step: '0.01', placeholder: 'Manual price (flagged)', 'aria-label': 'Manual unit price', value: l.unitPrice || '' });
    const row = h('div', { class: 'row wrap', 'data-row': 1 }, sel, desc, qty, price, h('button', { class: 'btn sm danger', type: 'button', onclick: () => row.remove() }, '✕'));
    row.read = () => ({ productId: sel.value || null, description: desc.value, qty: qty.value, unitPrice: price.value || undefined });
    rows.append(row);
  };
  (initial.length ? initial : [{}]).forEach(add);
  return { el: h('div', { class: 'stack tight' }, rows, h('button', { class: 'btn sm', type: 'button', onclick: () => add() }, '+ Add line')), read: () => [...rows.children].map(r => r.read()) };
}

/* ------------------------------ pages ------------------------------ */
async function storefrontPage() {
  const p = await get('/vendor/profile');
  const f = (name, label, value, extra = {}) => field({ name, label, value, ...extra });
  const form = h('form', { class: 'stack', onsubmit: async e => {
    e.preventDefault(); const x = form.elements;
    try { await patch('/vendor/profile', { legalName: x.legalName.value, description: x.description.value, registrationNo: x.registrationNo.value, taxId: x.taxId.value || undefined, settlementCurrency: x.settlementCurrency.value, bankName: x.bankName.value, accountName: x.accountName.value, accountNumber: x.accountNumber.value || undefined,
      paymentTermsDays: x.paymentTermsDays.value, allowSelfApproval: x.allowSelfApproval.checked, storefront: { headline: x.headline.value, about: x.about.value, published: x.published.checked } }); toast('Profile saved'); navigate(location.hash); } catch (err) { errToast(err); } } },
  h('div', { class: 'grid c2' }, f('legalName', 'Legal name', p.legalName, { required: true }), f('registrationNo', 'Registration number', p.registrationNo), f('taxId', `Tax ID (stored encrypted) — current: ${p.taxIdMasked || 'none'}`, '', { placeholder: 'Leave blank to keep' }), f('paymentTermsDays', 'Payment terms (days)', p.paymentTermsDays, { type: 'number' }),
    f('settlementCurrency', 'Settlement currency', p.settlementCurrency, { type: 'select', options: ['NGN', 'USD', 'GBP', 'GHS', 'AUD'] }), f('bankName', 'Settlement bank', p.bankName), f('accountName', 'Account name', p.accountName), f('accountNumber', `Account number (stored encrypted) — current: ${p.accountNumberMasked || 'none'}`, '', { placeholder: 'Leave blank to keep' })),
  p.bankChangedAt && h('div', { class: 'notice warn small' }, `Payment details last changed ${dt(p.bankChangedAt)}. Customers see a warning on new bills for 30 days after a change.`),
  h('h3', null, 'Storefront'), f('headline', 'Headline', p.storefront.headline), f('about', 'About', p.storefront.about, { type: 'textarea' }), h('label', { class: 'row' }, h('input', { type: 'checkbox', name: 'published', checked: p.storefront.published }), 'Publish storefront to connected customers'),
  h('label', { class: 'row' }, h('input', { type: 'checkbox', name: 'allowSelfApproval', checked: p.allowSelfApproval }), 'Allow a user to approve a quote or invoice they prepared themselves (policy exception — audited; off by default)'),
  h('button', { class: 'btn primary', type: 'submit' }, 'Save'));
  return h('div', { class: 'stack' }, pageHead('Storefront & profile', 'Business profile, payment settings and what connected customers can browse.', [badge(p.kybStatus, `KYB: ${cap(p.kybStatus)}`)]), h('div', { class: 'card' }, form));
}

async function productsPage() {
  const [prods, rules, custs] = await Promise.all([get('/vendor/products'), get('/vendor/pricing-rules'), get('/vendor/customers')]);
  const edit = p => formModal(p ? `Edit ${p.sku}` : 'New product or service', [
    { name: 'kind', label: 'Type', type: 'select', options: ['service', 'product'], value: p ? p.kind : 'service' }, { name: 'sku', label: 'SKU', required: true, value: p && p.sku }, { name: 'name', label: 'Name', required: true, value: p && p.name }, { name: 'category', label: 'Category', value: p && p.category },
    { name: 'description', label: 'Description', type: 'textarea', value: p && p.description }, { name: 'unit', label: 'Unit', value: p ? p.unit : 'unit' }, { name: 'unitPrice', label: 'Unit price', required: true, value: p ? (p.unitPriceMinor / 100).toFixed(2) : '', type: 'number', step: '0.01', min: '0' },
    { name: 'taxBp', label: 'VAT (basis points, 750 = 7.5%)', type: 'number', value: p ? p.taxBp : 750 }, { name: 'whtBp', label: 'Withholding tax (basis points)', type: 'number', value: p ? p.whtBp : 0 }, { name: 'inventory', label: 'Inventory (blank for services)', type: 'number', value: p && p.inventory != null ? p.inventory : '' },
    { name: 'available', label: 'Available for ordering', type: 'checkbox', value: p ? p.available : true }], async d => { await (p ? patch(`/vendor/products/${p.id}`, d) : post('/vendor/products', d)); toast('Saved'); navigate(location.hash); });
  const rule = () => formModal('Pricing rule', [{ name: 'productId', label: 'Product', type: 'select', options: prods.map(p => ({ value: p.id, label: `${p.sku} — ${p.name}` })) },
    { name: 'customerOrgId', label: 'Customer (blank = all customers)', type: 'select', options: [{ value: '', label: 'All customers' }, ...custs.filter(c => c.status === 'active').map(c => ({ value: c.org_id, label: c.name }))] }, { name: 'minQtyMilli', label: 'Minimum quantity', type: 'number', value: 1, min: '1' }, { name: 'discountBp', label: 'Discount (percent)', type: 'number', step: '0.01', value: 5 }, { name: 'validUntil', label: 'Valid until', type: 'date' }, { name: 'note', label: 'Note' }],
  async d => { await post('/vendor/pricing-rules', { ...d, customerOrgId: d.customerOrgId || null, minQtyMilli: Math.round(Number(d.minQtyMilli) * 1000), discountBp: Math.round(Number(d.discountBp) * 100), validUntil: d.validUntil || null }); toast('Rule added'); navigate(location.hash); });
  return h('div', { class: 'stack loose' }, pageHead('Products & services', 'The catalogue is the only source of prices the AI Billing Agent may use.', can('catalog.manage') && h('button', { class: 'btn primary', onclick: () => edit(null) }, '+ Add item')),
    table([{ label: 'SKU', key: 'sku', render: p => h('span', { class: 'mono' }, p.sku) }, { label: 'Name', render: p => h('div', null, h('b', null, p.name), h('div', { class: 'small muted' }, `${cap(p.kind)} · ${p.category}`)) }, { label: 'Unit price', right: true, render: p => fmt(p.unitPriceMinor, p.currency) },
      { label: 'VAT / WHT', render: p => `${bp(p.taxBp)} / ${bp(p.whtBp)}` }, { label: 'Stock', render: p => (p.inventory == null ? '—' : p.inventory) }, { label: 'Status', render: p => badge(p.available ? 'active' : 'draft', p.available ? 'Available' : 'Hidden') },
      can('catalog.manage') && { label: '', render: p => h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => edit(p) }, 'Edit'), h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmBox(`Remove ${p.sku}?`)) { await api('DELETE', `/vendor/products/${p.id}`); navigate(location.hash); } } }, 'Remove')) }].filter(Boolean), prods, { empty: 'No products yet.' }),
    h('div', { class: 'row between' }, h('h2', null, 'Customer-specific pricing & discounts'), can('catalog.manage') && prods.length ? h('button', { class: 'btn', onclick: rule }, '+ Add rule') : null),
    table([{ label: 'Product', render: r => `${r.sku} — ${r.productName}` }, { label: 'Customer', render: r => r.customerName || 'All customers' }, { label: 'Min qty', render: r => r.minQtyMilli / 1000 }, { label: 'Discount', render: r => bp(r.discountBp) }, { label: 'Valid until', render: r => day(r.validUntil) }, { label: 'Note', key: 'note' }], rules, { empty: 'No pricing rules.' }));
}

async function requestsPage(ctx) {
  const reqs = await get('/requests');
  const mine = reqs.filter(r => r.side === 'vendor');
  return h('div', { class: 'stack' }, pageHead('RFQs & requests', 'Customer RFQs, orders and invoice requests addressed to you. Quotes and invoices exist only in answer to one of these.'),
    table([{ label: 'Number', render: r => h('b', null, r.number) }, { label: 'Type', render: r => cap(r.kind) }, { label: 'Customer', key: 'customer' }, { label: 'Title', key: 'title' }, { label: 'Requested by', key: 'requestedBy' }, { label: 'Status', render: r => badge(r.status) }, { label: 'Received', render: r => dt(r.createdAt) }],
      mine, { onRow: r => navigate(`#/v/requests/${r.id}`), empty: 'No requests yet.' }));
}
async function requestDetail(ctx) {
  const id = ctx.params[0];
  const [r, prods] = await Promise.all([get(`/requests/${id}`), get('/vendor/products')]);
  const out = h('div', { class: 'stack loose' });
  const result = h('div', { class: 'stack' });
  const instr = h('textarea', { placeholder: 'Optional instruction for the agent, e.g. "add 60 endpoint licences and a penetration test"', rows: 2 });
  const draft = async type => { try { const o = await post('/agent/draft', { requestId: r.id, instruction: instr.value || undefined, type }); toast(`Draft ${o.type} prepared — submit it for approval`); navigate(`#/v/documents/${o.type === 'quote' ? 'q' : 'i'}/${o.document.id}`); } catch (e) { errToast(e); } };
  const manual = () => modal(close => { const ed = lineEditor(prods, r.items.map(i => ({ productId: i.productId, description: i.description, qty: i.qtyMilli / 1000 })));
    return h('div', { class: 'stack' }, h('h2', null, 'Manual quotation'), h('p', { class: 'small muted' }, 'Prices come from the catalogue. A manual price is allowed but is flagged for the approver.'), ed.el,
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => { try { const q = await post('/quotes', { requestId: r.id, lines: ed.read() }); close(); navigate(`#/v/documents/q/${q.id}`); } catch (e) { errToast(e); } } }, 'Create draft'), h('button', { class: 'btn', onclick: close }, 'Cancel'))); }, { wide: true });
  out.append(h('a', { href: '#/v/requests' }, '← All requests'), pageHead(`${r.number} · ${r.title}`, `From ${r.customer} — ${r.requestedBy}`, [badge(r.status), tag(cap(r.kind))]),
    h('div', { class: 'card stack' }, h('h2', null, 'Requested items'), table([{ label: 'Item', key: 'description' }, { label: 'SKU', render: i => i.sku || '—' }, { label: 'Quantity', render: i => i.qtyMilli / 1000 }], r.items), r.delivery && (r.delivery.address || r.delivery.date || r.delivery.notes) ? kv([['Delivery address', r.delivery.address], ['Needed by', r.delivery.date], ['Notes', r.delivery.notes], ['Purchase reference', r.purchaseRef]]) : null),
    ['open', 'quoted'].includes(r.status) && can('quote.draft') ? h('div', { class: 'card tint stack' }, h('h2', null, 'Respond'), h('div', { class: 'row' }, tag('AI Billing Agent', 'ai'), h('span', { class: 'small muted' }, 'drafts only — a different authorised user must approve')), instr,
      h('div', { class: 'row wrap' }, can('agent.use') && h('button', { class: 'btn primary', onclick: () => draft(r.kind === 'invoice_request' ? 'invoice' : 'quote') }, r.kind === 'invoice_request' ? 'Draft invoice with AI' : 'Draft quotation with AI'), r.kind !== 'invoice_request' && h('button', { class: 'btn', onclick: manual }, 'Create manually'),
        r.kind === 'invoice_request' && h('button', { class: 'btn', onclick: async () => { try { const i = await post('/invoices', { requestId: r.id }); navigate(`#/v/documents/i/${i.id}`); } catch (e) { errToast(e); } } }, 'Create invoice manually'))) : null,
    h('div', { class: 'card stack' }, h('h2', null, 'Documents for this request'), table([{ label: 'Quotes', render: q => h('a', { href: `#/v/documents/q/${q.id}` }, `${q.number} v${q.version}`) }, { label: 'Status', render: q => badge(q.status) }, { label: 'Total', right: true, render: q => fmt(q.totalMinor, q.currency) }], r.quotes, { empty: 'No quotes yet.' }),
      table([{ label: 'Invoices', render: i => h('a', { href: `#/v/documents/i/${i.id}` }, `${i.number} v${i.version}`) }, { label: 'Status', render: i => badge(i.displayStatus) }, { label: 'Total', right: true, render: i => fmt(i.totalMinor, i.currency) }], r.invoices, { empty: 'No invoices yet.' })),
    r.channelId && h('a', { class: 'btn', href: `#/chat/${r.channelId}` }, 'Open transaction channel'));
  return out;
}

async function customersPage() {
  const [cs, inv] = await Promise.all([get('/vendor/customers'), can('org.members') ? get('/org/invitations').catch(() => []) : []]);
  return h('div', { class: 'stack loose' }, pageHead('Customer workspaces', 'Customers who invited you. You see only the channels and records they share with you.'),
    table([{ label: 'Customer', render: c => h('b', null, c.name) }, { label: 'Country', key: 'country' }, { label: 'Relationship', render: c => badge(c.status, c.status === 'pending_kyb' ? 'Waiting for KYB' : cap(c.status)) }, { label: 'Since', render: c => day(c.created_at) }], cs, { empty: 'No customers yet — a customer must invite you.' }),
    cs.some(c => c.status === 'pending_kyb') ? h('div', { class: 'notice warn' }, 'Some relationships are waiting for your KYB verification. ', h('a', { href: '#/v/kyb' }, 'Complete KYB')) : null,
    can('org.members') ? h('div', { class: 'card stack' }, h('div', { class: 'row between' }, h('h2', null, 'Your team'), h('button', { class: 'btn', onclick: () => formModal('Invite vendor staff', [{ name: 'email', label: 'Email', type: 'email', required: true }, { name: 'role', label: 'Role', type: 'select', options: [{ value: 'vendor_sales', label: 'Sales / Billing agent' }, { value: 'vendor_owner', label: 'Owner / Administrator (can approve)' }] }],
      async d => { const r = await post('/org/invitations', { kind: 'staff', ...d }); modal(close => h('div', { class: 'stack' }, h('h2', null, 'Invitation created'), h('p', null, 'Send this single-use link to the invitee. It expires in 7 days and only works for ', d.email, '.'), h('input', { readOnly: true, value: `${location.origin}/${r.link}`, onclick: e => e.target.select() }), h('button', { class: 'btn primary', onclick: close }, 'Done'))); }) }, 'Invite staff')),
      table([{ label: 'Name', key: 'name' }, { label: 'Email', key: 'email' }, { label: 'Role', render: m => cap(m.role) }, { label: 'Status', render: m => badge(m.status) }], await get('/org/members'))) : null);
}

async function agentPage() {
  const reqs = (await get('/requests')).filter(r => r.side === 'vendor' && ['open', 'quoted'].includes(r.status));
  return h('div', { class: 'stack loose' }, pageHead('AI Billing Agent', 'Prepares draft quotations and invoices from customer requests and your catalogue.'),
    h('div', { class: 'grid c2' }, h('div', { class: 'card stack' }, h('h2', null, 'What it can and cannot do'), h('ul', null, h('li', null, 'Reads customer requests and your published catalogue'), h('li', null, 'Applies your pricing rules; asks when quantity or product is unclear'), h('li', null, 'Explains every calculation line by line'), h('li', null, 'Creates a ', h('b', null, 'draft'), ' and routes it to an approver')),
      h('div', { class: 'notice warn' }, 'It never invents prices, taxes or bank details, never approves or issues documents, and never moves money. Server-side code computes all totals.')),
      h('div', { class: 'card stack' }, h('h2', null, 'Requests waiting for a draft'), reqs.length ? reqs.map(r => h('div', { class: 'row between' }, h('div', null, h('b', null, r.number), h('div', { class: 'small muted' }, `${r.customer} · ${r.title}`)), h('a', { class: 'btn primary sm', href: `#/v/requests/${r.id}` }, 'Prepare draft'))) : h('div', { class: 'muted' }, 'No open requests.'))));
}

async function documentsPage(ctx) {
  const [qs, is] = await Promise.all([get('/quotes'), get('/invoices')]);
  const tab = ctx.query.t || 'q';
  const queue = qs.filter(q => q.status === 'pending_approval').length + is.filter(i => i.status === 'submitted').length;
  const tabs = h('div', { class: 'tabs' }, [['q', `Quotations (${qs.length})`], ['i', `Invoices (${is.length})`]].map(([k, l]) => h('a', { class: tab === k ? 'on' : '', href: `#/v/documents?t=${k}` }, l)));
  return h('div', { class: 'stack' }, pageHead('Quotes & invoices', 'Every document is a draft until a vendor approver approves it; approved invoices are issued to the customer, creating their payable bill.'), queue ? h('div', { class: 'notice warn' }, `${queue} document(s) are waiting for approval.`) : null, tabs,
    tab === 'q' ? table([{ label: 'Number', render: q => h('b', null, `${q.number} v${q.version}`) }, { label: 'Customer', key: 'customer' }, { label: 'Status', render: q => h('span', { class: 'row' }, badge(q.status), q.isDraftAI && tag('AI draft', 'ai')) }, { label: 'Total', right: true, render: q => fmt(q.totalMinor, q.currency) }, { label: 'Valid until', render: q => day(q.validUntil) }, { label: 'Prepared by', key: 'preparedBy' }],
      qs, { onRow: q => navigate(`#/v/documents/q/${q.id}`), empty: 'No quotations.' })
      : table([{ label: 'Number', render: i => h('b', null, `${i.number} v${i.version}`) }, { label: 'Customer', key: 'customer' }, { label: 'Status', render: i => h('span', { class: 'row' }, badge(i.displayStatus), i.isDraftAI && tag('AI draft', 'ai')) }, { label: 'Total', right: true, render: i => fmt(i.totalMinor, i.currency) }, { label: 'Due', render: i => day(i.dueDate) }, { label: 'Prepared by', key: 'preparedBy' }],
        is, { onRow: i => navigate(`#/v/documents/i/${i.id}`), empty: 'No invoices.' }));
}

async function paymentsPage() {
  const [r, o] = await Promise.all([get('/reports'), get('/overview')]);
  return h('div', { class: 'stack loose' }, pageHead('Payments & settlements', 'Receivables and settled invoices. Payment status changes only after a verified provider result (sandbox in this build).'),
    h('div', { class: 'grid c3' }, stat('Outstanding', fmt(o.vendor.outstandingMinor)), stat('Settled', fmt(o.vendor.paidMinor), 'ok'), stat('Overdue invoices', o.vendor.overdue, o.vendor.overdue ? 'bad' : '')),
    h('h2', null, 'Receivables'), table([{ label: 'Invoice', key: 'number' }, { label: 'Customer', key: 'customer' }, { label: 'Status', render: i => badge(i.due_date < new Date().toISOString().slice(0, 10) && i.status === 'issued' ? 'overdue' : i.status) }, { label: 'Due', render: i => day(i.due_date) }, { label: 'Amount', right: true, render: i => fmt(i.total_minor) }], r.receivables || [], { empty: 'Nothing outstanding.' }),
    h('h2', null, 'Settlement report'), table([{ label: 'Invoice', key: 'number' }, { label: 'Customer', key: 'customer' }, { label: 'Paid', render: i => dt(i.paid_at) }, { label: 'Gross', right: true, render: i => fmt(i.total_minor) }, { label: 'WHT withheld', right: true, render: i => fmt(i.wht_minor) }, { label: 'Net settled', right: true, render: i => fmt(i.total_minor - i.wht_minor) }], r.settlements || [], { empty: 'No settled invoices yet.' }));
}

async function subscriptionPage() {
  const [s, plans] = await Promise.all([get('/subscription'), get('/plans')]);
  const usage = (label, used, lim) => h('div', null, h('div', { class: 'row between small' }, h('span', null, label), h('span', null, lim === -1 ? `${used} / unlimited` : `${used} / ${lim}`)), h('div', { class: `progress ${lim !== -1 && used / lim > .9 ? 'bad' : ''}` }, h('i', { style: { width: lim === -1 ? '8%' : `${Math.min(100, used / lim * 100)}%` } })));
  const change = (p, period) => async () => { try { const r = await post('/subscription/change', { planKey: p.key, billingPeriod: period }); toast(r.chargeOk === false ? `Payment failed: ${r.chargeError}` : 'Plan updated'); navigate(location.hash); } catch (e) { errToast(e); } };
  return h('div', { class: 'stack loose' }, pageHead('Subscription', 'Vendor plans and entitlements. Subscription billing is separate from customer payments and wallet balances.', badge(s.status)),
    ['past_due', 'trial_expired', 'cancelled'].includes(s.status) && h('div', { class: 'notice bad' }, s.status === 'past_due' ? 'Your last subscription payment failed, so issuing invoices and QR payments are paused. Fix the payment method and retry.' : 'Your plan is not active — choose a plan to continue issuing documents.'),
    s.cancelAtPeriodEnd && h('div', { class: 'notice warn' }, `Cancellation scheduled for ${day(s.currentPeriodEnd)}.`), s.pendingPlanKey && h('div', { class: 'notice info' }, `Downgrade to ${cap(s.pendingPlanKey)} takes effect at the end of the current period.`),
    h('div', { class: 'grid c2' }, h('div', { class: 'card stack' }, h('h2', null, `Current plan: ${s.planName}`), kv([['Billing', cap(s.billingPeriod)], s.trialEndsAt && ['Trial ends', day(s.trialEndsAt)], s.currentPeriodEnd && ['Renews', day(s.currentPeriodEnd)], ['QR invoice payments', s.entitlements.qr_payments ? 'Included' : 'Not on this plan']]),
      usage('Quotes this month', s.usage.quotes, s.entitlements.quotes), usage('Invoices issued this month', s.usage.invoices, s.entitlements.invoices), usage('Team members', s.usage.staff, s.entitlements.staff),
      h('div', { class: 'row wrap' }, s.status === 'past_due' && h('button', { class: 'btn primary', onclick: async () => { try { const r = await post('/subscription/retry'); toast(r.chargeOk ? 'Payment recovered' : `Still failing: ${r.chargeError}`); navigate(location.hash); } catch (e) { errToast(e); } } }, 'Retry payment'),
        h('button', { class: 'btn', onclick: async () => { const cur = await get('/subscription'); await post('/subscription/payment-method', { mode: cur.invoices[0] && cur.invoices[0].status === 'failed' ? 'ok' : 'decline' }); toast('Sandbox card toggled (ok ↔ decline)'); } }, 'Toggle sandbox card (test)'), !s.cancelAtPeriodEnd && s.planKey !== 'trial' && h('button', { class: 'btn danger', onclick: async () => { if (await confirmBox('Cancel at the end of the current period?')) { await post('/subscription/cancel'); navigate(location.hash); } } }, 'Cancel plan'))),
      h('div', { class: 'card stack' }, h('h2', null, 'Subscription invoices'), table([{ label: 'Invoice', key: 'number' }, { label: 'Plan', render: i => cap(i.plan_key) }, { label: 'Period', render: i => `${day(i.period_start)} – ${day(i.period_end)}` }, { label: 'Amount', right: true, render: i => fmt(i.amount_minor, i.currency) }, { label: 'Status', render: i => badge(i.status) }], s.invoices, { empty: 'No subscription invoices yet.' }))),
    h('h2', null, 'Plans'), h('div', { class: 'auto-grid' }, plans.filter(p => p.key !== 'trial' && p.active).map(p => h('div', { class: `card stack ${p.key === s.planKey ? 'tint' : ''}` }, h('h3', null, p.name), h('div', { class: 'n', style: { fontSize: '22px', fontWeight: 800 } }, fmt(p.monthlyMinor, p.currency), h('span', { class: 'small muted' }, ' / month')), h('div', { class: 'small muted' }, `or ${fmt(p.annualMinor, p.currency)} / year`),
      h('ul', { class: 'small', style: { paddingLeft: '18px', margin: 0 } }, h('li', null, p.entitlements.quotes === -1 ? 'Unlimited quotes' : `${p.entitlements.quotes} quotes / month`), h('li', null, p.entitlements.invoices === -1 ? 'Unlimited invoices' : `${p.entitlements.invoices} invoices / month`), h('li', null, p.entitlements.qr_payments ? 'QR invoice payments' : 'No QR payments')),
      p.key === s.planKey ? badge('active', 'Current plan') : h('div', { class: 'row' }, h('button', { class: 'btn primary sm', onclick: change(p, 'monthly') }, 'Monthly'), h('button', { class: 'btn sm', onclick: change(p, 'annual') }, 'Annual'))))));
}

async function kybPage() {
  const { case: k, config: cfg } = await get('/kyb');
  const editable = ['draft', 'rejected'].includes(k.status);
  const data = { ...k.data };
  const people = (key, label, extraPct) => {
    const rows = h('div', { class: 'stack tight' });
    const add = (p = {}) => { const n = h('input', { placeholder: 'Full name', value: p.name || '', disabled: !editable }), d = h('input', { placeholder: extraPct ? '% ownership' : 'Date of birth', value: (extraPct ? p.pct : p.dob) || '', disabled: !editable }); const row = h('div', { class: 'row' }, n, d, editable && h('button', { class: 'btn sm danger', type: 'button', onclick: () => row.remove() }, '✕')); row.read = () => ({ name: n.value, [extraPct ? 'pct' : 'dob']: d.value }); rows.append(row); };
    (data[key] || [{}]).forEach(add);
    const el = h('div', { class: 'stack tight' }, h('b', { class: 'small' }, label + (extraPct ? ` (threshold ${extraPct}%)` : '')), rows, editable && h('button', { class: 'btn sm', type: 'button', onclick: () => add() }, '+ Add person'));
    el.read = () => [...rows.children].map(r => r.read()).filter(p => p.name); return el;
  };
  const inputs = {};
  const fieldsUi = cfg.fields.map(f => {
    if (f.type === 'people') return (inputs[f.key] = people(f.key, f.label, f.thresholdPct));
    if (f.type === 'person') { const n = h('input', { value: (data[f.key] || {}).name || '', disabled: !editable }); n.read = () => ({ name: n.value }); inputs[f.key] = n; return h('label', { class: 'f' }, f.label, n); }
    const i = h('input', { value: data[f.key] || '', disabled: !editable }); i.read = () => i.value; inputs[f.key] = i; return h('label', { class: 'f' }, f.label + (f.optional ? ' (optional)' : ''), i);
  });
  const collect = () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.read()]));
  const have = new Set(k.evidence.map(e => e.kind));
  return h('div', { class: 'stack loose' }, pageHead('KYB & compliance', `${cap(k.country)} workflow · requirement set v${cfg.version} effective ${day(cfg.effectiveFrom)}`, badge(k.status)),
    cfg.validationStatus !== 'validated' && h('div', { class: 'notice warn' }, 'The requirement set for this country is placeholder configuration awaiting validation by qualified compliance professionals. Completing onboarding does not by itself make a business compliant.'),
    k.status === 'verified' && h('div', { class: 'notice ok' }, `Verified. Next review due ${day(k.nextReviewAt)}. Verification lapses if the review date passes or evidence expires.`),
    k.status === 'rejected' && h('div', { class: 'notice bad' }, `Rejected: ${k.decisionNote}. Correct the details and resubmit.`),
    k.status === 'submitted' && h('div', { class: 'notice info' }, `Submitted ${dt(k.submittedAt)} — screening: sanctions ${k.screening.sanctions}, PEP ${k.screening.pep} (${k.screening.provider}${k.screening.simulated ? ', simulated' : ''}). Awaiting platform review.`),
    h('div', { class: 'card stack' }, h('h2', null, 'Business details'), h('div', { class: 'grid c2' }, fieldsUi.filter((_, i) => cfg.fields[i].type === 'text'), ), fieldsUi.filter((_, i) => cfg.fields[i].type !== 'text'),
      editable && h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { try { await put('/kyb/data', collect()); toast('Draft saved'); } catch (e) { errToast(e); } } }, 'Save draft'))),
    h('div', { class: 'card stack' }, h('h2', null, 'Evidence'), cfg.evidence.map(kind => { const have1 = k.evidence.filter(e => e.kind === kind); return h('div', { class: 'row between wrap' }, h('div', null, h('b', null, cap(kind)), have1.map(e => h('div', { class: 'small muted' }, `${e.filename} · sha256 ${e.sha256.slice(0, 12)}…${e.expires_at ? ` · expires ${day(e.expires_at)}` : ''}`))),
      editable ? h('label', { class: 'btn sm' }, have1.length ? 'Replace / add' : 'Upload', h('input', { type: 'file', style: { display: 'none' }, onchange: async e => { const fd = new FormData(); fd.append('kind', kind); fd.append('file', e.target.files[0]); try { await put('/kyb/data', collect()); await api('POST', '/kyb/evidence', fd); navigate(location.hash); } catch (er) { errToast(er); } } })) : badge(have.has(kind) ? 'verified' : 'pending', have.has(kind) ? 'On file' : 'Missing')); })),
    editable && h('button', { class: 'btn primary', onclick: async () => { try { await put('/kyb/data', collect()); await post('/kyb/submit'); toast('Submitted for review'); navigate(location.hash); } catch (e) { errToast(e); } } }, 'Submit for verification'));
}

async function reportsPage() {
  const r = await get('/reports');
  return h('div', { class: 'stack loose' }, pageHead('Reports', 'Quote pipeline, receivables and settlements'), h('h2', null, 'Quotation pipeline'), table([{ label: 'Status', render: p => badge(p.status) }, { label: 'Count', key: 'n' }, { label: 'Value', right: true, render: p => fmt(p.total) }], r.pipeline || [], { empty: 'No quotations.' }),
    h('h2', null, 'Settlements'), table([{ label: 'Invoice', key: 'number' }, { label: 'Customer', key: 'customer' }, { label: 'Paid', render: i => dt(i.paid_at) }, { label: 'Net', right: true, render: i => fmt(i.total_minor - i.wht_minor) }], r.settlements || [], { empty: 'No settlements.' }));
}

export function registerVendor() {
  route('/v/storefront', storefrontPage); route('/v/products', productsPage); route('/v/requests', requestsPage); route('/v/requests/:id', requestDetail);
  route('/v/customers', customersPage); route('/v/agent', agentPage); route('/v/documents', documentsPage);
  route('/v/documents/q/:id', ctx => documentDetail('q', ctx.params[0])); route('/v/documents/i/:id', ctx => documentDetail('i', ctx.params[0]));
  route('/v/payments', paymentsPage); route('/v/subscription', subscriptionPage); route('/v/kyb', kybPage); route('/v/reports', reportsPage);
}
