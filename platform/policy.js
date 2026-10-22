// Finance policy: versioned import of the policy document into structured, source-referenced rules, and the
// approval-tier lookup used by bill approvals. A missing or ambiguous rule is reported, never invented.
const { uid, iso } = require('./db');
const { sha256 } = require('./security');
const { bad, notFound, conflict } = require('./errors');
const { parseChunks } = require('../src/policy');

const SLOT_OF = {
  'department manager': 'dept_approver', 'finance': 'finance', 'head of department': 'dept_head', 'finance manager': 'finance_manager',
  'cfo': 'cfo', 'business unit head': 'bu_head', 'ceo/executive committee': 'ceo', 'ceo / executive committee': 'ceo', 'ceo': 'ceo',
};
const SLOT_LABEL = { dept_approver: 'Department Manager', finance: 'Finance', dept_head: 'Head of Department', finance_manager: 'Finance Manager', cfo: 'CFO', bu_head: 'Business Unit Head', ceo: 'CEO / Executive Committee', capex_finance: 'CAPEX Finance Approver' };
const num = s => Number(String(s).replace(/,/g, ''));

/** Reads the FIN-POL-001 table: "NGN a – b" / "Above NGN a" followed by the approvers, e.g. "Department Manager + Finance". */
function parseApprovalTiers(text) {
  const lines = String(text).split('\n').map(l => l.trim()).filter(Boolean);
  const tiers = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const r = lines[i].match(/^NGN\s*([\d,]+)\s*[–-]\s*([\d,]+)$/i);
    const a = lines[i].match(/^Above\s+NGN\s*([\d,]+)$/i);
    if (!r && !a) continue;
    const slots = lines[i + 1].split('+').map(s => SLOT_OF[s.trim().toLowerCase()]);
    if (slots.some(s => !s)) return { ok: false, reason: `Unrecognised approver in "${lines[i + 1]}"` };
    tiers.push({ maxNgn: r ? num(r[2]) : Infinity, slots });
  }
  if (!tiers.length) return { ok: false, reason: 'No approval thresholds found' };
  for (let i = 1; i < tiers.length; i++) if (!(tiers[i].maxNgn > tiers[i - 1].maxNgn)) return { ok: false, reason: 'Thresholds are not in ascending order' };
  if (tiers[tiers.length - 1].maxNgn !== Infinity) return { ok: false, reason: 'No open-ended top tier' };
  return { ok: true, tiers };
}

