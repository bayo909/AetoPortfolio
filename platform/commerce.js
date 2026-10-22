// Customer requests (RFQ / order / invoice request) and the vendor commercial documents they produce:
// quotations and invoices with draft -> approval -> delivery lifecycles, versioning, purchase orders and invoice QR references.
const { uid, iso } = require('./db');
const { bad, forbidden, notFound, conflict, unprocessable } = require('./errors');
const { toQtyMilli, toMinor, priceLine, totals, fmt } = require('./money');
const { signRef, verifyRef } = require('./security');

const DAY = 86400e3;
const addDays = (isoDate, n) => new Date(new Date(isoDate + 'T00:00:00Z').getTime() + n * DAY).toISOString().slice(0, 10);

module.exports = function commerceService(core) {
  const { db, now, audit } = core;
  const year = () => now().getUTCFullYear();

  /* ------------------------------ helpers ------------------------------ */
  const org = id => db.get('SELECT * FROM organizations WHERE id = ?', id);
  const orgName = id => (org(id) || {}).name;
  const userName = id => (id ? (db.get('SELECT name FROM users WHERE id = ?', id) || {}).name : null);
  const prefixOf = vendorOrgId => (db.get('SELECT slug FROM storefronts WHERE org_id = ?', vendorOrgId).slug.replace(/[^a-z]/g, '').slice(0, 3) || 'VND').toUpperCase();
  const linesOf = (type, id) => db.all('SELECT * FROM commercial_lines WHERE doc_type = ? AND doc_id = ? ORDER BY position', type, id);
  const lineView = l => ({ id: l.id, productId: l.product_id, sku: l.sku, description: l.description, qty: l.qty_milli / 1000, qtyMilli: l.qty_milli, unitPriceMinor: l.unit_price_minor, priceSource: l.price_source, discountBp: l.discount_bp, taxBp: l.tax_bp, whtBp: l.wht_bp,
    netMinor: l.net_minor, discountMinor: l.discount_minor, taxMinor: l.tax_minor, whtMinor: l.wht_minor, totalMinor: l.total_minor });
  function writeLines(type, docId, priced) {
    db.run('DELETE FROM commercial_lines WHERE doc_type = ? AND doc_id = ?', type, docId);
    priced.forEach((l, i) => db.insert('commercial_lines', {
      id: uid(), doc_type: type, doc_id: docId, position: i + 1, product_id: l.product_id || null, sku: l.sku || '', description: l.description, qty_milli: l.qty_milli,
      unit_price_minor: l.unit_price_minor, price_source: l.price_source, discount_bp: l.discount_bp || 0, tax_bp: l.tax_bp || 0, wht_bp: l.wht_bp || 0,
      net_minor: l.net_minor, discount_minor: l.discount_minor, tax_minor: l.tax_minor, wht_minor: l.wht_minor, total_minor: l.total_minor,
    }));
  }
  const setTotals = (table, id, t) => db.run(`UPDATE ${table} SET subtotal_minor=?, discount_minor=?, tax_minor=?, wht_minor=?, total_minor=? WHERE id=?`, t.subtotal_minor, t.discount_minor, t.tax_minor, t.wht_minor, t.total_minor, id);
  const decisionsOf = (type, id) => db.all('SELECT d.*, u.name actor FROM approval_decisions d JOIN users u ON u.id = d.actor_id WHERE d.subject_type = ? AND d.subject_id = ? ORDER BY d.at', type, id)
    .map(d => ({ decision: d.decision, actor: d.actor, comment: d.comment, version: d.subject_version, at: d.at }));
  const channelFor = (refType, refId) => db.get("SELECT * FROM channels WHERE kind = 'transaction' AND ref_type = ? AND ref_id = ?", refType, refId);
  const postCard = (channel, body, card) => channel && core.svc.chat.systemMessage(channel.id, body, card);
  const entitle = (vendorOrgId, feature) => core.svc.subscriptions && core.svc.subscriptions.assertEntitled(vendorOrgId, feature);
  const flagsOf = d => JSON.parse(d.flags_json || '[]');
  const relOk = (customerOrgId, vendorOrgId) => { if (!core.svc.vendor.activeRelationship(customerOrgId, vendorOrgId)) throw forbidden('No active relationship between these organisations', 'no_relationship'); };

  function vendorStaffIds(vendorOrgId, perm) {
    return db.all("SELECT user_id, role FROM organization_members WHERE org_id = ? AND status = 'active'", vendorOrgId).filter(m => core.permsFor(m.role).has(perm)).map(m => m.user_id);
  }

  /* ------------------------------ requests ------------------------------ */
  const requestView = (r, ctx) => {
    const items = JSON.parse(r.items_json);
    return {
      id: r.id, number: r.number, kind: r.kind, title: r.title, status: r.status, items, delivery: JSON.parse(r.delivery_json), purchaseRef: r.purchase_ref,
      customerOrgId: r.customer_org_id, customer: orgName(r.customer_org_id), vendorOrgId: r.vendor_org_id, vendor: orgName(r.vendor_org_id),
      requestedBy: userName(r.requested_by), requestedById: r.requested_by, channelId: (channelFor('request', r.id) || {}).id || null, createdAt: r.created_at, side: ctx.orgId === r.vendor_org_id ? 'vendor' : 'customer',
    };
  };
  const canSeeAllRequests = ctx => ctx.can('vendor.invite') || ctx.can('bill.validate') || ctx.can('bill.approve') || ctx.can('docs.review');

  const svc = {
    addDays, linesOf, lineView, flagsOf,

    createRequest(ctx, b) {
      ctx.require('request.create');
      if (!ctx.org.is_customer) throw forbidden();
      const kind = b.kind || 'rfq';
      if (!['rfq', 'order', 'invoice_request'].includes(kind)) throw bad('Invalid request kind');
      if (!String(b.title || '').trim()) throw bad('Title is required');
      relOk(ctx.orgId, b.vendorOrgId);
      const store = db.get('SELECT * FROM storefronts WHERE org_id = ? AND published = 1', b.vendorOrgId);
      if (!store) throw notFound('Storefront');
      const items = (b.items || []).map(i => {
        const p = i.productId ? db.get('SELECT * FROM products WHERE id = ? AND org_id = ? AND deleted_at IS NULL AND available = 1', i.productId, b.vendorOrgId) : null;
        if (i.productId && !p) throw bad('A requested item is not available from this vendor');
        const description = String(i.description || (p && p.name) || '').trim();
        if (!description) throw bad('Each item needs a description');
        return { productId: p ? p.id : null, sku: p ? p.sku : '', description, qtyMilli: toQtyMilli(i.qty), servicePeriod: i.servicePeriod || '' };
      });
      if (!items.length) throw bad('Add at least one item');
      if (kind === 'invoice_request' && !String(b.purchaseRef || '').trim() && !b.quoteId) { /* allowed: reference optional */ }
      const n = db.get('SELECT COUNT(*) n FROM requests WHERE customer_org_id = ?', ctx.orgId).n + 1;
      const pre = { rfq: 'RFQ', order: 'ORD', invoice_request: 'IRQ' }[kind];
      const r = {
        id: uid(), number: `${pre}-${year()}-${String(n).padStart(4, '0')}`, kind, customer_org_id: ctx.orgId, vendor_org_id: b.vendorOrgId, title: b.title.trim(),
        items_json: JSON.stringify(items), delivery_json: JSON.stringify({ address: b.delivery?.address || '', date: b.delivery?.date || '', notes: b.notes || '' }),
        purchase_ref: b.purchaseRef || '', status: 'open', requested_by: ctx.userId, created_at: iso(now()),
      };
      db.tx(() => {
        db.insert('requests', r);
        const est = items.reduce((s, i) => { const p = i.productId && db.get('SELECT unit_price_minor FROM products WHERE id = ?', i.productId); return s + (p ? Math.round(i.qtyMilli * p.unit_price_minor / 1000) : 0); }, 0);
        const prN = db.get('SELECT COUNT(*) n FROM purchase_requests WHERE org_id = ?', ctx.orgId).n + 1;
        db.insert('purchase_requests', { id: uid(), org_id: ctx.orgId, number: `PR-${year()}-${String(prN).padStart(4, '0')}`, request_id: r.id, description: r.title, estimated_minor: est,
          cost_center: ctx.member.cost_center, justification: b.notes || '', status: 'open', requested_by: ctx.userId, created_at: iso(now()) });
        const ch = core.svc.chat.ensureTransactionChannel(ctx.orgId, b.vendorOrgId, 'request', r.id, r.number.toLowerCase(), ctx.userId);
        core.svc.chat.systemMessage(ch.id, `${ctx.user.name} opened ${r.number}: ${r.title}`, { type: 'request', id: r.id, number: r.number, title: r.title, kind });
        audit.record([ctx.orgId, b.vendorOrgId], { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'request.created', objectType: 'request', objectId: r.id, next: { number: r.number, kind, items: items.length } });
        core.notify(vendorStaffIds(b.vendorOrgId, 'request.respond'), { orgId: b.vendorOrgId, kind: 'request', title: `New ${kind === 'invoice_request' ? 'invoice request' : kind.toUpperCase()} from ${ctx.org.name}`, body: r.title, link: `#/v/requests/${r.id}` });
      });
      return requestView(db.get('SELECT * FROM requests WHERE id = ?', r.id), ctx);
    },
    listRequests(ctx) {
      const vendorSide = ctx.org.is_vendor && ctx.can('request.respond');
      const rows = [];
      if (vendorSide) rows.push(...db.all('SELECT * FROM requests WHERE vendor_org_id = ? ORDER BY created_at DESC', ctx.orgId));
      if (ctx.org.is_customer && ctx.can('request.create')) {
        rows.push(...(canSeeAllRequests(ctx) ? db.all('SELECT * FROM requests WHERE customer_org_id = ? ORDER BY created_at DESC', ctx.orgId) : db.all('SELECT * FROM requests WHERE customer_org_id = ? AND requested_by = ? ORDER BY created_at DESC', ctx.orgId, ctx.userId)));
      }
      return rows.map(r => requestView(r, ctx));
    },
    mustRequest(ctx, id) {
      const r = db.get('SELECT * FROM requests WHERE id = ?', id);
      const vendorSide = r && r.vendor_org_id === ctx.orgId && ctx.can('request.respond');
      const custSide = r && r.customer_org_id === ctx.orgId && (r.requested_by === ctx.userId || canSeeAllRequests(ctx));
      if (!vendorSide && !custSide) throw notFound('Request');
      return r;
    },
    getRequest(ctx, id) {
      const r = svc.mustRequest(ctx, id);
      return {
        ...requestView(r, ctx),
        quotes: db.all('SELECT * FROM quotations WHERE request_id = ? ORDER BY version', id).filter(q => q.vendor_org_id === ctx.orgId || q.delivered_at).map(q => quoteSummary(q, ctx)),
        invoices: db.all('SELECT * FROM invoices WHERE request_id = ? OR quote_id IN (SELECT id FROM quotations WHERE request_id = ?)', id, id).filter(i => i.vendor_org_id === ctx.orgId || i.issued_at).map(i => invoiceSummary(i, ctx)),
      };
    },
    cancelRequest(ctx, id) {
      const r = db.get('SELECT * FROM requests WHERE id = ? AND customer_org_id = ?', id, ctx.orgId);
      if (!r || (r.requested_by !== ctx.userId && !canSeeAllRequests(ctx))) throw notFound('Request');
      if (!['open', 'quoted'].includes(r.status)) throw conflict(`Request is ${r.status}`);
      db.tx(() => { db.run("UPDATE requests SET status = 'cancelled' WHERE id = ?", id); audit.record([r.customer_org_id, r.vendor_org_id], { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'request.cancelled', objectType: 'request', objectId: id }); });
    },

    /* ------------------------------ quotations ------------------------------ */
    quoteFor(ctx, id) {
      const q = db.get('SELECT * FROM quotations WHERE id = ?', id);
      const vendor = q && q.vendor_org_id === ctx.orgId && (ctx.can('request.respond') || ctx.can('quote.approve'));
      const cust = q && q.customer_org_id === ctx.orgId && q.delivered_at && (ctx.can('request.create') || ctx.can('quote.accept'));
      if (!vendor && !cust) throw notFound('Quotation');
      return q;
    },
    listQuotes(ctx) {
      const rows = ctx.org.is_vendor && ctx.can('request.respond')
        ? db.all('SELECT * FROM quotations WHERE vendor_org_id = ? ORDER BY created_at DESC', ctx.orgId)
        : db.all('SELECT * FROM quotations WHERE customer_org_id = ? AND delivered_at IS NOT NULL ORDER BY created_at DESC', ctx.orgId);
      return rows.map(q => quoteSummary(q, ctx));
    },
    getQuote(ctx, id) {
      const q = svc.quoteFor(ctx, id);
      const vendorSide = q.vendor_org_id === ctx.orgId;
      return { ...quoteSummary(q, ctx), lines: linesOf('quotation', id).map(lineView), flags: vendorSide ? flagsOf(q) : [], decisions: vendorSide ? decisionsOf('quotation', id) : [], terms: q.terms, notes: q.notes,
        versions: db.all('SELECT id, version, status FROM quotations WHERE vendor_org_id = ? AND number = ? ORDER BY version', q.vendor_org_id, q.number), canonicalRequestId: q.request_id };
    },
    /** Draft quote. Lines are priced here, server side, from the catalogue and pricing rules (or an explicit, flagged manual price). */
    createQuote(ctx, b, { via = 'user', extraFlags = [] } = {}) {
      ctx.require('quote.draft');
      const req = b.requestId ? db.get('SELECT * FROM requests WHERE id = ? AND vendor_org_id = ?', b.requestId, ctx.orgId) : null;
      if (!req) throw bad('A quote must answer a customer request', undefined, 'request_required');
      if (!['open', 'quoted'].includes(req.status)) throw conflict(`Request is ${req.status}`);
      relOk(req.customer_org_id, ctx.orgId);
      const currency = b.currency || ctx.org.currency;
      const priced = core.svc.agent.priceDraft(ctx.orgId, req.customer_org_id, normaliseItems(b.lines), { currency });
      if (!priced.lines.length) throw bad('Add at least one line', priced.flags);
      const n = db.get("SELECT COUNT(*) n FROM quotations WHERE vendor_org_id = ? AND version = 1", ctx.orgId).n + 1;
      const q = {
        id: uid(), number: `QT-${prefixOf(ctx.orgId)}-${year()}-${String(n).padStart(4, '0')}`, version: 1, vendor_org_id: ctx.orgId, customer_org_id: req.customer_org_id, request_id: req.id,
        status: 'draft', currency, valid_until: b.validUntil || addDays(core.today(), 30), terms: b.terms || '', notes: b.notes || '', created_by: ctx.userId, prepared_by: ctx.userId,
        created_via: via, flags_json: JSON.stringify([...priced.flags, ...extraFlags, ...priced.explain.map(msg => ({ level: 'info', code: 'explain', msg }))]),
        is_demo: ctx.org.is_demo, created_at: iso(now()),
      };
      db.tx(() => {
        db.insert('quotations', q);
        writeLines('quotation', q.id, priced.lines);
        setTotals('quotations', q.id, priced.totals);
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: via === 'agent' ? 'quote.drafted_by_agent' : 'quote.drafted', objectType: 'quotation', objectId: q.id, next: { number: q.number, totalMinor: priced.totals.total_minor }, refs: { requestId: req.id } });
      });
      return svc.getQuote(ctx, q.id);
    },
    updateQuote(ctx, id, b) {
      ctx.require('quote.draft');
      const q = db.get('SELECT * FROM quotations WHERE id = ? AND vendor_org_id = ?', id, ctx.orgId);
      if (!q) throw notFound('Quotation');
      if (q.status !== 'draft') throw conflict('Only draft quotations can be edited — create a revision instead', 'not_draft');
      db.tx(() => {
        if (b.lines) {
          const priced = core.svc.agent.priceDraft(ctx.orgId, q.customer_org_id, normaliseItems(b.lines), { currency: q.currency });
          if (!priced.lines.length) throw bad('A quotation needs at least one line', priced.flags);
          writeLines('quotation', id, priced.lines); setTotals('quotations', id, priced.totals);
          db.run('UPDATE quotations SET flags_json = ? WHERE id = ?', JSON.stringify([...priced.flags, ...priced.explain.map(msg => ({ level: 'info', code: 'explain', msg }))]), id);
        }
        db.run('UPDATE quotations SET terms = ?, notes = ?, valid_until = ?, prepared_by = ? WHERE id = ?', b.terms ?? q.terms, b.notes ?? q.notes, b.validUntil ?? q.valid_until, ctx.userId, id);
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'quote.edited', objectType: 'quotation', objectId: id, prior: { totalMinor: q.total_minor } });
      });
      return svc.getQuote(ctx, id);
    },
    submitQuote(ctx, id) {
      ctx.require('quote.draft');
      const q = db.get('SELECT * FROM quotations WHERE id = ? AND vendor_org_id = ?', id, ctx.orgId);
      if (!q) throw notFound('Quotation');
      if (q.status !== 'draft') throw conflict(`Quotation is ${q.status}`);
      blockers(q, 'quotation');
      entitle(ctx.orgId, 'quotes');
      db.tx(() => {
        db.run("UPDATE quotations SET status = 'pending_approval', prepared_by = ? WHERE id = ?", ctx.userId, id);
        db.insert('approval_decisions', { id: uid(), org_id: ctx.orgId, subject_type: 'quotation', subject_id: id, subject_version: q.version, actor_id: ctx.userId, decision: 'submitted', comment: '', at: iso(now()) });
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'quote.submitted', objectType: 'quotation', objectId: id, prior: { status: 'draft' }, next: { status: 'pending_approval', version: q.version } });
        core.notify(vendorStaffIds(ctx.orgId, 'quote.approve').filter(u => u !== ctx.userId), { orgId: ctx.orgId, kind: 'approval', title: `Quote ${q.number} awaits your approval`, link: `#/v/documents` });
      });
      return svc.getQuote(ctx, id);
    },
    approveQuote(ctx, id, { comment = '' } = {}) {
      ctx.require('quote.approve');
      const q = db.get('SELECT * FROM quotations WHERE id = ? AND vendor_org_id = ?', id, ctx.orgId);
      if (!q) throw notFound('Quotation');
      if (q.status !== 'pending_approval') throw conflict(`Quotation is ${q.status}`);
      selfApprovalGuard(ctx, q, 'quotation');
      blockers(q, 'quotation');
      const req = db.get('SELECT * FROM requests WHERE id = ?', q.request_id);
      db.tx(() => {
        db.run("UPDATE quotations SET status = 'approved', approved_by = ?, approved_at = ?, delivered_at = ? WHERE id = ?", ctx.userId, iso(now()), iso(now()), id);
        db.insert('approval_decisions', { id: uid(), org_id: ctx.orgId, subject_type: 'quotation', subject_id: id, subject_version: q.version, actor_id: ctx.userId, decision: 'approved', comment, at: iso(now()) });
        if (req) db.run("UPDATE requests SET status = 'quoted' WHERE id = ? AND status = 'open'", req.id);
        audit.record([q.vendor_org_id, q.customer_org_id], { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'quote.approved', objectType: 'quotation', objectId: id, prior: { status: 'pending_approval' }, next: { status: 'approved', version: q.version, totalMinor: q.total_minor }, reason: comment });
        postCard(channelFor('request', q.request_id), `Quotation ${q.number} (v${q.version}) approved by ${orgName(q.vendor_org_id)} and sent to ${orgName(q.customer_org_id)}`, { type: 'quote', id: q.id, number: q.number, totalMinor: q.total_minor, currency: q.currency });
        if (req) core.notify(req.requested_by, { orgId: q.customer_org_id, kind: 'document', title: `Quotation ${q.number} is ready`, body: `${orgName(q.vendor_org_id)} approved a quote for ${req.title}`, link: `#/e/requests/${req.id}` });
      });
      return svc.getQuote(ctx, id);
    },
    rejectQuote(ctx, id, { reason }) {
      ctx.require('quote.approve');
      if (!String(reason || '').trim()) throw bad('A reason is required');
      const q = db.get('SELECT * FROM quotations WHERE id = ? AND vendor_org_id = ?', id, ctx.orgId);
      if (!q) throw notFound('Quotation');
      if (q.status !== 'pending_approval') throw conflict(`Quotation is ${q.status}`);
      db.tx(() => {
        db.run("UPDATE quotations SET status = 'rejected' WHERE id = ?", id);
        db.insert('approval_decisions', { id: uid(), org_id: ctx.orgId, subject_type: 'quotation', subject_id: id, subject_version: q.version, actor_id: ctx.userId, decision: 'rejected', comment: reason, at: iso(now()) });
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'quote.rejected', objectType: 'quotation', objectId: id, reason });
        if (q.prepared_by) core.notify(q.prepared_by, { orgId: ctx.orgId, kind: 'approval', title: `Quote ${q.number} was rejected`, body: reason, link: '#/v/documents' });
      });
      return svc.getQuote(ctx, id);
    },
    reviseQuote(ctx, id) {
      ctx.require('quote.draft');
      const q = db.get('SELECT * FROM quotations WHERE id = ? AND vendor_org_id = ?', id, ctx.orgId);
      if (!q) throw notFound('Quotation');
      if (!['pending_approval', 'approved', 'rejected'].includes(q.status)) throw conflict(`A ${q.status} quotation cannot be revised`);
      if (q.status === 'approved' && db.get("SELECT 1 x FROM invoices WHERE quote_id = ? AND status NOT IN ('cancelled','superseded')", id)) throw conflict('An invoice already exists for this quotation');
      const nid = uid();
      db.tx(() => {
        db.run("UPDATE quotations SET status = 'superseded' WHERE id = ?", id);
        db.insert('quotations', { ...q, id: nid, version: q.version + 1, supersedes_id: id, status: 'draft', approved_by: null, approved_at: null, delivered_at: null, accepted_by: null, accepted_at: null, created_by: ctx.userId, prepared_by: ctx.userId, created_at: iso(now()) });
        db.run('INSERT INTO commercial_lines SELECT lower(hex(randomblob(16))), doc_type, ?, position, product_id, sku, description, qty_milli, unit_price_minor, price_source, discount_bp, tax_bp, wht_bp, net_minor, discount_minor, tax_minor, wht_minor, total_minor FROM commercial_lines WHERE doc_type = ? AND doc_id = ?', nid, 'quotation', id);
        audit.record([q.vendor_org_id, q.customer_org_id], { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'quote.revised', objectType: 'quotation', objectId: nid, prior: { id, version: q.version }, next: { version: q.version + 1 } });
      });
      return svc.getQuote(ctx, nid);
    },
    acceptQuote(ctx, id) {
      ctx.require('quote.accept');
      const q = db.get('SELECT * FROM quotations WHERE id = ? AND customer_org_id = ? AND delivered_at IS NOT NULL', id, ctx.orgId);
      if (!q) throw notFound('Quotation');
      if (q.status !== 'approved') throw conflict(`Quotation is ${q.status}`);
      if (q.valid_until && q.valid_until < core.today()) { db.run("UPDATE quotations SET status = 'expired' WHERE id = ?", id); throw conflict('This quotation has expired — ask the vendor for a revision', 'expired'); }
      relOk(ctx.orgId, q.vendor_org_id);
      const req = db.get('SELECT * FROM requests WHERE id = ?', q.request_id);
      if (req && req.requested_by === ctx.userId && q.total_minor > 10_000_000) throw forbidden('Large purchases need acceptance by someone other than the requester (FIN-POL-002)', 'segregation');
      let po;
      db.tx(() => {
        db.run("UPDATE quotations SET status = 'accepted', accepted_by = ?, accepted_at = ? WHERE id = ?", ctx.userId, iso(now()), id);
        const n = db.get('SELECT COUNT(*) n FROM purchase_orders WHERE org_id = ?', ctx.orgId).n + 1;
        po = { id: uid(), org_id: ctx.orgId, number: `PO-${year()}-${String(n).padStart(5, '0')}`, vendor_org_id: q.vendor_org_id, quote_id: id, request_id: q.request_id, amount_minor: q.total_minor, currency: q.currency, status: 'issued', issued_by: ctx.userId, created_at: iso(now()) };
        db.insert('purchase_orders', po);
        if (req) db.run("UPDATE requests SET status = 'accepted' WHERE id = ?", req.id);
        db.insert('approval_decisions', { id: uid(), org_id: ctx.orgId, subject_type: 'quotation_acceptance', subject_id: id, subject_version: q.version, actor_id: ctx.userId, decision: 'approved', comment: `PO ${po.number}`, at: iso(now()) });
        audit.record([q.customer_org_id, q.vendor_org_id], { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'quote.accepted', objectType: 'quotation', objectId: id, next: { poNumber: po.number, totalMinor: q.total_minor } });
        postCard(channelFor('request', q.request_id), `${ctx.user.name} accepted ${q.number} and issued purchase order ${po.number}`, { type: 'quote', id: q.id, number: q.number, totalMinor: q.total_minor, currency: q.currency });
        core.notify(vendorStaffIds(q.vendor_org_id, 'invoice.draft'), { orgId: q.vendor_org_id, kind: 'document', title: `${q.number} accepted — PO ${po.number}`, body: 'You can now prepare the invoice.', link: '#/v/documents' });
      });
      return { ...svc.getQuote(ctx, id), purchaseOrder: { id: po.id, number: po.number } };
    },
    declineQuote(ctx, id, reason) {
      ctx.require('quote.accept');
      const q = db.get('SELECT * FROM quotations WHERE id = ? AND customer_org_id = ? AND delivered_at IS NOT NULL', id, ctx.orgId);
      if (!q) throw notFound('Quotation');
      if (q.status !== 'approved') throw conflict(`Quotation is ${q.status}`);
      db.tx(() => {
        db.run("UPDATE quotations SET status = 'declined' WHERE id = ?", id);
        audit.record([q.customer_org_id, q.vendor_org_id], { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'quote.declined', objectType: 'quotation', objectId: id, reason: reason || '' });
        postCard(channelFor('request', q.request_id), `${ctx.user.name} declined ${q.number}${reason ? `: ${reason}` : ''}`, null);
      });
      return svc.getQuote(ctx, id);
    },

    /* ------------------------------- invoices ------------------------------- */
    invoiceFor(ctx, id) {
      const i = db.get('SELECT * FROM invoices WHERE id = ?', id);
      const vendor = i && i.vendor_org_id === ctx.orgId && (ctx.can('request.respond') || ctx.can('invoice.approve'));
      const cust = i && i.customer_org_id === ctx.orgId && i.issued_at && (ctx.can('bill.view') || ctx.can('request.create'));
      if (!vendor && !cust) throw notFound('Invoice');
      return i;
    },
    listInvoices(ctx) {
      const rows = ctx.org.is_vendor && ctx.can('request.respond')
        ? db.all('SELECT * FROM invoices WHERE vendor_org_id = ? ORDER BY created_at DESC', ctx.orgId)
        : db.all('SELECT * FROM invoices WHERE customer_org_id = ? AND issued_at IS NOT NULL ORDER BY created_at DESC', ctx.orgId);
      return rows.map(i => invoiceSummary(i, ctx));
    },
    getInvoice(ctx, id) {
      const i = svc.invoiceFor(ctx, id);
      const vendorSide = i.vendor_org_id === ctx.orgId;
      return { ...invoiceSummary(i, ctx), lines: linesOf('invoice', id).map(lineView), flags: vendorSide ? flagsOf(i) : [], decisions: vendorSide ? decisionsOf('invoice', id) : [], notes: i.notes,
        versions: db.all('SELECT id, version, status FROM invoices WHERE vendor_org_id = ? AND number = ? ORDER BY version', i.vendor_org_id, i.number) };
    },
    /**
     * Invoices only exist in answer to a customer request: either an accepted quotation, or an explicit invoice request.
     * A vendor cannot create an unsolicited payable invoice for a customer.
     */
    createInvoice(ctx, b, { via = 'user', extraFlags = [] } = {}) {
      ctx.require('invoice.draft');
      let quote = null, req = null;
      if (b.quoteId) {
        quote = db.get('SELECT * FROM quotations WHERE id = ? AND vendor_org_id = ?', b.quoteId, ctx.orgId);
        if (!quote) throw notFound('Quotation');
        if (quote.status !== 'accepted') throw unprocessable('The customer must accept the quotation before it can be invoiced', undefined, 'quote_not_accepted');
        if (db.get("SELECT 1 x FROM invoices WHERE quote_id = ? AND status NOT IN ('cancelled','superseded')", quote.id)) throw conflict('This quotation has already been invoiced');
        req = db.get('SELECT * FROM requests WHERE id = ?', quote.request_id);
      } else if (b.requestId) {
        req = db.get('SELECT * FROM requests WHERE id = ? AND vendor_org_id = ?', b.requestId, ctx.orgId);
        if (!req) throw notFound('Request');
        if (req.kind !== 'invoice_request') throw unprocessable('This request is not an invoice request; quote it and wait for acceptance', undefined, 'unsolicited_invoice');
        if (!['open', 'quoted'].includes(req.status)) throw conflict(`Request is ${req.status}`);
      } else throw unprocessable('Invoices must answer a customer invoice request or an accepted quotation — unsolicited invoices are not allowed', undefined, 'unsolicited_invoice');
      relOk(req.customer_org_id, ctx.orgId);
      const vp = db.get('SELECT * FROM vendor_profiles WHERE org_id = ?', ctx.orgId);
      const n = db.get('SELECT COUNT(*) n FROM invoices WHERE vendor_org_id = ? AND version = 1', ctx.orgId).n + 1;
      const inv = {
        id: uid(), number: `INV-${prefixOf(ctx.orgId)}-${year()}-${String(n).padStart(4, '0')}`, version: 1, vendor_org_id: ctx.orgId, customer_org_id: req.customer_org_id, quote_id: quote ? quote.id : null, request_id: req.id,
        po_id: quote ? (db.get('SELECT id FROM purchase_orders WHERE quote_id = ?', quote.id) || {}).id || null : null, status: 'draft', currency: quote ? quote.currency : (b.currency || ctx.org.currency),
        payment_terms_days: vp.payment_terms_days, notes: b.notes || '', created_by: ctx.userId, prepared_by: ctx.userId, created_via: via, is_demo: ctx.org.is_demo, created_at: iso(now()), flags_json: '[]',
      };
      let priced;
      if (quote) {
        priced = { lines: linesOf('quotation', quote.id).map(l => ({ ...l })), flags: [], explain: [] };
        priced.totals = totals(priced.lines);
      } else {
        const items = normaliseItems(b.lines && b.lines.length ? b.lines : JSON.parse(req.items_json).map(i => ({ productId: i.productId, description: i.description, qtyMilli: i.qtyMilli })));
        priced = core.svc.agent.priceDraft(ctx.orgId, req.customer_org_id, items, { currency: inv.currency });
        if (!priced.lines.length) throw bad('Add at least one line', priced.flags);
        inv.flags_json = JSON.stringify([...priced.flags, ...extraFlags, ...priced.explain.map(msg => ({ level: 'info', code: 'explain', msg }))]);
      }
      db.tx(() => {
        db.insert('invoices', inv);
        writeLines('invoice', inv.id, priced.lines);
        setTotals('invoices', inv.id, priced.totals);
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: via === 'agent' ? 'invoice.drafted_by_agent' : 'invoice.drafted', objectType: 'invoice', objectId: inv.id, next: { number: inv.number, totalMinor: priced.totals.total_minor }, refs: { quoteId: inv.quote_id, requestId: req.id } });
      });
      return svc.getInvoice(ctx, inv.id);
    },
    submitInvoice(ctx, id) {
      ctx.require('invoice.draft');
      const i = db.get('SELECT * FROM invoices WHERE id = ? AND vendor_org_id = ?', id, ctx.orgId);
      if (!i) throw notFound('Invoice');
      if (i.status !== 'draft') throw conflict(`Invoice is ${i.status}`);
      blockers(i, 'invoice');
      db.tx(() => {
        db.run("UPDATE invoices SET status = 'submitted', prepared_by = ? WHERE id = ?", ctx.userId, id);
        db.insert('approval_decisions', { id: uid(), org_id: ctx.orgId, subject_type: 'invoice', subject_id: id, subject_version: i.version, actor_id: ctx.userId, decision: 'submitted', comment: '', at: iso(now()) });
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'invoice.submitted', objectType: 'invoice', objectId: id, prior: { status: 'draft' }, next: { status: 'submitted' } });
        core.notify(vendorStaffIds(ctx.orgId, 'invoice.approve').filter(u => u !== ctx.userId), { orgId: ctx.orgId, kind: 'approval', title: `Invoice ${i.number} awaits your approval`, link: '#/v/documents' });
      });
      return svc.getInvoice(ctx, id);
    },
    approveInvoice(ctx, id, { comment = '' } = {}) {
      ctx.require('invoice.approve');
      const i = db.get('SELECT * FROM invoices WHERE id = ? AND vendor_org_id = ?', id, ctx.orgId);
      if (!i) throw notFound('Invoice');
      if (i.status !== 'submitted') throw conflict(`Invoice is ${i.status}`);
      selfApprovalGuard(ctx, i, 'invoice');
      blockers(i, 'invoice');
      db.tx(() => {
        db.run("UPDATE invoices SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?", ctx.userId, iso(now()), id);
        db.insert('approval_decisions', { id: uid(), org_id: ctx.orgId, subject_type: 'invoice', subject_id: id, subject_version: i.version, actor_id: ctx.userId, decision: 'approved', comment, at: iso(now()) });
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'invoice.approved', objectType: 'invoice', objectId: id, prior: { status: 'submitted' }, next: { status: 'approved', version: i.version, totalMinor: i.total_minor }, reason: comment });
      });
      return svc.getInvoice(ctx, id);
    },
    rejectInvoice(ctx, id, { reason }) {
      ctx.require('invoice.approve');
      if (!String(reason || '').trim()) throw bad('A reason is required');
      const i = db.get('SELECT * FROM invoices WHERE id = ? AND vendor_org_id = ?', id, ctx.orgId);
      if (!i) throw notFound('Invoice');
      if (i.status !== 'submitted') throw conflict(`Invoice is ${i.status}`);
      db.tx(() => {
        db.run("UPDATE invoices SET status = 'draft' WHERE id = ?", id);
        db.insert('approval_decisions', { id: uid(), org_id: ctx.orgId, subject_type: 'invoice', subject_id: id, subject_version: i.version, actor_id: ctx.userId, decision: 'returned', comment: reason, at: iso(now()) });
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'invoice.returned', objectType: 'invoice', objectId: id, reason });
      });
      return svc.getInvoice(ctx, id);
    },
    /** Issue = deliver the approved invoice to the customer, which creates the payable bill there (a controlled backend conversion). */
    issueInvoice(ctx, id) {
      ctx.require('invoice.issue');
      const i = db.get('SELECT * FROM invoices WHERE id = ? AND vendor_org_id = ?', id, ctx.orgId);
      if (!i) throw notFound('Invoice');
      if (i.status !== 'approved') throw conflict(`Only approved invoices can be issued (invoice is ${i.status})`);
      relOk(i.customer_org_id, ctx.orgId);
      entitle(ctx.orgId, 'invoices');
      const issuedAt = iso(now());
      return db.tx(() => {
        const due = addDays(core.today(), i.payment_terms_days);
        const prev = i.supersedes_id && db.get('SELECT * FROM invoices WHERE id = ?', i.supersedes_id);
        if (prev) core.svc.bills.supersedeForRevision(prev, i);
        db.run("UPDATE invoices SET status = 'issued', issued_at = ?, due_date = ? WHERE id = ?", issuedAt, due, id);
        const bill = core.svc.bills.createFromInvoice({ ...i, issued_at: issuedAt, due_date: due }, linesOf('invoice', id));
        db.run('UPDATE invoices SET bill_id = ? WHERE id = ?', bill.id, id);
        if (i.request_id) db.run("UPDATE requests SET status = 'invoiced' WHERE id = ?", i.request_id);
        audit.record([i.vendor_org_id, i.customer_org_id], { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'invoice.issued', objectType: 'invoice', objectId: id, prior: { status: 'approved' }, next: { status: 'issued', billId: bill.id, billNumber: bill.number, dueDate: due }, refs: { quoteId: i.quote_id, billId: bill.id } });
        postCard(channelFor('request', i.request_id), `Invoice ${i.number} issued — payable bill ${bill.number} created in ${orgName(i.customer_org_id)}'s finance queue`, { type: 'invoice', id: i.id, number: i.number, totalMinor: i.total_minor, currency: i.currency });
        core.notify(db.all("SELECT user_id, role FROM organization_members WHERE org_id = ? AND status = 'active'", i.customer_org_id).filter(m => core.permsFor(m.role).has('bill.validate')).map(m => m.user_id).concat(i.request_id ? [(db.get('SELECT requested_by FROM requests WHERE id = ?', i.request_id) || {}).requested_by] : []),
          { orgId: i.customer_org_id, kind: 'document', title: `Invoice ${i.number} received from ${orgName(i.vendor_org_id)}`, body: `Bill ${bill.number} is waiting for validation.`, link: `#/e/bills/${bill.id}` });
        return svc.getInvoice(ctx, id);
      });
    },
    /** Vendor correction after a dispute or before payment: a new version; the old one (and its bill) is preserved but superseded on issue. */
    reviseInvoice(ctx, id) {
      ctx.require('invoice.draft');
      const i = db.get('SELECT * FROM invoices WHERE id = ? AND vendor_org_id = ?', id, ctx.orgId);
      if (!i) throw notFound('Invoice');
      if (!['draft', 'submitted', 'approved', 'disputed', 'issued'].includes(i.status)) throw conflict(`A ${i.status} invoice cannot be revised`);
      if (i.status === 'issued') {
        const b = i.bill_id && db.get('SELECT * FROM bills WHERE id = ?', i.bill_id);
        if (b && (b.payment_status !== 'unpaid' || ['approved', 'pending_approval'].includes(b.status))) throw conflict('This invoice is already in the customer\'s approval or payment flow — the customer must dispute it first');
      }
      const nid = uid();
      db.tx(() => {
        if (i.status !== 'issued' && i.status !== 'disputed') db.run("UPDATE invoices SET status = 'superseded' WHERE id = ?", id);
        db.insert('invoices', { ...i, id: nid, version: i.version + 1, supersedes_id: id, status: 'draft', approved_by: null, approved_at: null, issued_at: null, due_date: null, bill_id: null, dispute_reason: null, created_by: ctx.userId, prepared_by: ctx.userId, created_at: iso(now()) });
        db.run('INSERT INTO commercial_lines SELECT lower(hex(randomblob(16))), doc_type, ?, position, product_id, sku, description, qty_milli, unit_price_minor, price_source, discount_bp, tax_bp, wht_bp, net_minor, discount_minor, tax_minor, wht_minor, total_minor FROM commercial_lines WHERE doc_type = ? AND doc_id = ?', nid, 'invoice', id);
        audit.record([i.vendor_org_id, i.customer_org_id], { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'invoice.revised', objectType: 'invoice', objectId: nid, prior: { id, version: i.version }, next: { version: i.version + 1 } });
      });
      return svc.getInvoice(ctx, nid);
    },
    /** Vendor edits a draft invoice (lines re-priced by the server). */
    updateInvoice(ctx, id, b) {
      ctx.require('invoice.draft');
      const i = db.get('SELECT * FROM invoices WHERE id = ? AND vendor_org_id = ?', id, ctx.orgId);
      if (!i) throw notFound('Invoice');
      if (i.status !== 'draft') throw conflict('Only draft invoices can be edited — create a revision instead', 'not_draft');
      if (i.quote_id && b.lines) throw unprocessable('Lines of an invoice raised from an accepted quotation cannot be changed; revise the quotation instead', undefined, 'quote_locked');
      db.tx(() => {
        if (b.lines) {
          const priced = core.svc.agent.priceDraft(ctx.orgId, i.customer_org_id, normaliseItems(b.lines), { currency: i.currency });
          if (!priced.lines.length) throw bad('An invoice needs at least one line', priced.flags);
          writeLines('invoice', id, priced.lines); setTotals('invoices', id, priced.totals);
          db.run('UPDATE invoices SET flags_json = ? WHERE id = ?', JSON.stringify([...priced.flags, ...priced.explain.map(msg => ({ level: 'info', code: 'explain', msg }))]), id);
        }
        db.run('UPDATE invoices SET notes = ?, prepared_by = ? WHERE id = ?', b.notes ?? i.notes, ctx.userId, id);
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'invoice.edited', objectType: 'invoice', objectId: id, prior: { totalMinor: i.total_minor } });
      });
      return svc.getInvoice(ctx, id);
    },
    cancelInvoice(ctx, id, reason) {
      ctx.require('invoice.approve');
      const i = db.get('SELECT * FROM invoices WHERE id = ? AND vendor_org_id = ?', id, ctx.orgId);
      if (!i) throw notFound('Invoice');
      if (!['draft', 'submitted', 'approved', 'issued', 'disputed'].includes(i.status)) throw conflict(`Invoice is ${i.status}`);
      db.tx(() => {
        if (i.bill_id) core.svc.bills.cancelForInvoice(i, reason || 'Cancelled by vendor');
        db.run("UPDATE invoices SET status = 'cancelled' WHERE id = ?", id);
        audit.record([i.vendor_org_id, i.customer_org_id], { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'invoice.cancelled', objectType: 'invoice', objectId: id, prior: { status: i.status }, reason: reason || '' });
      });
      return svc.getInvoice(ctx, id);
    },
    markInvoicePaid(invoiceId) {
      db.run("UPDATE invoices SET status = 'paid', paid_at = ? WHERE id = ? AND status IN ('issued','disputed')", iso(now()), invoiceId);
    },

    /* ------------------------------ QR reference ------------------------------ */
    /** Signed, opaque reference: carries only an invoice id and expiry. Never bank details. */
    qrToken(invoice) {
      if (!invoice.issued_at) throw unprocessable('Only issued invoices have a payment QR', undefined, 'not_issued');
      const exp = Math.floor(new Date(addDays(invoice.due_date, 30) + 'T23:59:59Z').getTime() / 1000);
      return signRef(core.secrets.qr, { v: 1, t: 'inv', i: invoice.id, e: exp });
    },
    verifyQr(token) { return verifyRef(core.secrets.qr, token); },
    qrFor(ctx, invoiceId) {
      const i = svc.invoiceFor(ctx, invoiceId);
      if (i.vendor_org_id === ctx.orgId && core.svc.subscriptions) core.svc.subscriptions.assertEntitled(ctx.orgId, 'qr_payments');
      if (['draft', 'submitted', 'approved', 'cancelled', 'superseded'].includes(i.status)) throw unprocessable('This invoice is not payable', undefined, 'not_issued');
      return { token: svc.qrToken(i), invoiceNumber: i.number };
    },

    listPurchaseOrders(ctx) {
      return db.all('SELECT po.*, o.name vendor FROM purchase_orders po JOIN organizations o ON o.id = po.vendor_org_id WHERE po.org_id = ? ORDER BY po.created_at DESC', ctx.orgId)
        .map(p => ({ id: p.id, number: p.number, vendor: p.vendor, amountMinor: p.amount_minor, currency: p.currency, status: p.status, createdAt: p.created_at }));
    },
    listPurchaseRequests(ctx) {
      ctx.require('request.create');
      return db.all('SELECT * FROM purchase_requests WHERE org_id = ? ORDER BY created_at DESC', ctx.orgId).map(p => ({ id: p.id, number: p.number, description: p.description, estimatedMinor: p.estimated_minor, costCenter: p.cost_center, status: p.status, createdAt: p.created_at }));
    },
    vendorStaffIds,
  };

  /* --------------------------- view helpers --------------------------- */
  function quoteSummary(q, ctx) {
    const vendorSide = q.vendor_org_id === ctx.orgId;
    const expired = q.status === 'approved' && q.valid_until && q.valid_until < core.today();
    return {
      id: q.id, number: q.number, version: q.version, status: expired ? 'expired' : q.status, currency: q.currency, subtotalMinor: q.subtotal_minor, discountMinor: q.discount_minor, taxMinor: q.tax_minor, whtMinor: q.wht_minor,
      totalMinor: q.total_minor, validUntil: q.valid_until, vendor: orgName(q.vendor_org_id), customer: orgName(q.customer_org_id), requestId: q.request_id, createdVia: q.created_via, isDraftAI: q.created_via === 'agent' && q.status !== 'approved' && q.status !== 'accepted',
      preparedBy: vendorSide ? userName(q.prepared_by) : null, approvedBy: vendorSide ? userName(q.approved_by) : null, approvedAt: q.approved_at, createdAt: q.created_at, side: vendorSide ? 'vendor' : 'customer', isDemo: !!q.is_demo,
    };
  }
  function invoiceSummary(i, ctx) {
    const vendorSide = i.vendor_org_id === ctx.orgId;
    const overdue = i.status === 'issued' && i.due_date && i.due_date < core.today();
    return {
      id: i.id, number: i.number, version: i.version, status: i.status, displayStatus: overdue ? 'overdue' : i.status, currency: i.currency, subtotalMinor: i.subtotal_minor, taxMinor: i.tax_minor, whtMinor: i.wht_minor, totalMinor: i.total_minor,
      dueDate: i.due_date, issuedAt: i.issued_at, paidAt: i.paid_at, vendor: orgName(i.vendor_org_id), customer: orgName(i.customer_org_id), quoteId: i.quote_id, requestId: i.request_id, billId: i.bill_id,
      createdVia: i.created_via, isDraftAI: i.created_via === 'agent' && !['approved', 'issued', 'paid'].includes(i.status), preparedBy: vendorSide ? userName(i.prepared_by) : null, approvedBy: vendorSide ? userName(i.approved_by) : null,
      approvedAt: i.approved_at, disputeReason: i.dispute_reason, createdAt: i.created_at, side: vendorSide ? 'vendor' : 'customer', isDemo: !!i.is_demo,
    };
  }
  function normaliseItems(lines) {
    return (lines || []).map(l => ({
      productId: l.productId || null, sku: l.sku || '', description: l.description || '',
      qtyMilli: l.qtyMilli != null ? Number(l.qtyMilli) : l.qty != null ? toQtyMilli(l.qty) : 0,
      manualUnitPriceMinor: l.unitPriceMinor != null ? Number(l.unitPriceMinor) : l.unitPrice != null && l.unitPrice !== '' ? toMinor(l.unitPrice) : null,
      taxBp: l.taxBp != null ? Number(l.taxBp) : 0,
    }));
  }
  function blockers(doc, type) {
    const ls = linesOf(type, doc.id);
    const missing = ls.filter(l => l.price_source === 'price_required' || l.unit_price_minor <= 0);
    if (missing.length) throw unprocessable('Some lines have no price. Enter a price or remove them before submitting.', missing.map(l => ({ level: 'error', msg: `"${l.description}" has no price` })), 'price_required');
    if (doc.total_minor <= 0) throw unprocessable('Document total must be greater than zero');
    if (flagsOf(doc).some(f => f.level === 'error' && f.code === 'currency_conflict')) throw unprocessable('Currency conflict between lines and document');
  }
  function selfApprovalGuard(ctx, doc, type) {
    const vp = db.get('SELECT allow_self_approval FROM vendor_profiles WHERE org_id = ?', ctx.orgId);
    const preparer = doc.prepared_by;
    if (!vp.allow_self_approval && (preparer === ctx.userId || doc.created_by === ctx.userId))
      throw forbidden(`You prepared this ${type}; a different authorised vendor user must approve it`, 'self_approval');
  }

  return svc;
};
