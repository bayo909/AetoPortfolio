// Vendor SaaS subscriptions: plans, entitlements, usage limits, billing and failed-payment handling.
// Completely separate from wallet balances and customer payment funds: subscription charges go through their own sandbox adapter.
const { uid, iso } = require('./db');
const { bad, forbidden, notFound, conflict, HttpError } = require('./errors');

const PLANS = [
  { key: 'trial', name: 'Free trial', monthly: 0, annual: 0, ent: { quotes: 10, invoices: 5, qr_payments: false, ai_agent: true, staff: 2 } },
  { key: 'starter', name: 'Starter', monthly: 15_000_00, annual: 150_000_00, ent: { quotes: 50, invoices: 30, qr_payments: false, ai_agent: true, staff: 3 } },
  { key: 'growth', name: 'Growth', monthly: 45_000_00, annual: 450_000_00, ent: { quotes: 500, invoices: 300, qr_payments: true, ai_agent: true, staff: 15 } },
  { key: 'enterprise', name: 'Enterprise', monthly: 150_000_00, annual: 1_500_000_00, ent: { quotes: -1, invoices: -1, qr_payments: true, ai_agent: true, staff: -1 } },
];
const TRIAL_DAYS = 30;
const addDays = (d, n) => new Date(d.getTime() + n * 86400e3);

