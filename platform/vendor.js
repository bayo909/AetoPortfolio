// Vendor workspace: profile, storefront, catalog, pricing rules, vendor<->customer relationships, marketplace.
const { uid, iso } = require('./db');
const { bad, forbidden, notFound, conflict } = require('./errors');
const { toMinor } = require('./money');
const { mask } = require('./security');

const slugify = s => String(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'vendor';

module.exports = function vendorService(core) {
  const { db, now, audit, cipher } = core;

  function requireVendor(ctx) { if (!ctx.org.is_vendor) throw forbidden('This is not a vendor organisation'); }

  function setupVendor(orgId, { legalName }) {
    const org = db.get('SELECT * FROM organizations WHERE id = ?', orgId);
    if (!db.get('SELECT 1 x FROM vendor_profiles WHERE org_id = ?', orgId))
      db.insert('vendor_profiles', { org_id: orgId, legal_name: legalName, settlement_currency: org.currency, kyb_status: 'not_started' });
    if (!db.get('SELECT 1 x FROM storefronts WHERE org_id = ?', orgId)) {
      let slug = slugify(legalName), n = 1;
      while (db.get('SELECT 1 x FROM storefronts WHERE slug = ?', slug)) slug = `${slugify(legalName)}-${++n}`;
      db.insert('storefronts', { org_id: orgId, slug, headline: '', about: '', published: 0 });
    }
    if (core.svc.subscriptions) core.svc.subscriptions.startTrial(orgId);
    if (core.svc.compliance) core.svc.compliance.openCase(orgId);
  }

  function vendorKybVerified(vendorOrgId) {
    const p = db.get('SELECT kyb_status FROM vendor_profiles WHERE org_id = ?', vendorOrgId);
    return !!p && p.kyb_status === 'verified';
  }

  /** Creates (or reactivates) the customer<->vendor relationship created by an accepted invitation. */
  function linkVendor(customerOrgId, vendorOrgId, invitationId) {
    const status = vendorKybVerified(vendorOrgId) ? 'active' : 'pending_kyb';
    let rel = db.get('SELECT * FROM vendor_relationships WHERE customer_org_id = ? AND vendor_org_id = ?', customerOrgId, vendorOrgId);
    if (rel) db.run('UPDATE vendor_relationships SET status = ?, invitation_id = ? WHERE id = ?', status, invitationId, rel.id);
    else { rel = { id: uid(), customer_org_id: customerOrgId, vendor_org_id: vendorOrgId, status, invitation_id: invitationId, created_at: iso(now()) }; db.insert('vendor_relationships', rel); }
    if (status === 'active' && core.svc.chat) core.svc.chat.ensureVendorChannel(customerOrgId, vendorOrgId);
    return db.get('SELECT * FROM vendor_relationships WHERE customer_org_id = ? AND vendor_org_id = ?', customerOrgId, vendorOrgId);
  }
  function activatePendingRelationships(vendorOrgId) {
    for (const r of db.all("SELECT * FROM vendor_relationships WHERE vendor_org_id = ? AND status = 'pending_kyb'", vendorOrgId)) {
      db.run("UPDATE vendor_relationships SET status = 'active' WHERE id = ?", r.id);
      if (core.svc.chat) core.svc.chat.ensureVendorChannel(r.customer_org_id, vendorOrgId);
      audit.record([r.customer_org_id, vendorOrgId], { action: 'relationship.activated', objectType: 'vendor_relationship', objectId: r.id, reason: 'Vendor KYB verified' });
    }
  }
  const activeRelationship = (customerOrgId, vendorOrgId) =>
    db.get("SELECT * FROM vendor_relationships WHERE customer_org_id = ? AND vendor_org_id = ? AND status = 'active'", customerOrgId, vendorOrgId);

  const productView = p => ({
    id: p.id, kind: p.kind, sku: p.sku, name: p.name, category: p.category, description: p.description, imageUrl: p.image_url, unit: p.unit,
    unitPriceMinor: p.unit_price_minor, currency: p.currency, taxBp: p.tax_bp, whtBp: p.wht_bp, inventory: p.inventory, available: !!p.available,
  });

  /** Effective unit price for a customer: best applicable rule (customer-specific wins ties); the catalog price is never invented. */
  function resolvePrice(product, customerOrgId, qtyMilli) {
    const today = core.today();
    const rules = db.all(
      `SELECT * FROM pricing_rules WHERE product_id = ? AND (customer_org_id IS NULL OR customer_org_id = ?) AND min_qty_milli <= ? AND (valid_until IS NULL OR valid_until >= ?)`,
      product.id, customerOrgId, qtyMilli, today);
    rules.sort((a, b) => b.discount_bp - a.discount_bp || (b.customer_org_id ? 1 : 0) - (a.customer_org_id ? 1 : 0));
    const r = rules[0];
    return { unit_price_minor: product.unit_price_minor, discount_bp: r ? r.discount_bp : 0, price_source: r && r.customer_org_id ? 'customer_rule' : 'catalog', rule_id: r ? r.id : null, rule_note: r ? r.note : '' };
  }

  const svc = {
    setupVendor, linkVendor, activatePendingRelationships, activeRelationship, vendorKybVerified, resolvePrice, productView,

    /* ------------------------------ profile ------------------------------ */
    getProfile(ctx) {
      requireVendor(ctx);
      const p = db.get('SELECT * FROM vendor_profiles WHERE org_id = ?', ctx.orgId);
      const s = db.get('SELECT * FROM storefronts WHERE org_id = ?', ctx.orgId);
      return {
        legalName: p.legal_name, description: p.description, registrationNo: p.registration_no, taxIdMasked: mask(cipher.decrypt(p.tax_id_enc)),
        settlementCurrency: p.settlement_currency, bankName: p.bank_name, accountNumberMasked: mask(cipher.decrypt(p.account_number_enc)), accountName: p.account_name,
        paymentTermsDays: p.payment_terms_days, kybStatus: p.kyb_status, allowSelfApproval: !!p.allow_self_approval, bankChangedAt: p.bank_changed_at,
        storefront: { slug: s.slug, headline: s.headline, about: s.about, published: !!s.published },
      };
    },
    updateProfile(ctx, b) {
      requireVendor(ctx); ctx.require('storefront.manage');
      const p = db.get('SELECT * FROM vendor_profiles WHERE org_id = ?', ctx.orgId);
      const next = {
        legal_name: b.legalName ?? p.legal_name, description: b.description ?? p.description, registration_no: b.registrationNo ?? p.registration_no,
        settlement_currency: b.settlementCurrency ?? p.settlement_currency, bank_name: b.bankName ?? p.bank_name, account_name: b.accountName ?? p.account_name,
        payment_terms_days: b.paymentTermsDays != null ? Number(b.paymentTermsDays) : p.payment_terms_days,
        tax_id_enc: b.taxId ? cipher.encrypt(b.taxId) : p.tax_id_enc,
        account_number_enc: b.accountNumber ? cipher.encrypt(b.accountNumber) : p.account_number_enc,
        allow_self_approval: b.allowSelfApproval != null ? (b.allowSelfApproval ? 1 : 0) : p.allow_self_approval,
      };
      if (!String(next.legal_name).trim()) throw bad('Legal name is required');
      if (!Number.isInteger(next.payment_terms_days) || next.payment_terms_days < 0 || next.payment_terms_days > 180) throw bad('Payment terms must be 0–180 days');
      const bankChanged = (b.accountNumber && b.accountNumber !== cipher.decrypt(p.account_number_enc)) || (b.bankName && b.bankName !== p.bank_name);
      db.tx(() => {
        db.run(`UPDATE vendor_profiles SET legal_name=?, description=?, registration_no=?, settlement_currency=?, bank_name=?, account_name=?, payment_terms_days=?, tax_id_enc=?, account_number_enc=?, allow_self_approval=?, bank_changed_at=? WHERE org_id=?`,
          next.legal_name, next.description, next.registration_no, next.settlement_currency, next.bank_name, next.account_name, next.payment_terms_days, next.tax_id_enc, next.account_number_enc, next.allow_self_approval,
          bankChanged ? iso(now()) : p.bank_changed_at, ctx.orgId);
        if (b.storefront) {
          const s = db.get('SELECT * FROM storefronts WHERE org_id = ?', ctx.orgId);
          db.run('UPDATE storefronts SET headline=?, about=?, published=? WHERE org_id=?', b.storefront.headline ?? s.headline, b.storefront.about ?? s.about,
            b.storefront.published != null ? (b.storefront.published ? 1 : 0) : s.published, ctx.orgId);
        }
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: bankChanged ? 'vendor.bank_details_changed' : 'vendor.profile_updated', objectType: 'vendor_profile', objectId: ctx.orgId,
          prior: { bank: p.bank_name, selfApproval: p.allow_self_approval }, next: { bank: next.bank_name, selfApproval: next.allow_self_approval }, reason: bankChanged ? 'Payment details changed; customers are warned on new bills' : '' });
      });
      return svc.getProfile(ctx);
    },

    /* ------------------------------ catalog ------------------------------ */
    listProducts(ctx) {
      requireVendor(ctx);
      if (!ctx.can('catalog.manage') && !ctx.can('request.respond')) throw forbidden();
      return db.all('SELECT * FROM products WHERE org_id = ? AND deleted_at IS NULL ORDER BY kind, name', ctx.orgId).map(productView);
    },
    saveProduct(ctx, id, b) {
      requireVendor(ctx); ctx.require('catalog.manage');
      const prior = id ? db.get('SELECT * FROM products WHERE id = ? AND org_id = ? AND deleted_at IS NULL', id, ctx.orgId) : null;
      if (id && !prior) throw notFound('Product');
      const sku = String(b.sku ?? (prior && prior.sku) ?? '').trim();
      if (!sku || !String(b.name ?? (prior && prior.name) ?? '').trim()) throw bad('SKU and name are required');
      const row = {
        kind: b.kind ?? (prior && prior.kind) ?? 'product', sku, name: String(b.name ?? prior.name).trim(), category: b.category ?? (prior && prior.category) ?? '',
        description: b.description ?? (prior && prior.description) ?? '', image_url: b.imageUrl ?? (prior && prior.image_url) ?? '', unit: b.unit ?? (prior && prior.unit) ?? 'unit',
        unit_price_minor: b.unitPrice != null ? toMinor(b.unitPrice) : b.unitPriceMinor != null ? Number(b.unitPriceMinor) : prior ? prior.unit_price_minor : null,
        currency: b.currency ?? (prior && prior.currency) ?? ctx.org.currency, tax_bp: b.taxBp != null ? Number(b.taxBp) : prior ? prior.tax_bp : 0,
        wht_bp: b.whtBp != null ? Number(b.whtBp) : prior ? prior.wht_bp : 0,
        inventory: b.inventory === undefined ? (prior ? prior.inventory : null) : b.inventory === null || b.inventory === '' ? null : Number(b.inventory),
        available: b.available != null ? (b.available ? 1 : 0) : prior ? prior.available : 1,
      };
      if (!['product', 'service'].includes(row.kind)) throw bad('Kind must be product or service');
      if (!Number.isInteger(row.unit_price_minor) || row.unit_price_minor < 0) throw bad('A valid unit price is required');
      try {
        db.tx(() => {
          if (prior) db.run(`UPDATE products SET kind=?, sku=?, name=?, category=?, description=?, image_url=?, unit=?, unit_price_minor=?, currency=?, tax_bp=?, wht_bp=?, inventory=?, available=? WHERE id=?`,
            row.kind, row.sku, row.name, row.category, row.description, row.image_url, row.unit, row.unit_price_minor, row.currency, row.tax_bp, row.wht_bp, row.inventory, row.available, id);
          else { id = uid(); db.insert('products', { id, org_id: ctx.orgId, ...row, created_at: iso(now()) }); }
          audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: prior ? 'product.updated' : 'product.created', objectType: 'product', objectId: id,
            prior: prior ? { price: prior.unit_price_minor, tax_bp: prior.tax_bp } : null, next: { sku: row.sku, price: row.unit_price_minor, tax_bp: row.tax_bp } });
        });
      } catch (e) { if (/UNIQUE/.test(e.message)) throw conflict(`SKU ${sku} already exists`); throw e; }
      return productView(db.get('SELECT * FROM products WHERE id = ?', id));
    },
    deleteProduct(ctx, id) {
      requireVendor(ctx); ctx.require('catalog.manage');
      const p = db.get('SELECT * FROM products WHERE id = ? AND org_id = ? AND deleted_at IS NULL', id, ctx.orgId);
      if (!p) throw notFound('Product');
      db.tx(() => { db.run('UPDATE products SET deleted_at = ?, available = 0 WHERE id = ?', iso(now()), id); audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'product.deleted', objectType: 'product', objectId: id }); });
    },
    listPricingRules(ctx) {
      requireVendor(ctx); if (!ctx.can('catalog.manage') && !ctx.can('request.respond')) throw forbidden();
      return db.all(`SELECT r.*, p.sku, p.name product_name, o.name customer_name FROM pricing_rules r JOIN products p ON p.id = r.product_id LEFT JOIN organizations o ON o.id = r.customer_org_id WHERE r.org_id = ?`, ctx.orgId)
        .map(r => ({ id: r.id, productId: r.product_id, sku: r.sku, productName: r.product_name, customerOrgId: r.customer_org_id, customerName: r.customer_name, minQtyMilli: r.min_qty_milli, discountBp: r.discount_bp, validUntil: r.valid_until, note: r.note }));
    },
    savePricingRule(ctx, b) {
      requireVendor(ctx); ctx.require('catalog.manage');
      const p = db.get('SELECT * FROM products WHERE id = ? AND org_id = ? AND deleted_at IS NULL', b.productId, ctx.orgId);
      if (!p) throw notFound('Product');
      if (b.customerOrgId && !activeRelationship(b.customerOrgId, ctx.orgId)) throw bad('Customer-specific pricing needs an active customer relationship');
      const id = uid();
      db.tx(() => {
        db.insert('pricing_rules', { id, org_id: ctx.orgId, product_id: p.id, customer_org_id: b.customerOrgId || null, min_qty_milli: Number(b.minQtyMilli || 1000), discount_bp: Number(b.discountBp || 0), valid_until: b.validUntil || null, note: b.note || '' });
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'pricing_rule.created', objectType: 'pricing_rule', objectId: id, next: b });
      });
      return { id };
    },

    /* --------------------- relationships & marketplace --------------------- */
    listCustomers(ctx) {
      requireVendor(ctx);
      return db.all(`SELECT r.id, r.status, r.created_at, o.id org_id, o.name, o.country FROM vendor_relationships r JOIN organizations o ON o.id = r.customer_org_id WHERE r.vendor_org_id = ? ORDER BY o.name`, ctx.orgId);
    },
    /** Vendors this organisation has an explicit relationship with. A customer never sees vendors it was not connected to. */
    listVendors(ctx) {
      ctx.require('marketplace.browse');
      return db.all(
        `SELECT r.id rel_id, r.status, o.id org_id, o.name, o.country, vp.kyb_status, vp.legal_name, s.slug, s.headline, s.published
         FROM vendor_relationships r JOIN organizations o ON o.id = r.vendor_org_id JOIN vendor_profiles vp ON vp.org_id = o.id JOIN storefronts s ON s.org_id = o.id
         WHERE r.customer_org_id = ? AND r.status <> 'revoked' ORDER BY o.name`, ctx.orgId)
        .map(v => ({ relId: v.rel_id, relationship: v.status, orgId: v.org_id, name: v.name, legalName: v.legal_name, country: v.country, kybStatus: v.kyb_status, slug: v.slug, headline: v.headline, published: !!v.published }));
    },
    storefront(ctx, vendorOrgId) {
      ctx.require('marketplace.browse');
      const rel = db.get('SELECT * FROM vendor_relationships WHERE customer_org_id = ? AND vendor_org_id = ?', ctx.orgId, vendorOrgId);
      if (!rel || rel.status === 'revoked') throw notFound('Storefront');
      if (rel.status !== 'active') throw forbidden('This vendor is not yet verified for your workspace', 'vendor_not_verified');
      const s = db.get('SELECT * FROM storefronts WHERE org_id = ? AND published = 1', vendorOrgId);
      if (!s) throw notFound('Storefront');
      const vp = db.get('SELECT * FROM vendor_profiles WHERE org_id = ?', vendorOrgId);
      const products = db.all('SELECT * FROM products WHERE org_id = ? AND deleted_at IS NULL AND available = 1 ORDER BY kind, name', vendorOrgId).map(p => {
        const price = resolvePrice(p, ctx.orgId, 1000);
        return { ...productView(p), effective: { discountBp: price.discount_bp, source: price.price_source, note: price.rule_note } };
      });
      return { vendor: { orgId: vendorOrgId, name: vp.legal_name, kybStatus: vp.kyb_status, headline: s.headline, about: s.about, paymentTermsDays: vp.payment_terms_days }, products };
    },
    revokeRelationship(ctx, relId) {
      ctx.require('vendor.invite');
      const r = db.get('SELECT * FROM vendor_relationships WHERE id = ? AND customer_org_id = ?', relId, ctx.orgId);
      if (!r) throw notFound('Relationship');
      db.tx(() => {
        db.run("UPDATE vendor_relationships SET status = 'revoked' WHERE id = ?", relId);
        if (core.svc.chat) core.svc.chat.syncOrgChannels(ctx.orgId);
        audit.record([r.customer_org_id, r.vendor_org_id], { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'relationship.revoked', objectType: 'vendor_relationship', objectId: relId });
      });
    },
  };
  return svc;
};
