// KYB: configurable, versioned country workflows (NG, US, GH, GB, AU), evidence, provider-abstracted screening, review and expiry.
// The country requirement sets below are PLACEHOLDER CONFIGURATION marked pending_compliance_validation: they must be reviewed
// and validated by qualified compliance professionals before production use. Completing onboarding does not make a business compliant.
const { uid, iso } = require('./db');
const { sha256 } = require('./security');
const { bad, forbidden, notFound, conflict, unprocessable } = require('./errors');

const F = (key, label, type = 'text', extra = {}) => ({ key, label, type, ...extra });
const COUNTRY_CONFIG = {
  NG: { fields: [F('registered_name', 'Registered business name'), F('registration_no', 'CAC registration number'), F('registered_address', 'Registered address'), F('tax_id', 'Tax identification number (TIN)'), F('directors', 'Directors', 'people'), F('beneficial_owners', 'Beneficial owners', 'people', { thresholdPct: 5 }), F('representative', 'Authorised representative', 'person')],
        evidence: ['certificate_of_incorporation', 'tax_registration', 'proof_of_address', 'director_identity'] },
  US: { fields: [F('registered_name', 'Legal name'), F('registration_no', 'State file number'), F('state', 'State of formation'), F('registered_address', 'Principal business address'), F('tax_id', 'Employer identification number (EIN)'), F('beneficial_owners', 'Beneficial owners and control person', 'people', { thresholdPct: 25 }), F('representative', 'Authorised representative', 'person')],
        evidence: ['formation_document', 'tax_registration', 'representative_identity'] },
  GH: { fields: [F('registered_name', 'Registered business name'), F('registration_no', "Registrar-General's registration number"), F('registered_address', 'Registered address'), F('tax_id', 'Tax identification number (TIN)'), F('directors', 'Directors', 'people'), F('beneficial_owners', 'Beneficial owners', 'people', { thresholdPct: 20 }), F('representative', 'Authorised representative', 'person')],
        evidence: ['certificate_of_incorporation', 'tax_registration', 'proof_of_address', 'director_identity'] },
  GB: { fields: [F('registered_name', 'Registered company name'), F('registration_no', 'Companies House number'), F('registered_address', 'Registered office address'), F('tax_id', 'UTR / VAT number', 'text', { optional: true }), F('directors', 'Directors', 'people'), F('beneficial_owners', 'Persons with significant control', 'people', { thresholdPct: 25 }), F('representative', 'Authorised representative', 'person')],
        evidence: ['certificate_of_incorporation', 'proof_of_address', 'director_identity'] },
  AU: { fields: [F('registered_name', 'Registered entity name'), F('registration_no', 'ABN / ACN'), F('registered_address', 'Principal place of business'), F('tax_id', 'Tax file / GST details', 'text', { optional: true }), F('directors', 'Directors', 'people'), F('beneficial_owners', 'Beneficial owners', 'people', { thresholdPct: 25 }), F('representative', 'Authorised representative', 'person')],
        evidence: ['business_registration_extract', 'proof_of_address', 'representative_identity'] },
};

/** Provider abstraction: swap in a licensed KYB / sanctions / PEP screening provider here. */
const screeningProviders = {
  sandbox: {
    name: 'sandbox-screening',
    screen({ names }) {
      const hit = names.find(n => /sanction|blocked|embargo/i.test(n));
      const pep = names.find(n => /\bpep\b|minister|senator/i.test(n));
      return { provider: 'sandbox-screening', simulated: true, sanctions: hit ? 'potential_match' : 'clear', pep: pep ? 'potential_match' : 'clear', matched: [hit, pep].filter(Boolean), at: iso() };
    },
  },
};