module.exports = function policyService(core) {
  const { db, now, audit } = core;

  const view = d => ({ id: d.id, version: d.version, filename: d.filename, sha256: d.sha256, docRef: d.doc_ref, status: d.status, isDemo: !!d.is_demo, importedAt: d.created_at,
    rules: db.get('SELECT COUNT(*) n FROM policy_rules WHERE policy_document_id = ?', d.id).n });

  const svc = {
    SLOT_LABEL, parseApprovalTiers,

    async importPolicy(ctx, { filename, buffer, isDemo = false }) {
      ctx.require('policy.manage');
      let text;
      if (/\.docx$/i.test(filename)) text = (await require('mammoth').extractRawText({ buffer })).value;
      else if (/\.(txt|md)$/i.test(filename)) text = buffer.toString('utf8');
      else throw bad('Upload the policy as .docx, .txt or .md');
      const chunks = Object.values(parseChunks(text));
      if (!chunks.length) throw bad('No policy chunks found. Expected sections like "CHUNK 001 — Title" with a "Chunk ID:" line.');
      const hdr = text.match(/Document ID:\s*([A-Z0-9-]+)/);
      const version = db.get('SELECT COALESCE(MAX(version),0)+1 n FROM policy_documents WHERE org_id = ?', ctx.orgId).n;
      const doc = { id: uid(), org_id: ctx.orgId, version, filename, sha256: sha256(buffer), doc_ref: hdr ? hdr[1] : '', status: 'draft', is_demo: isDemo, imported_by: ctx.userId, created_at: iso(now()) };
      db.tx(() => {
        db.insert('policy_documents', doc);
        for (const c of chunks) {
          const cat = c.text.match(/Category:\s*([^\n]*?)(?:Keywords:|$|\n)/);
          db.insert('policy_rules', { id: uid(), org_id: ctx.orgId, policy_document_id: doc.id, chunk_id: c.id, title: c.title, category: cat ? cat[1].trim() : '', body: c.text, source_ref: `${filename} › CHUNK ${c.number} (${c.id})`, status: 'imported' });
        }
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'policy.imported', objectType: 'policy_document', objectId: doc.id, next: { version, filename, rules: chunks.length, isDemo } });
      });
      return view(doc);
    },
    list(ctx) { ctx.require('policy.manage'); return db.all('SELECT * FROM policy_documents WHERE org_id = ? ORDER BY version DESC', ctx.orgId).map(view); },
    rules(ctx, docId) {
      ctx.require('policy.manage');
      const d = db.get('SELECT * FROM policy_documents WHERE id = ? AND org_id = ?', docId, ctx.orgId);
      if (!d) throw notFound('Policy');
      return db.all('SELECT id, chunk_id, title, category, body, source_ref, status, note FROM policy_rules WHERE policy_document_id = ? ORDER BY chunk_id', docId);
    },
    reviewRule(ctx, ruleId, { status, note = '' }) {
      ctx.require('policy.manage');
      if (!['reviewed', 'flagged', 'imported'].includes(status)) throw bad('Invalid status');
      const r = db.get('SELECT * FROM policy_rules WHERE id = ? AND org_id = ?', ruleId, ctx.orgId);
      if (!r) throw notFound('Rule');
      const d = db.get('SELECT status FROM policy_documents WHERE id = ?', r.policy_document_id);
      if (d.status !== 'draft') throw conflict('Active policy versions are immutable; import a new version');
      db.tx(() => { db.run('UPDATE policy_rules SET status = ?, note = ? WHERE id = ?', status, note, ruleId); audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'policy.rule_reviewed', objectType: 'policy_rule', objectId: ruleId, next: { status, note } }); });
    },
    activate(ctx, docId) {
      ctx.require('policy.manage');
      const d = db.get('SELECT * FROM policy_documents WHERE id = ? AND org_id = ?', docId, ctx.orgId);
      if (!d) throw notFound('Policy');
      if (d.status !== 'draft') throw conflict(`Policy is ${d.status}`);
      const fin = db.get("SELECT body FROM policy_rules WHERE policy_document_id = ? AND chunk_id = 'FIN-POL-001'", docId);
      const parsed = fin ? parseApprovalTiers(fin.body) : { ok: false, reason: 'FIN-POL-001 (approval thresholds) not found' };
      if (!parsed.ok) throw conflict(`Cannot activate: ${parsed.reason}. Fix the policy document and import a new version.`, 'policy_ambiguous');
      if (d.imported_by === ctx.userId && !ctx.org.is_demo) throw conflict('A different administrator must activate a policy version you imported', 'segregation');
      db.tx(() => {
        db.run("UPDATE policy_documents SET status = 'retired' WHERE org_id = ? AND status = 'active'", ctx.orgId);
        db.run("UPDATE policy_documents SET status = 'active', activated_by = ? WHERE id = ?", ctx.userId, docId);
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'policy.activated', objectType: 'policy_document', objectId: docId, next: { version: d.version } });
      });
    },
    active(orgId) { return db.get("SELECT * FROM policy_documents WHERE org_id = ? AND status = 'active'", orgId); },
    chunksFor(orgId) {
      const d = svc.active(orgId);
      if (!d) return null;
      const out = {};
      for (const r of db.all('SELECT chunk_id, title, body FROM policy_rules WHERE policy_document_id = ?', d.id)) out[r.chunk_id] = { id: r.chunk_id, title: r.title, text: r.body };
      return out;
    },
    /** Approval tiers from the org's ACTIVE policy. No active / unparsable policy => { ok:false } and the bill is held for review. */
    tiersFor(orgId) {
      const d = svc.active(orgId);
      if (!d) return { ok: false, reason: 'No active finance policy. Import and activate one under Enterprise Finance Policies.' };
      const fin = db.get("SELECT body, source_ref FROM policy_rules WHERE policy_document_id = ? AND chunk_id = 'FIN-POL-001'", d.id);
      if (!fin) return { ok: false, reason: 'Active policy has no approval-threshold rule (FIN-POL-001)' };
      const p = parseApprovalTiers(fin.body);
      return p.ok ? { ...p, sourceRef: fin.source_ref, version: d.version, isDemo: !!d.is_demo } : p;
    },
    stepsFor(orgId, amountNgnMajor, classification) {
      const t = svc.tiersFor(orgId);
      if (!t.ok) return t;
      const tier = t.tiers.find(x => amountNgnMajor <= x.maxNgn);
      const slots = [...tier.slots];
      if (classification === 'capex') slots.push('capex_finance'); // FIN-POL-001: capital expenditure needs additional approval
      return { ok: true, slots, sourceRef: t.sourceRef, version: t.version, isDemo: t.isDemo };
    },
  };
  return svc;
};
module.exports.parseApprovalTiers = parseApprovalTiers;
