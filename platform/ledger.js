// Double-entry accounting engine: chart of accounts, atomic idempotent posting, period locks, reversals, reports.
const { uid, iso } = require('./db');
const { HttpError, bad, forbidden, notFound, unprocessable } = require('./errors');

const DEFAULT_CHART = [
  [1100, 'Operating Bank', 'asset'], [1110, 'Petty Cash', 'asset'], [1120, 'Wallet Clearing (sandbox)', 'asset'], [1200, 'Accounts Receivable', 'asset'],
  [1300, 'Prepaid Expenses', 'asset'], [1400, 'Inventory', 'asset'], [1500, 'Fixed Assets — Capitalised CAPEX', 'asset'],
  [2110, 'Vendor Payables (Accounts Payable)', 'liability'], [2200, 'Employee Payables', 'liability'], [2300, 'Tax Payable', 'liability'],
  [2310, 'VAT Payable / Input VAT', 'liability'], [2320, 'Withholding Tax Payable', 'liability'], [2400, 'Accrued Expenses / GRNI', 'liability'], [2600, 'Unearned Revenue', 'liability'],
  [3000, 'Retained Earnings', 'equity'],
  [4000, 'Revenue', 'revenue'],
  [6100, 'Salaries and Wages', 'expense'], [6300, 'Utilities', 'expense'], [6400, 'Travel', 'expense'], [6500, 'Professional Fees', 'expense'],
  [6600, 'IT, Software and Security Services', 'expense'], [6700, 'Office and Administration', 'expense'], [6900, 'General Operating Expense', 'expense'],
  [8100, 'Bank and Wallet Charges', 'expense'], [8900, 'Foreign Exchange Gain / Loss', 'expense'],
];
const AP_CODES = [2110, 2200, 2400];
const MEMO_RANGE_NOTE = 'memo accounts are never posted';