module.exports = function complianceService(core) {
  const { db, now, audit } = core;
  const provider = screeningProviders.sandbox;
  for (const [country, c] of Object.entries(COUNTRY_CONFIG)) {
    db.run('INSERT OR IGNORE INTO country_kyb_configs(country, version, effective_from, review_months, fields_json, evidence_json, validation_status) VALUES (?,?,?,?,?,?,?)',
      country, 1, '2026-01-01', 12, JSON.stringify(c.fields), JSON.stringify(c.evidence), 'pending_compliance_validation');
  }
  const config = country => {
    const c = db.get('SELECT * FROM country_kyb_configs WHERE country = ? ORDER BY version DESC LIMIT 1', country);
    return c && { country: c.country, version: c.version, effectiveFrom: c.effective_from, reviewMonths: c.review_months, fields: JSON.parse(c.fields_json), evidence: JSON.parse(c.evidence_json), validationStatus: c.validation_status, validatedBy: c.validated_by };
  };
  const caseView = k => ({ id: k.id, orgId: k.org_id, country: k.country, configVersion: k.config_version, status: k.status, risk: k.risk, data: JSON.parse(k.data_json), screening: JSON.parse(k.screening_json), submittedAt: k.submitted_at, decidedAt: k.decided_at, decisionNote: k.decision_note, nextReviewAt: k.next_review_at,
    evidence: db.all('SELECT id, kind, filename, sha256, expires_at, created_at FROM compliance_evidence WHERE kyb_case_id = ?', k.id) });
  const latestCase = orgId => db.get('SELECT * FROM kyb_cases WHERE org_id = ? ORDER BY created_at DESC LIMIT 1', orgId);
  const setVendorStatus = (orgId, st) => db.run('UPDATE vendor_profiles SET kyb_status = ? WHERE org_id = ?', st, orgId);

  const svc = {
    COUNTRY_CONFIG, config,
    openCase(orgId) {
      const o = db.get('SELECT * FROM organizations WHERE id = ?', orgId);
      if (latestCase(orgId)) return;
      const cfg = config(o.country);
      db.insert('kyb_cases', { id: uid(), org_id: orgId, country: o.country, config_version: cfg.version, status: 'draft', risk: 'unrated', data_json: '{}', screening_json: '{}', created_at: iso(now()) });
    },
    configs(ctx) { return Object.keys(COUNTRY_CONFIG).map(config); },
    saveConfig(ctx, b) {
      ctx.require('platform.manage');
      if (!COUNTRY_CONFIG[b.country]) throw bad('Unsupported country');
      const cur = config(b.country);
      if (!Array.isArray(b.fields) || !Array.isArray(b.evidence)) throw bad('fields and evidence are required');
      db.tx(() => {
        db.run('INSERT INTO country_kyb_configs(country, version, effective_from, review_months, fields_json, evidence_json, validation_status) VALUES (?,?,?,?,?,?,?)',
          b.country, cur.version + 1, b.effectiveFrom || core.today(), Number(b.reviewMonths || cur.reviewMonths), JSON.stringify(b.fields), JSON.stringify(b.evidence), 'pending_compliance_validation');
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'kyb_config.versioned', objectType: 'country_kyb_config', objectId: b.country, prior: { version: cur.version }, next: { version: cur.version + 1 } });
      });
      return config(b.country);
    },
    validateConfig(ctx, country) {
      ctx.require('platform.manage');
      const cur = config(country);
      if (!cur) throw notFound('Country configuration');
      db.tx(() => { db.run("UPDATE country_kyb_configs SET validation_status = 'validated', validated_by = ? WHERE country = ? AND version = ?", ctx.user.name, country, cur.version); audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'kyb_config.validated', objectType: 'country_kyb_config', objectId: country, next: { version: cur.version } }); });
      return config(country);
    },
    myCase(ctx) {
      if (!ctx.org.is_vendor) throw forbidden();
      ctx.require('kyb.manage');
      const k = latestCase(ctx.orgId);
      return { case: caseView(k), config: config(k.country) };
    },
    saveData(ctx, data) {
      ctx.require('kyb.manage');
      const k = latestCase(ctx.orgId);
      if (!['draft', 'rejected'].includes(k.status)) throw conflict(`KYB case is ${k.status}`);
      const clean = { ...JSON.parse(k.data_json) }; // partial saves merge into what is already recorded
      const cfg = config(k.country);
      for (const f of cfg.fields) if (data[f.key] != null) clean[f.key] = f.type === 'text' ? String(data[f.key]).trim() : data[f.key];
      db.tx(() => {
        db.run("UPDATE kyb_cases SET data_json = ?, status = 'draft' WHERE id = ?", JSON.stringify(clean), k.id);
        setVendorStatus(ctx.orgId, 'in_progress');
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'kyb.data_saved', objectType: 'kyb_case', objectId: k.id });
      });
      return svc.myCase(ctx);
    },
    addEvidence(ctx, { kind, filename, buffer, expiresAt }) {
      ctx.require('kyb.manage');
      const k = latestCase(ctx.orgId);
      if (!['draft', 'rejected'].includes(k.status)) throw conflict(`KYB case is ${k.status}`);
      const cfg = config(k.country);
      if (!cfg.evidence.includes(kind)) throw bad(`Evidence type "${kind}" is not requested for ${k.country}`);
      if (!buffer || !buffer.length) throw bad('Choose a file');
      const key = `kyb_${uid()}`;
      core.putObject(key, buffer);
      db.tx(() => {
        db.insert('compliance_evidence', { id: uid(), org_id: ctx.orgId, kyb_case_id: k.id, kind, filename, sha256: sha256(buffer), storage_key: key, expires_at: expiresAt || null, uploaded_by: ctx.userId, created_at: iso(now()) });
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'kyb.evidence_added', objectType: 'kyb_case', objectId: k.id, next: { kind, filename } });
      });
      return svc.myCase(ctx);
    },
    submit(ctx) {
      ctx.require('kyb.manage');
      const k = latestCase(ctx.orgId);
      if (!['draft', 'rejected'].includes(k.status)) throw conflict(`KYB case is ${k.status}`);
      const cfg = config(k.country);
      const data = JSON.parse(k.data_json);
      const issues = [];
      for (const f of cfg.fields) {
        const v = data[f.key];
        const empty = v == null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
        if (empty && !f.optional) issues.push({ level: 'error', msg: `${f.label} is required` });
      }
      const have = new Set(db.all('SELECT kind FROM compliance_evidence WHERE kyb_case_id = ?', k.id).map(r => r.kind));
      for (const e of cfg.evidence) if (!have.has(e)) issues.push({ level: 'error', msg: `Evidence missing: ${e.replace(/_/g, ' ')}` });
      if (issues.length) throw unprocessable('KYB case is incomplete', issues);
      const names = [data.registered_name, ...(data.directors || []).map(p => p.name), ...(data.beneficial_owners || []).map(p => p.name), data.representative && data.representative.name].filter(Boolean);
      const screening = provider.screen({ names });
      const risk = screening.sanctions !== 'clear' ? 'high' : screening.pep !== 'clear' ? 'elevated' : 'standard';
      const nextReview = new Date(now()); nextReview.setUTCMonth(nextReview.getUTCMonth() + cfg.reviewMonths);
      db.tx(() => {
        db.run("UPDATE kyb_cases SET status = 'submitted', screening_json = ?, risk = ?, submitted_at = ?, config_version = ? WHERE id = ?", JSON.stringify(screening), risk, iso(now()), cfg.version, k.id);
        setVendorStatus(ctx.orgId, 'submitted');
        audit.record([ctx.orgId, ctx.orgId], { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'kyb.submitted', objectType: 'kyb_case', objectId: k.id, next: { risk, sanctions: screening.sanctions, pep: screening.pep, configValidation: cfg.validationStatus } });
      });
      return svc.myCase(ctx);
    },
    /** Platform admin queue. */
    queue(ctx) {
      ctx.require('platform.kyb_review');
      return db.all("SELECT k.*, o.name org FROM kyb_cases k JOIN organizations o ON o.id = k.org_id WHERE k.status IN ('submitted','in_review') OR k.status = 'verified' OR k.status = 'rejected' ORDER BY k.submitted_at DESC")
        .map(k => ({ ...caseView(k), org: k.org, configValidation: config(k.country).validationStatus }));
    },
    decide(ctx, caseId, { decision, note = '' }) {
      ctx.require('platform.kyb_review');
      const k = db.get('SELECT * FROM kyb_cases WHERE id = ?', caseId);
      if (!k) throw notFound('KYB case');
      if (!['submitted', 'in_review'].includes(k.status)) throw conflict(`Case is ${k.status}`);
      if (!['verified', 'rejected'].includes(decision)) throw bad('Decision must be verified or rejected');
      if (decision === 'rejected' && !String(note).trim()) throw bad('A reason is required');
      const screening = JSON.parse(k.screening_json);
      if (decision === 'verified' && (screening.sanctions !== 'clear') && !String(note).trim()) throw unprocessable('Potential sanctions match: record the clearance rationale in the decision note');
      const cfg = config(k.country);
      const nextReview = new Date(now()); nextReview.setUTCMonth(nextReview.getUTCMonth() + cfg.reviewMonths);
      db.tx(() => {
        db.run('UPDATE kyb_cases SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, next_review_at = ? WHERE id = ?', decision, ctx.userId, iso(now()), note, decision === 'verified' ? iso(nextReview).slice(0, 10) : null, caseId);
        setVendorStatus(k.org_id, decision === 'verified' ? 'verified' : 'rejected');
        audit.record([ctx.orgId, k.org_id], { actorId: ctx.userId, actorOrgId: ctx.orgId, action: `kyb.${decision}`, objectType: 'kyb_case', objectId: caseId, reason: note, next: { nextReview: decision === 'verified' ? iso(nextReview).slice(0, 10) : null } });
        if (decision === 'verified') core.svc.vendor.activatePendingRelationships(k.org_id);
      });
      return caseView(db.get('SELECT * FROM kyb_cases WHERE id = ?', caseId));
    },
    /** Ongoing review: expire verification when the review date has passed or evidence has expired. */
    runExpiry(ctx) {
      ctx.require('platform.kyb_review');
      const t = core.today();
      const out = [];
      for (const k of db.all("SELECT * FROM kyb_cases WHERE status = 'verified'")) {
        const expEvidence = db.get('SELECT 1 x FROM compliance_evidence WHERE kyb_case_id = ? AND expires_at IS NOT NULL AND expires_at < ?', k.id, t);
        if ((k.next_review_at && k.next_review_at < t) || expEvidence) {
          db.tx(() => { db.run("UPDATE kyb_cases SET status = 'expired' WHERE id = ?", k.id); setVendorStatus(k.org_id, 'expired'); audit.record([ctx.orgId, k.org_id], { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'kyb.expired', objectType: 'kyb_case', objectId: k.id, reason: expEvidence ? 'Evidence expired' : 'Periodic review overdue' }); });
          out.push(k.org_id);
        }
      }
      return { expired: out.length };
    },
    evidenceFile(ctx, id) {
      const e = db.get('SELECT * FROM compliance_evidence WHERE id = ?', id);
      if (!e) throw notFound('Evidence');
      if (!(ctx.can('platform.kyb_review') || (ctx.orgId === e.org_id && ctx.can('kyb.manage')))) throw notFound('Evidence');
      audit.record(e.org_id, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'sensitive.evidence_viewed', objectType: 'compliance_evidence', objectId: id });
      return { filename: e.filename, buffer: core.getObject(e.storage_key) };
    },
  };
  return svc;
};