module.exports = function subscriptionService(core) {
  const { db, now, audit } = core;
  for (const p of PLANS) db.run('INSERT OR IGNORE INTO subscription_plans(key, name, monthly_minor, annual_minor, currency, entitlements_json, active) VALUES (?,?,?,?,?,?,1)', p.key, p.name, p.monthly, p.annual, 'NGN', JSON.stringify(p.ent));

  const plan = key => { const p = db.get('SELECT * FROM subscription_plans WHERE key = ?', key); return p && { ...p, ent: JSON.parse(p.entitlements_json) }; };
  const sub = orgId => db.get('SELECT * FROM subscriptions WHERE org_id = ?', orgId);

  /** trialing / active / past_due / cancelled / trial_expired, evaluated against the clock. */
  function effective(s) {
    if (!s) return 'none';
    const t = iso(now());
    if (s.status === 'trialing' && s.trial_ends_at < t) return 'trial_expired';
    if (s.status === 'cancelled' && s.current_period_end && s.current_period_end > t) return 'cancelling';
    return s.status;
  }
  const usage = orgId => {
    const m = iso(now()).slice(0, 7);
    return {
      quotes: db.get("SELECT COUNT(*) n FROM quotations WHERE vendor_org_id = ? AND version = 1 AND substr(created_at,1,7) = ?", orgId, m).n,
      invoices: db.get("SELECT COUNT(*) n FROM invoices WHERE vendor_org_id = ? AND issued_at IS NOT NULL AND substr(issued_at,1,7) = ?", orgId, m).n,
      staff: db.get("SELECT COUNT(*) n FROM organization_members WHERE org_id = ? AND status = 'active'", orgId).n,
    };
  };
  function isEntitled(orgId, feature) {
    const s = sub(orgId);
    const st = effective(s);
    if (!['trialing', 'active', 'cancelling'].includes(st)) return false;
    const e = plan(s.plan_key).ent;
    if (typeof e[feature] === 'boolean') return e[feature];
    if (e[feature] == null) return false;
    return e[feature] === -1 || usage(orgId)[feature] < e[feature];
  }
  function assertEntitled(orgId, feature) {
    if (isEntitled(orgId, feature)) return;
    const s = sub(orgId), st = effective(s);
    const why = ['past_due'].includes(st) ? 'Your subscription payment failed — update your payment method.' : ['trial_expired', 'cancelled', 'none'].includes(st) ? 'Your subscription is not active.' : `Your ${plan(s.plan_key).name} plan does not include this or its monthly limit is reached.`;
    throw new HttpError(402, `${why} (feature: ${feature})`, undefined, 'entitlement_required');
  }

  function charge(orgId, invoice) {
    const o = db.get('SELECT settings_json FROM organizations WHERE id = ?', orgId);
    const mode = JSON.parse(o.settings_json).subscriptionCard || 'ok';
    return mode === 'decline' ? { ok: false, reason: 'Card declined (sandbox)' } : { ok: true };
  }
  function issueInvoice(s, p, periodStart) {
    const months = s.billing_period === 'annual' ? 12 : 1;
    const amount = s.billing_period === 'annual' ? p.annual_minor : p.monthly_minor;
    const end = new Date(periodStart); end.setUTCMonth(end.getUTCMonth() + months);
    const n = db.get('SELECT COUNT(*) n FROM subscription_invoices').n + 1;
    const inv = { id: uid(), org_id: s.org_id, subscription_id: s.id, number: `SUB-${now().getUTCFullYear()}-${String(n).padStart(5, '0')}`, plan_key: p.key, period_start: iso(periodStart).slice(0, 10), period_end: iso(end).slice(0, 10), amount_minor: amount, currency: p.currency, status: 'open', attempts: 0, failure_reason: null, created_at: iso(now()) };
    db.insert('subscription_invoices', inv);
    return { inv, end };
  }
  function settle(s, inv, end) {
    const r = charge(s.org_id, inv);
    db.run('UPDATE subscription_invoices SET attempts = attempts + 1 WHERE id = ?', inv.id);
    if (r.ok) {
      db.run("UPDATE subscription_invoices SET status = 'paid', failure_reason = NULL WHERE id = ?", inv.id);
      db.run("UPDATE subscriptions SET status = 'active', current_period_end = ?, trial_ends_at = NULL WHERE id = ?", iso(end), s.id);
    } else {
      db.run("UPDATE subscription_invoices SET status = 'failed', failure_reason = ? WHERE id = ?", r.reason, inv.id);
      db.run("UPDATE subscriptions SET status = 'past_due' WHERE id = ?", s.id);
    }
    return r;
  }

  const view = orgId => {
    const s = sub(orgId);
    const p = plan(s.plan_key);
    return { planKey: s.plan_key, planName: p.name, billingPeriod: s.billing_period, status: effective(s), rawStatus: s.status, trialEndsAt: s.trial_ends_at, currentPeriodEnd: s.current_period_end, cancelAtPeriodEnd: !!s.cancel_at_period_end,
      pendingPlanKey: s.pending_plan_key, entitlements: p.ent, usage: usage(orgId),
      invoices: db.all('SELECT id, number, plan_key, period_start, period_end, amount_minor, currency, status, attempts, failure_reason FROM subscription_invoices WHERE org_id = ? ORDER BY created_at DESC', orgId) };
  };

  const svc = {
    PLANS, isEntitled, assertEntitled, effective, usage,
    startTrial(orgId) {
      if (sub(orgId)) return;
      db.insert('subscriptions', { id: uid(), org_id: orgId, plan_key: 'trial', billing_period: 'monthly', status: 'trialing', trial_ends_at: iso(addDays(now(), TRIAL_DAYS)), current_period_end: null, cancel_at_period_end: 0, created_at: iso(now()) });
    },
    plans() { return db.all('SELECT key, name, monthly_minor, annual_minor, currency, entitlements_json, active FROM subscription_plans ORDER BY monthly_minor').map(p => ({ key: p.key, name: p.name, monthlyMinor: p.monthly_minor, annualMinor: p.annual_minor, currency: p.currency, entitlements: JSON.parse(p.entitlements_json), active: !!p.active })); },
    get(ctx) { if (!ctx.org.is_vendor) throw forbidden(); ctx.require('subscription.manage'); return view(ctx.orgId); },
    /** Subscribe / upgrade (immediate, charged now) or downgrade (applies at period end, blocked if current usage would exceed the new plan). */
    change(ctx, { planKey, billingPeriod = 'monthly' }) {
      ctx.require('subscription.manage');
      const p = plan(planKey);
      if (!p || !p.active || planKey === 'trial') throw bad('Choose an available paid plan');
      if (!['monthly', 'annual'].includes(billingPeriod)) throw bad('Billing period must be monthly or annual');
      const s = sub(ctx.orgId);
      const cur = plan(s.plan_key);
      const live = ['active', 'past_due'].includes(s.status);
      const down = live && p.monthly_minor < cur.monthly_minor;
      if (down) {
        const u = usage(ctx.orgId);
        for (const [f, lim] of Object.entries(p.ent)) if (typeof lim === 'number' && lim !== -1 && u[f] != null && u[f] > lim) throw conflict(`Cannot downgrade: current ${f} usage (${u[f]}) exceeds the ${p.name} limit (${lim})`);
        db.tx(() => { db.run('UPDATE subscriptions SET pending_plan_key = ?, cancel_at_period_end = 0 WHERE id = ?', planKey, s.id); audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'subscription.downgrade_scheduled', objectType: 'subscription', objectId: s.id, next: { planKey } }); });
        return view(ctx.orgId);
      }
      let result;
      db.tx(() => {
        db.run('UPDATE subscriptions SET plan_key = ?, billing_period = ?, pending_plan_key = NULL, cancel_at_period_end = 0 WHERE id = ?', planKey, billingPeriod, s.id);
        const s2 = sub(ctx.orgId);
        const { inv, end } = issueInvoice(s2, p, now());
        result = settle(s2, inv, end);
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: result.ok ? 'subscription.changed' : 'subscription.payment_failed', objectType: 'subscription', objectId: s.id, prior: { planKey: s.plan_key }, next: { planKey, billingPeriod }, reason: result.ok ? '' : result.reason });
      });
      return { ...view(ctx.orgId), chargeOk: result.ok, chargeError: result.ok ? null : result.reason };
    },
    cancel(ctx) {
      ctx.require('subscription.manage');
      const s = sub(ctx.orgId);
      db.tx(() => { db.run('UPDATE subscriptions SET cancel_at_period_end = 1, pending_plan_key = NULL WHERE id = ?', s.id); audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'subscription.cancel_scheduled', objectType: 'subscription', objectId: s.id }); });
      return view(ctx.orgId);
    },
    setPaymentMethod(ctx, mode) {
      ctx.require('subscription.manage');
      if (!['ok', 'decline'].includes(mode)) throw bad('Sandbox payment method must be ok or decline');
      const o = JSON.parse(ctx.org.settings_json || '{}'); o.subscriptionCard = mode;
      db.run('UPDATE organizations SET settings_json = ? WHERE id = ?', JSON.stringify(o), ctx.orgId);
      ctx.org.settings_json = JSON.stringify(o);
      return { subscriptionCard: mode };
    },
    /** Retry the latest failed subscription invoice (e.g. after the payment method was fixed). */
    retryPayment(ctx) {
      ctx.require('subscription.manage');
      const s = sub(ctx.orgId);
      const inv = db.get("SELECT * FROM subscription_invoices WHERE subscription_id = ? AND status = 'failed' ORDER BY created_at DESC LIMIT 1", s.id);
      if (!inv) throw conflict('There is no failed subscription payment to retry');
      const p = plan(inv.plan_key);
      const end = new Date(inv.period_end + 'T00:00:00Z');
      const r = db.tx(() => settle(s, inv, end));
      audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: r.ok ? 'subscription.payment_recovered' : 'subscription.payment_failed', objectType: 'subscription', objectId: s.id, reason: r.ok ? '' : r.reason });
      return { ...view(ctx.orgId), chargeOk: r.ok, chargeError: r.ok ? null : r.reason };
    },
    /** Renewal job (platform scheduler / admin button): applies scheduled downgrades & cancellations and bills due subscriptions. */
    processRenewals() {
      const out = [];
      for (const s of db.all("SELECT * FROM subscriptions WHERE status IN ('active','past_due') AND current_period_end IS NOT NULL AND current_period_end <= ?", iso(now()))) {
        db.tx(() => {
          if (s.cancel_at_period_end) { db.run("UPDATE subscriptions SET status = 'cancelled' WHERE id = ?", s.id); out.push({ org: s.org_id, result: 'cancelled' }); return; }
          const key = s.pending_plan_key || s.plan_key;
          db.run('UPDATE subscriptions SET plan_key = ?, pending_plan_key = NULL WHERE id = ?', key, s.id);
          const s2 = db.get('SELECT * FROM subscriptions WHERE id = ?', s.id);
          const { inv, end } = issueInvoice(s2, plan(key), new Date(s.current_period_end));
          const r = settle(s2, inv, end);
          out.push({ org: s.org_id, result: r.ok ? 'renewed' : 'payment_failed' });
          audit.record(s.org_id, { action: r.ok ? 'subscription.renewed' : 'subscription.payment_failed', objectType: 'subscription', objectId: s.id, reason: r.ok ? '' : r.reason });
        });
      }
      return out;
    },
    savePlan(ctx, b) {
      ctx.require('platform.manage');
      const p = plan(b.key);
      if (!p) throw notFound('Plan');
      const ent = { ...p.ent, ...(b.entitlements || {}) };
      db.tx(() => {
        db.run('UPDATE subscription_plans SET name = ?, monthly_minor = ?, annual_minor = ?, entitlements_json = ?, active = ? WHERE key = ?', b.name ?? p.name, Number(b.monthlyMinor ?? p.monthly_minor), Number(b.annualMinor ?? p.annual_minor), JSON.stringify(ent), b.active === false ? 0 : 1, b.key);
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'plan.updated', objectType: 'subscription_plan', objectId: b.key, prior: p.ent, next: ent });
      });
      return svc.plans();
    },
    listAll(ctx) {
      ctx.require('platform.manage');
      return db.all('SELECT s.*, o.name org FROM subscriptions s JOIN organizations o ON o.id = s.org_id ORDER BY o.name').map(s => ({ org: s.org, orgId: s.org_id, plan: s.plan_key, status: effective(s), periodEnd: s.current_period_end }));
    },
  };
  return svc;
};