module.exports = function ledgerService(core) {
  const { db, now, audit } = core;
  const period = d => d.slice(0, 7);

  function seedChart(orgId) {
    for (const [code, name, type] of DEFAULT_CHART) db.run('INSERT OR IGNORE INTO chart_of_accounts(id, org_id, code, name, type, active) VALUES (?,?,?,?,?,1)', uid(), orgId, code, name, type);
  }
  function ensureAccount(orgId, code, name, type = 'expense') {
    let a = db.get('SELECT * FROM chart_of_accounts WHERE org_id = ? AND code = ?', orgId, code);
    if (!a) { db.insert('chart_of_accounts', { id: uid(), org_id: orgId, code, name, type, active: 1 }); a = db.get('SELECT * FROM chart_of_accounts WHERE org_id = ? AND code = ?', orgId, code); }
    return a;
  }
  const typeForCode = c => (c < 2000 ? 'asset' : c < 3000 ? 'liability' : c < 4000 ? 'equity' : c < 5000 ? 'revenue' : 'expense');

  function fxRate(orgId, from, to, onDate) {
    if (from === to) return { rate: 1, source: 'same currency' };
    const r = db.get('SELECT rate, source FROM fx_rates WHERE org_id = ? AND from_ccy = ? AND to_ccy = ? AND as_of <= ? ORDER BY as_of DESC LIMIT 1', orgId, from, to, onDate);
    if (!r) throw unprocessable(`No exchange rate ${from}→${to} on or before ${onDate}`, undefined, 'missing_fx_rate');
    return r;
  }

  /**
   * Posts one balanced journal entry atomically. Idempotent on (org, posting_key): a retry returns the original entry.
   * Rejects unbalanced entries, unknown / inactive accounts, and locked periods; nothing is partially written.
   */
  function post(orgId, spec) {
    const existing = db.get('SELECT * FROM journal_entries WHERE org_id = ? AND posting_key = ?', orgId, spec.postingKey);
    if (existing) return { entry: existing, duplicate: true };
    const org = db.get('SELECT * FROM organizations WHERE id = ?', orgId);
    const date = spec.date || core.today();
    const lines = spec.lines || [];
    if (lines.length < 2) throw unprocessable('A journal entry needs at least two lines', undefined, 'invalid_entry');
    for (const l of lines) {
      if (!['Dr', 'Cr'].includes(l.side) || !Number.isSafeInteger(l.amountMinor) || l.amountMinor <= 0) throw unprocessable('Journal lines need a side and a positive whole amount', undefined, 'invalid_entry');
    }
    const dr = lines.filter(l => l.side === 'Dr').reduce((s, l) => s + l.amountMinor, 0);
    const cr = lines.filter(l => l.side === 'Cr').reduce((s, l) => s + l.amountMinor, 0);
    if (dr !== cr) throw unprocessable(`Journal entry is unbalanced (Dr ${dr} vs Cr ${cr})`, undefined, 'unbalanced');
    const p = db.get('SELECT status FROM accounting_periods WHERE org_id = ? AND period = ?', orgId, period(date));
    if (p && p.status === 'locked') throw new HttpError(423, `Accounting period ${period(date)} is locked`, undefined, 'period_locked');
    const ccy = spec.currency || org.currency;
    const fx = fxRate(orgId, ccy, org.currency, date);
    const accts = lines.map(l => {
      const a = db.get('SELECT * FROM chart_of_accounts WHERE org_id = ? AND code = ?', orgId, l.code);
      if (!a) throw unprocessable(`Account ${l.code} is not in the chart of accounts`, undefined, 'unknown_account');
      if (!a.active) throw unprocessable(`Account ${l.code} ${a.name} is inactive`, undefined, 'inactive_account');
      if (a.type === 'memo') throw unprocessable(`Account ${l.code} is a memo account; ${MEMO_RANGE_NOTE}`, undefined, 'memo_account');
      return a;
    });
    // functional-currency amounts: round per line, push the rounding remainder onto the largest line of the lighter side
    const func = lines.map(l => Math.round(l.amountMinor * fx.rate));
    const fd = lines.reduce((s, l, i) => s + (l.side === 'Dr' ? func[i] : 0), 0), fc = lines.reduce((s, l, i) => s + (l.side === 'Cr' ? func[i] : 0), 0);
    if (fd !== fc) {
      const side = fd < fc ? 'Dr' : 'Cr';
      let k = -1;
      lines.forEach((l, i) => { if (l.side === side && (k < 0 || func[i] > func[k])) k = i; });
      func[k] += Math.abs(fd - fc);
    }
    return db.tx(() => {
      const n = db.get('SELECT COUNT(*) n FROM journal_entries WHERE org_id = ?', orgId).n + 1;
      const entry = {
        id: uid(), org_id: orgId, number: `JE-${date.slice(0, 4)}-${String(n).padStart(5, '0')}`, posting_key: spec.postingKey, source_type: spec.sourceType, source_id: String(spec.sourceId),
        bill_id: spec.billId || null, source_document_id: spec.sourceDocumentId || null, generated_document_id: spec.generatedDocumentId || null,
        financial_event: spec.financialEvent || '', memo: spec.memo || '', entry_date: date, period: period(date), currency: ccy, functional_currency: org.currency,
        fx_rate: fx.rate, fx_source: fx.source, reverses_entry_id: spec.reversesEntryId || null, cost_center: spec.costCenter || '', project: spec.project || '',
        created_by: spec.createdBy || null, created_at: iso(now()),
      };
      db.insert('journal_entries', entry);
      lines.forEach((l, i) => db.insert('journal_lines', { id: uid(), entry_id: entry.id, org_id: orgId, position: i + 1, account_id: accts[i].id, side: l.side, amount_minor: l.amountMinor, functional_minor: func[i] }));
      audit.record(orgId, { actorId: spec.createdBy || null, actorOrgId: orgId, action: spec.reversesEntryId ? 'journal.reversed' : 'journal.posted', objectType: 'journal_entry', objectId: entry.id,
        next: { number: entry.number, source: `${spec.sourceType}:${spec.sourceId}`, amountMinor: dr, currency: ccy }, refs: { billId: spec.billId, sourceDocumentId: spec.sourceDocumentId, generatedDocumentId: spec.generatedDocumentId } });
      return { entry, duplicate: false };
    });
  }

  const entryView = e => {
    const lines = db.all(`SELECT l.*, a.code, a.name FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY l.position`, e.id);
    const reversed = db.get('SELECT number FROM journal_entries WHERE reverses_entry_id = ?', e.id);
    return {
      id: e.id, number: e.number, date: e.entry_date, period: e.period, memo: e.memo, sourceType: e.source_type, sourceId: e.source_id, billId: e.bill_id, financialEvent: e.financial_event,
      currency: e.currency, functionalCurrency: e.functional_currency, fxRate: e.fx_rate, fxSource: e.fx_source, reversesEntryId: e.reverses_entry_id, reversedBy: reversed && reversed.number,
      sourceDocumentId: e.source_document_id, generatedDocumentId: e.generated_document_id, costCenter: e.cost_center, project: e.project,
      lines: lines.map(l => ({ code: l.code, account: l.name, side: l.side, amountMinor: l.amount_minor, functionalMinor: l.functional_minor })),
      totalMinor: lines.filter(l => l.side === 'Dr').reduce((s, l) => s + l.amount_minor, 0),
    };
  };

  const svc = {
    seedChart, ensureAccount, post, fxRate, typeForCode, AP_CODES, entryView,

    accounts(ctx) { ctx.require('ledger.view'); return db.all('SELECT code, name, type, active FROM chart_of_accounts WHERE org_id = ? ORDER BY code', ctx.orgId).map(a => ({ ...a, active: !!a.active })); },
    saveAccount(ctx, b) {
      ctx.require('coa.manage');
      const code = Number(b.code);
      if (!Number.isInteger(code) || code < 1000 || code > 9999) throw bad('Account code must be a 4-digit number');
      if (!String(b.name || '').trim()) throw bad('Account name is required');
      const type = b.type || typeForCode(code);
      const prior = db.get('SELECT * FROM chart_of_accounts WHERE org_id = ? AND code = ?', ctx.orgId, code);
      db.tx(() => {
        if (prior) db.run('UPDATE chart_of_accounts SET name = ?, active = ? WHERE id = ?', b.name.trim(), b.active === false ? 0 : 1, prior.id);
        else db.insert('chart_of_accounts', { id: uid(), org_id: ctx.orgId, code, name: b.name.trim(), type, active: b.active === false ? 0 : 1 });
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: prior ? 'coa.updated' : 'coa.created', objectType: 'account', objectId: String(code), prior: prior && { name: prior.name, active: prior.active }, next: { name: b.name, type } });
      });
      return svc.accounts(ctx);
    },

    journal(ctx, { billId, limit = 100 } = {}) {
      ctx.require('ledger.view');
      const rows = billId
        ? db.all('SELECT * FROM journal_entries WHERE org_id = ? AND bill_id = ? ORDER BY created_at, number', ctx.orgId, billId)
        : db.all('SELECT * FROM journal_entries WHERE org_id = ? ORDER BY created_at DESC, number DESC LIMIT ?', ctx.orgId, Math.min(Number(limit) || 100, 500));
      return rows.map(entryView);
    },
    reverse(ctx, entryId, reason) {
      ctx.require('ledger.post');
      if (!String(reason || '').trim()) throw bad('A reason is required to reverse an entry');
      const e = db.get('SELECT * FROM journal_entries WHERE id = ? AND org_id = ?', entryId, ctx.orgId);
      if (!e) throw notFound('Journal entry');
      if (e.reverses_entry_id) throw bad('A reversal cannot itself be reversed');
      const v = entryView(e);
      const r = post(ctx.orgId, {
        postingKey: `reverse:${e.id}`, sourceType: 'reversal', sourceId: e.id, billId: e.bill_id, date: core.today(), currency: e.currency, memo: `Reversal of ${e.number}: ${reason}`,
        reversesEntryId: e.id, financialEvent: e.financial_event, createdBy: ctx.userId,
        lines: v.lines.map(l => ({ code: l.code, side: l.side === 'Dr' ? 'Cr' : 'Dr', amountMinor: l.amountMinor })),
      });
      return entryView(r.entry);
    },
    periods(ctx) { ctx.require('ledger.view'); return db.all('SELECT period, status FROM accounting_periods WHERE org_id = ? ORDER BY period DESC', ctx.orgId); },
    setPeriod(ctx, per, locked) {
      ctx.require('ledger.post');
      if (!/^\d{4}-\d{2}$/.test(per)) throw bad('Period must look like 2026-10');
      const status = locked ? 'locked' : 'open';
      db.tx(() => {
        db.run('INSERT INTO accounting_periods(org_id, period, status) VALUES (?,?,?) ON CONFLICT(org_id, period) DO UPDATE SET status = excluded.status', ctx.orgId, per, status);
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: locked ? 'period.locked' : 'period.unlocked', objectType: 'accounting_period', objectId: per });
      });
      return svc.periods(ctx);
    },
    trialBalance(ctx, asOf = core.today()) {
      ctx.require('ledger.view');
      const rows = db.all(
        `SELECT a.code, a.name, a.type,
           COALESCE(SUM(CASE WHEN l.side='Dr' THEN l.functional_minor END),0) dr, COALESCE(SUM(CASE WHEN l.side='Cr' THEN l.functional_minor END),0) cr
         FROM chart_of_accounts a LEFT JOIN journal_lines l ON l.account_id = a.id AND l.entry_id IN (SELECT id FROM journal_entries WHERE entry_date <= ?)
         WHERE a.org_id = ? GROUP BY a.id HAVING dr <> 0 OR cr <> 0 ORDER BY a.code`, asOf, ctx.orgId);
      const out = rows.map(r => ({ code: r.code, account: r.name, type: r.type, debitMinor: r.dr, creditMinor: r.cr, balanceMinor: ['asset', 'expense'].includes(r.type) ? r.dr - r.cr : r.cr - r.dr }));
      const dr = out.reduce((s, r) => s + r.debitMinor, 0), cr = out.reduce((s, r) => s + r.creditMinor, 0);
      return { asOf, currency: ctx.org.currency, rows: out, totalDebitMinor: dr, totalCreditMinor: cr, balanced: dr === cr };
    },
    statements(ctx) {
      const tb = svc.trialBalance(ctx);
      const sum = t => tb.rows.filter(r => r.type === t).reduce((s, r) => s + r.balanceMinor, 0);
      const revenue = sum('revenue'), expense = sum('expense');
      return { currency: tb.currency, incomeStatement: { revenueMinor: revenue, expenseMinor: expense, netIncomeMinor: revenue - expense },
        balanceSheet: { assetsMinor: sum('asset'), liabilitiesMinor: sum('liability'), equityMinor: sum('equity') + revenue - expense }, balanced: tb.balanced };
    },
    /** Versioned ERP export (connector-neutral JSON). */
    export(ctx, { from = '0000-01-01', to = '9999-12-31' } = {}) {
      ctx.require('ledger.view');
      const entries = db.all('SELECT * FROM journal_entries WHERE org_id = ? AND entry_date BETWEEN ? AND ? ORDER BY entry_date, number', ctx.orgId, from, to).map(entryView);
      return { schema: 'payuno.journal-export', version: '1.0', organisation: { id: ctx.orgId, name: ctx.org.name, currency: ctx.org.currency }, generatedAt: iso(now()), entries };
    },
  };
  return svc;
};
