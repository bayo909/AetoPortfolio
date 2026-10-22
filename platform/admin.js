// Cross-cutting read models: dashboards, audit trail & traceability, platform administration, integrations, access logs.
const { uid, iso } = require('./db');
const { bad, forbidden, notFound, conflict } = require('./errors');
const { ROLES } = require('./rbac');

module.exports = function adminService(core) {
  const { db, now, audit } = core;

  const svc = {
    /* ------------------------------ dashboards ------------------------------ */
    overview(ctx) {
      const o = { role: ctx.role, org: ctx.org.name };
      if (ctx.org.kind === 'platform') {
        o.tenants = db.get("SELECT COUNT(*) n FROM organizations WHERE kind='business'").n;
        o.vendors = db.get('SELECT COUNT(*) n FROM organizations WHERE is_vendor = 1').n;
        o.kybPending = db.get("SELECT COUNT(*) n FROM kyb_cases WHERE status IN ('submitted','in_review')").n;
        return o;
      }
      if (ctx.org.is_vendor && ctx.can('request.respond')) {
        o.vendor = {
          openRequests: db.get("SELECT COUNT(*) n FROM requests WHERE vendor_org_id = ? AND status IN ('open','quoted')", ctx.orgId).n,
          quotesPending: db.get("SELECT COUNT(*) n FROM quotations WHERE vendor_org_id = ? AND status = 'pending_approval'", ctx.orgId).n,
          invoicesPending: db.get("SELECT COUNT(*) n FROM invoices WHERE vendor_org_id = ? AND status = 'submitted'", ctx.orgId).n,
          outstandingMinor: db.get("SELECT COALESCE(SUM(total_minor),0) n FROM invoices WHERE vendor_org_id = ? AND status = 'issued'", ctx.orgId).n,
          paidMinor: db.get("SELECT COALESCE(SUM(total_minor),0) n FROM invoices WHERE vendor_org_id = ? AND status = 'paid'", ctx.orgId).n,
          overdue: db.get("SELECT COUNT(*) n FROM invoices WHERE vendor_org_id = ? AND status = 'issued' AND due_date < ?", ctx.orgId, core.today()).n,
          customers: db.get("SELECT COUNT(*) n FROM vendor_relationships WHERE vendor_org_id = ? AND status = 'active'", ctx.orgId).n,
          kybStatus: (db.get('SELECT kyb_status FROM vendor_profiles WHERE org_id = ?', ctx.orgId) || {}).kyb_status,
        };
      }
      if (ctx.org.is_customer) {
        const my = ctx.can('bill.validate') || ctx.can('bill.approve') || ctx.can('ledger.view') ? '' : ' AND requested_by = ?';
        const p = my ? [ctx.orgId, ctx.userId] : [ctx.orgId];
        const c = (where) => db.get(`SELECT COUNT(*) n, COALESCE(SUM(total_minor),0) s FROM bills WHERE org_id = ? ${where}${my}`, ...p);
        o.finance = {
          toValidate: c("AND status='received'").n, pendingApproval: c("AND status='pending_approval'").n, readyToPay: c("AND status='approved' AND payment_status='unpaid'"), paid: c("AND payment_status='paid'"),
          quarantined: c("AND status='quarantined'").n, disputed: c("AND status='disputed'").n, postingFailed: c("AND accounting_status='posting_failed'").n,
          opexMinor: c("AND classification='opex' AND status IN ('approved','pending_approval')").s, capexMinor: c("AND classification='capex' AND status IN ('approved','pending_approval')").s,
          myApprovals: ctx.can('bill.approve') ? core.svc.bills.pendingApprovals(ctx).filter(a => !a.blockedReason).length : 0,
          openRequests: db.get("SELECT COUNT(*) n FROM requests WHERE customer_org_id = ? AND status IN ('open','quoted','accepted')", ctx.orgId).n,
          docsInProgress: db.get("SELECT COUNT(*) n FROM source_documents WHERE org_id = ?", ctx.orgId).n,
        };
        if (ctx.can('wallet.view')) o.wallets = core.svc.payments.listWallets(ctx);
        if (ctx.can('budget.manage') || ctx.can('ledger.view')) o.budgets = svc.budgets(ctx);
      }
      return o;
    },

    /* ------------------------------- budgets ------------------------------- */
    budgets(ctx) {
      if (!ctx.can('budget.manage') && !ctx.can('ledger.view')) throw forbidden();
      return db.all('SELECT * FROM budgets WHERE org_id = ? ORDER BY cost_center, classification', ctx.orgId).map(b => ({ id: b.id, costCenter: b.cost_center, project: b.project, classification: b.classification, fiscalYear: b.fiscal_year, allocatedMinor: b.allocated_minor, committedMinor: b.committed_minor, spentMinor: b.spent_minor, remainingMinor: b.allocated_minor - b.committed_minor - b.spent_minor }));
    },
    saveBudget(ctx, b) {
      ctx.require('budget.manage');
      const alloc = Number(b.allocatedMinor);
      if (!Number.isSafeInteger(alloc) || alloc < 0) throw bad('Allocation must be a non-negative whole number of minor units');
      if (!db.get('SELECT 1 x FROM cost_centers WHERE org_id = ? AND code = ?', ctx.orgId, b.costCenter)) throw bad('Unknown cost centre');
      if (!['opex', 'capex'].includes(b.classification)) throw bad('Classification must be opex or capex');
      const year = Number(b.fiscalYear || now().getUTCFullYear());
      const prior = db.get('SELECT * FROM budgets WHERE org_id = ? AND cost_center = ? AND project = ? AND classification = ? AND fiscal_year = ?', ctx.orgId, b.costCenter, b.project || '', b.classification, year);
      db.tx(() => {
        if (prior) db.run('UPDATE budgets SET allocated_minor = ? WHERE id = ?', alloc, prior.id);
        else db.insert('budgets', { id: uid(), org_id: ctx.orgId, cost_center: b.costCenter, project: b.project || '', classification: b.classification, fiscal_year: year, allocated_minor: alloc });
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: prior ? 'budget.updated' : 'budget.created', objectType: 'budget', objectId: prior ? prior.id : `${b.costCenter}:${b.classification}`, prior: prior && { allocated: prior.allocated_minor }, next: { allocated: alloc } });
      });
      return svc.budgets(ctx);
    },
    costCenters(ctx) { return db.all('SELECT code, name, department FROM cost_centers WHERE org_id = ? ORDER BY code', ctx.orgId); },
    saveCostCenter(ctx, b) {
      ctx.require('budget.manage');
      if (!String(b.code || '').trim() || !String(b.name || '').trim()) throw bad('Code and name are required');
      db.tx(() => { db.run('INSERT INTO cost_centers(id, org_id, code, name, department) VALUES (?,?,?,?,?) ON CONFLICT(org_id, code) DO UPDATE SET name = excluded.name, department = excluded.department', uid(), ctx.orgId, b.code.trim(), b.name.trim(), b.department || ''); audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'cost_center.saved', objectType: 'cost_center', objectId: b.code }); });
      return svc.costCenters(ctx);
    },
    projects(ctx) { return db.all('SELECT code, name FROM projects WHERE org_id = ? ORDER BY code', ctx.orgId); },

    /* --------------------------- audit & traceability --------------------------- */
    auditTrail(ctx, { objectType, objectId, limit = 200 } = {}) {
      ctx.require('audit.view');
      const rows = objectId
        ? db.all('SELECT a.*, u.name actor FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id WHERE a.org_id = ? AND a.object_id = ? ORDER BY a.seq', ctx.orgId, objectId)
        : db.all('SELECT a.*, u.name actor FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id WHERE a.org_id = ? ORDER BY a.seq DESC LIMIT ?', ctx.orgId, Math.min(Number(limit) || 200, 1000));
      const shown = rows.filter(r => !objectType || r.object_type === objectType);
      return shown.map(r => ({ seq: r.seq, at: r.at, actor: r.actor || (r.actor_org_id && r.actor_org_id !== ctx.orgId ? (db.get('SELECT name FROM organizations WHERE id = ?', r.actor_org_id) || {}).name : 'System'), external: !!(r.actor_org_id && r.actor_org_id !== ctx.orgId), action: r.action, objectType: r.object_type, objectId: r.object_id,
        prior: r.prior_json && JSON.parse(r.prior_json), next: r.new_json && JSON.parse(r.new_json), reason: r.reason, refs: JSON.parse(r.refs_json), hash: r.hash.slice(0, 16), prevHash: r.prev_hash.slice(0, 16) }));
    },
    verifyAudit(ctx) { ctx.require('audit.view'); return core.audit.verify(ctx.orgId); },
    /** End-to-end lineage for a bill: source document -> generated document -> approvals -> payment -> journals. */
    trace(ctx, billId) {
      ctx.require('audit.view');
      const b = db.get('SELECT * FROM bills WHERE id = ? AND org_id = ?', billId, ctx.orgId);
      if (!b) throw notFound('Bill');
      const sd = b.source_document_id && db.get('SELECT id, filename, sha256, uploaded_by, created_at FROM source_documents WHERE id = ?', b.source_document_id);
      const inv = b.invoice_id && db.get('SELECT id, number, version, quote_id, approved_by, approved_at, issued_at FROM invoices WHERE id = ?', b.invoice_id);
      const quote = inv && inv.quote_id && db.get('SELECT id, number, version, approved_by, approved_at, accepted_by, accepted_at FROM quotations WHERE id = ?', inv.quote_id);
      const name = id => id ? (db.get('SELECT name FROM users WHERE id = ?', id) || {}).name : null;
      const intents = db.all('SELECT i.id, i.status, i.initiated_by, i.authorized_by, t.receipt_no, t.provider_ref FROM payment_intents i LEFT JOIN payment_transactions t ON t.intent_id = i.id WHERE i.bill_id = ?', billId);
      return {
        bill: { id: b.id, number: b.number, source: b.source, status: b.status },
        sourceDocument: sd && { ...sd, uploadedBy: name(sd.uploaded_by) },
        generatedDocument: b.docflow_doc_id ? { id: b.docflow_doc_id, versions: db.all('SELECT version, stage, content_sha256, created_at FROM document_versions WHERE org_id = ? AND docflow_doc_id = ? ORDER BY version', ctx.orgId, b.docflow_doc_id) } : null,
        quotation: quote && { ...quote, approvedBy: name(quote.approved_by), acceptedBy: name(quote.accepted_by) }, invoice: inv && { ...inv, approvedBy: name(inv.approved_by) },
        approvals: db.all("SELECT d.decision, d.comment, d.at, u.name actor FROM approval_decisions d JOIN users u ON u.id = d.actor_id WHERE d.subject_type = 'bill' AND d.subject_id = ? ORDER BY d.at", billId),
        payments: intents.map(i => ({ intentId: i.id, status: i.status, initiatedBy: name(i.initiated_by), authorizedBy: name(i.authorized_by), receiptNo: i.receipt_no, providerRef: i.provider_ref })),
        journals: core.svc.ledger.journal(ctx, { billId }),
        events: db.all(`SELECT a.*, u.name actor FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id WHERE a.org_id = ? AND (a.object_id = ? OR a.refs_json LIKE ? OR a.object_id IN (SELECT id FROM payment_intents WHERE bill_id = ?) OR a.object_id IN (SELECT id FROM payment_transactions WHERE bill_id = ?) OR a.object_id IN (SELECT id FROM journal_entries WHERE bill_id = ?)) ORDER BY a.seq`,
          ctx.orgId, billId, `%"${billId}"%`, billId, billId, billId).map(r => ({ seq: r.seq, at: r.at, actor: r.actor || 'System', action: r.action, objectType: r.object_type, objectId: r.object_id, reason: r.reason })),
      };
    },
    accessLog(ctx) { ctx.require('audit.view'); return db.all("SELECT method, path, status, at, user_id FROM access_logs WHERE org_id = ? AND sensitive = 1 ORDER BY at DESC LIMIT 100", ctx.orgId); },

    /* --------------------------- platform administration --------------------------- */
    tenants(ctx) {
      ctx.require('platform.manage');
      return db.all("SELECT * FROM organizations WHERE kind = 'business' ORDER BY name").map(o => ({ id: o.id, name: o.name, country: o.country, currency: o.currency, isCustomer: !!o.is_customer, isVendor: !!o.is_vendor, status: o.status, isDemo: !!o.is_demo,
        members: db.get("SELECT COUNT(*) n FROM organization_members WHERE org_id = ? AND status='active'", o.id).n, createdAt: o.created_at, kyb: o.is_vendor ? (db.get('SELECT kyb_status FROM vendor_profiles WHERE org_id = ?', o.id) || {}).kyb_status : null }));
    },
    setTenantStatus(ctx, orgId, status, reason) {
      ctx.require('platform.manage');
      if (!['active', 'suspended'].includes(status)) throw bad('Status must be active or suspended');
      const o = db.get("SELECT * FROM organizations WHERE id = ? AND kind = 'business'", orgId);
      if (!o) throw notFound('Tenant');
      if (!String(reason || '').trim()) throw bad('A reason is required');
      db.tx(() => { db.run('UPDATE organizations SET status = ? WHERE id = ?', status, orgId); audit.record([ctx.orgId, orgId], { actorId: ctx.userId, actorOrgId: ctx.orgId, action: `tenant.${status}`, objectType: 'organization', objectId: orgId, prior: { status: o.status }, next: { status }, reason }); });
    },
    health(ctx) {
      ctx.require('platform.manage');
      const chains = db.all("SELECT id, name FROM organizations WHERE kind='business'").map(o => ({ org: o.name, ...core.audit.verify(o.id) }));
      return {
        status: chains.every(c => c.ok) ? 'ok' : 'degraded', time: iso(now()), database: 'sqlite (node:sqlite)', paymentProvider: 'sandbox (simulated)', ai: core.svc.agent.providerName, auditChains: chains,
        counts: { organisations: db.get('SELECT COUNT(*) n FROM organizations').n, users: db.get('SELECT COUNT(*) n FROM users').n, bills: db.get('SELECT COUNT(*) n FROM bills').n, journalEntries: db.get('SELECT COUNT(*) n FROM journal_entries').n,
          providerEvents: db.get('SELECT COUNT(*) n FROM payment_provider_events').n, invalidProviderEvents: db.get('SELECT COUNT(*) n FROM payment_provider_events WHERE signature_valid = 0').n },
        postingFailures: db.get("SELECT COUNT(*) n FROM bills WHERE accounting_status = 'posting_failed'").n,
      };
    },
    roles() { return Object.entries(ROLES).map(([k, r]) => ({ key: k, label: r.label, scope: r.scope, permissions: r.perms })); },

    /* ------------------------------- integrations ------------------------------- */
    integrations(ctx) { ctx.require('integrations.manage'); return db.all('SELECT * FROM integration_connections WHERE org_id = ? ORDER BY created_at', ctx.orgId).map(i => ({ id: i.id, kind: i.kind, name: i.name, config: JSON.parse(i.config_json), status: i.status, lastSyncAt: i.last_sync_at })); },
    saveIntegration(ctx, b) {
      ctx.require('integrations.manage');
      if (!['erp_export', 'sap', 'dynamics', 'netsuite', 'quickbooks', 'generic_webhook'].includes(b.kind)) throw bad('Unsupported connector kind');
      if (!String(b.name || '').trim()) throw bad('Name is required');
      const secretKeys = Object.keys(b.config || {}).filter(k => /secret|token|password|key/i.test(k));
      if (secretKeys.length) throw bad('Do not store credentials here: set them as environment secrets on the server (see README)');
      const id = uid();
      db.tx(() => { db.insert('integration_connections', { id, org_id: ctx.orgId, kind: b.kind, name: b.name.trim(), config_json: JSON.stringify(b.config || {}), status: 'sandbox', created_at: iso(now()) }); audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'integration.created', objectType: 'integration', objectId: id, next: { kind: b.kind } }); });
      return svc.integrations(ctx);
    },
    /** Sandbox connector run: produces the versioned journal export that a real connector would push. */
    syncIntegration(ctx, id) {
      ctx.require('integrations.manage');
      const c = db.get('SELECT * FROM integration_connections WHERE id = ? AND org_id = ?', id, ctx.orgId);
      if (!c) throw notFound('Integration');
      const payload = core.svc.ledger.export(ctx);
      db.tx(() => { db.run('UPDATE integration_connections SET last_sync_at = ? WHERE id = ?', iso(now()), id); audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'integration.synced', objectType: 'integration', objectId: id, next: { entries: payload.entries.length, schemaVersion: payload.version } }); });
      return { simulated: true, delivered: payload.entries.length, schema: payload.schema, version: payload.version };
    },

    /* --------------------------------- reports --------------------------------- */
    reports(ctx) {
      if (!ctx.can('reports.view')) throw forbidden();
      const rep = {};
      if (ctx.org.is_customer && ctx.can('ledger.view')) {
        rep.spendByCostCenter = db.all("SELECT cost_center, classification, COUNT(*) bills, COALESCE(SUM(total_minor),0) total FROM bills WHERE org_id = ? AND status = 'approved' GROUP BY cost_center, classification ORDER BY total DESC", ctx.orgId);
        rep.spendByVendor = db.all("SELECT party_name, COUNT(*) bills, COALESCE(SUM(total_minor),0) total, COALESCE(SUM(CASE WHEN payment_status='paid' THEN total_minor END),0) paid FROM bills WHERE org_id = ? AND status = 'approved' GROUP BY party_name ORDER BY total DESC", ctx.orgId);
        rep.aging = db.all("SELECT CASE WHEN due_date IS NULL THEN 'No due date' WHEN due_date >= ? THEN 'Not yet due' WHEN due_date >= date(?, '-30 day') THEN '1–30 days' ELSE '30+ days' END bucket, COUNT(*) bills, COALESCE(SUM(payable_minor),0) total FROM bills WHERE org_id = ? AND status = 'approved' AND payment_status <> 'paid' GROUP BY bucket", core.today(), core.today(), ctx.orgId);
      }
      if (ctx.org.is_vendor) {
        rep.settlements = db.all("SELECT i.number, o.name customer, i.total_minor, i.wht_minor, i.paid_at FROM invoices i JOIN organizations o ON o.id = i.customer_org_id WHERE i.vendor_org_id = ? AND i.status = 'paid' ORDER BY i.paid_at DESC", ctx.orgId);
        rep.receivables = db.all("SELECT i.number, o.name customer, i.total_minor, i.due_date, i.status FROM invoices i JOIN organizations o ON o.id = i.customer_org_id WHERE i.vendor_org_id = ? AND i.status IN ('issued','disputed') ORDER BY i.due_date", ctx.orgId);
        rep.pipeline = db.all("SELECT status, COUNT(*) n, COALESCE(SUM(total_minor),0) total FROM quotations WHERE vendor_org_id = ? AND version >= 1 GROUP BY status", ctx.orgId);
      }
      return rep;
    },
  };
  return svc;
};
