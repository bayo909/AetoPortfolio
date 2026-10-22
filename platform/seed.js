// Demo data. EVERYTHING here is fictional and lives in organisations flagged is_demo = 1; payments are sandbox-only.
// The scenario is built by calling the real services (not by inserting rows), so approvals, ledger entries and the audit trail are genuine.
const fs = require('fs');
const path = require('path');
const { uid, iso } = require('./db');
const { hashPassword, sha256 } = require('./security');
const { makeCtx } = require('./core');

const DEMO_PASSWORD = 'PayUnoDemo!2026';
const DEMO_INVITE_TOKEN = 'demo-invite-brightpath-logistics-0001';
const ROOT = path.join(__dirname, '..');

async function seed(core) {
  const { db, svc } = core;
  const pw = hashPassword(DEMO_PASSWORD);
  const $ = n => n * 100;

  const mkUser = (name, email, extra = {}) => {
    const u = { id: uid(), email, name, pw_hash: pw, is_platform_admin: extra.admin ? 1 : 0, status: 'active', created_at: core.iso() };
    db.insert('users', u);
    return u;
  };
  const people = {}; // key -> {user, orgId}
  function member(orgKey, org, key, name, email, role, extra = {}) {
    const u = mkUser(name, email);
    const m = svc.auth.addMember(org.id, u.id, role, { approvalLimitMinor: extra.limit ? $(extra.limit) : 0, department: extra.dept || '', costCenter: extra.cc || '' });
    people[key] = { user: u, org, member: db.get('SELECT * FROM organization_members WHERE id = ?', m.id) };
    if (extra.bank) db.insert('employee_profiles', { org_id: org.id, user_id: u.id, employee_no: key, bank_name: extra.bank[0], account_number_enc: core.cipher.encrypt(extra.bank[1]), address: extra.address || '' });
    return people[key];
  }
  const as = key => { const p = people[key]; return makeCtx(core, p.user, db.get('SELECT * FROM organization_members WHERE id = ?', p.member.id), db.get('SELECT * FROM organizations WHERE id = ?', p.org.id)); };

  /* ------------------------------- platform ------------------------------- */
  const platform = svc.auth.createOrg({ name: 'PayUno Platform', kind: 'platform', isCustomer: false, isVendor: false });
  const adminU = mkUser('Platform Admin', 'platform.admin@payuno.example', { admin: true });
  svc.auth.addMember(platform.id, adminU.id, 'platform_admin');
  people.platform = { user: adminU, org: platform, member: db.get('SELECT * FROM organization_members WHERE user_id = ?', adminU.id) };

  /* ------------------------------- vendors ------------------------------- */
  const vendorSpecs = [
    { key: 'securetech', name: 'SecureTech Nigeria Ltd', bank: ['Zenith Bank', '2034567890'], tax: 'TIN-10293847', plan: 'growth', verified: true, reg: 'RC-1029384',
      people: [['seyi', 'Seyi Adeyemi', 'seyi.adeyemi@securetech.example', 'vendor_owner'], ['kemi', 'Kemi Ola', 'kemi.ola@securetech.example', 'vendor_sales'], ['dayo', 'Dayo Fashola', 'dayo.fashola@securetech.example', 'vendor_owner']] },
    { key: 'okafor', name: 'Okafor & Partners', bank: ['Stanbic IBTC', '1023456789'], tax: 'TIN-20384756', plan: 'starter', verified: true, reg: 'RC-2038475', people: [['okafor', 'Chinedu Okafor', 'chinedu@okaforpartners.example', 'vendor_owner']] },
    { key: 'dell', name: 'Dell Nigeria Ltd', bank: ['Citibank Nigeria', '4056789012'], tax: 'TIN-40506978', plan: 'growth', verified: true, reg: 'RC-4050697', people: [['dell', 'Ife Balogun', 'ife.balogun@dell-ng.example', 'vendor_owner']] },
    { key: 'ikeja', name: 'Ikeja Electric', bank: ['Wema Bank', '5067890123'], tax: 'TIN-50617089', plan: 'starter', verified: true, reg: 'RC-5061708', people: [['ikeja', 'Remi Salako', 'remi.salako@ikejaelectric.example', 'vendor_owner']] },
    { key: 'crestview', name: 'Crestview Audit Partners', bank: ['Fidelity Bank', '7089012345'], tax: 'TIN-70839201', plan: 'starter', verified: true, reg: 'RC-7083920', people: [['crest', 'Tobi Alade', 'tobi.alade@crestview.example', 'vendor_owner']] },
    { key: 'premier', name: 'Lagos Premier Hotels', bank: ['FCMB', '6078901234'], tax: 'TIN-60728190', plan: 'starter', verified: true, reg: 'RC-6072819', people: [['premier', 'Halima Yusuf', 'halima.yusuf@premierhotels.example', 'vendor_owner']] },
    { key: 'newleaf', name: 'NewLeaf Analytics Ltd', bank: ['Access Bank', '0987654321'], tax: 'TIN-99887766', plan: 'trial', verified: false, reg: 'RC-9988776', people: [['newleaf', 'Wale Ojo', 'wale.ojo@newleaf.example', 'vendor_owner']] },
  ];
  const vendors = {};
  for (const v of vendorSpecs) {
    const org = svc.auth.createOrg({ name: v.name, isVendor: true, isCustomer: false, isDemo: true });
    vendors[v.key] = org;
    for (const [k, n, e, r] of v.people) member(k, org, k, n, e, r);
    db.run('UPDATE vendor_profiles SET legal_name=?, registration_no=?, bank_name=?, account_number_enc=?, account_name=?, tax_id_enc=?, kyb_status=?, description=? WHERE org_id=?',
      v.name, v.reg, v.bank[0], core.cipher.encrypt(v.bank[1]), v.name, core.cipher.encrypt(v.tax), v.verified ? 'verified' : 'submitted', `${v.name} — fictional demo vendor`, org.id);
    db.run('UPDATE storefronts SET published = 1, headline = ? WHERE org_id = ?', `${v.name} on PayUno Flow`, org.id);
    if (v.verified) db.run("UPDATE kyb_cases SET status='verified', decided_at=?, next_review_at=?, risk='standard' WHERE org_id=?", core.iso(), iso(new Date(core.now().getTime() + 300 * 86400e3)).slice(0, 10), org.id);
    if (v.plan !== 'trial') db.run("UPDATE subscriptions SET plan_key=?, status='active', trial_ends_at=NULL, current_period_end=? WHERE org_id=?", v.plan, iso(new Date(core.now().getTime() + 25 * 86400e3)), org.id);
  }
  const sec = k => vendors[k].id;

  // catalogue (SecureTech has the richest one)
  const P = (who, body) => svc.vendor.saveProduct(as(who), null, body);
  P('seyi', { sku: 'SEC-MON-01', kind: 'service', name: 'Managed Cybersecurity Monitoring (per month)', category: 'Security services', description: '24/7 SOC monitoring, alert triage and monthly report', unit: 'month', unitPrice: '400000.00', taxBp: 750, whtBp: 500 });
  P('seyi', { sku: 'SEC-PEN-01', kind: 'service', name: 'Penetration Test (external + internal)', category: 'Security services', description: 'Scoped penetration test with remediation workshop', unit: 'engagement', unitPrice: '1200000.00', taxBp: 750, whtBp: 500 });
  P('seyi', { sku: 'SEC-EDR-01', kind: 'product', name: 'Endpoint Protection Licence (annual)', category: 'Software licences', description: 'EDR agent licence per endpoint per year', unit: 'licence', unitPrice: '18000.00', taxBp: 750, inventory: null });
  P('seyi', { sku: 'SEC-FW-01', kind: 'product', name: 'Next-Generation Firewall Appliance', category: 'Network hardware', description: 'Rack-mount NGFW, 3-year support. Capital equipment.', unit: 'unit', unitPrice: '3500000.00', taxBp: 750, inventory: 8 });
  const prod = sku => db.get('SELECT * FROM products WHERE org_id = ? AND sku = ?', sec('securetech'), sku);
  svc.vendor.savePricingRule(as('seyi'), { productId: prod('SEC-EDR-01').id, customerOrgId: null, minQtyMilli: 50000, discountBp: 500, note: 'Volume discount 50+ licences' });
  P('okafor', { sku: 'LEG-ADV-01', kind: 'service', name: 'Legal Advisory (per engagement)', category: 'Professional services', unitPrice: '750000.00', taxBp: 750, whtBp: 500 });
  P('dell', { sku: 'DELL-LAP-01', kind: 'product', name: 'Dell Latitude 5540 Laptop', category: 'Computing', unit: 'unit', unitPrice: '1250000.00', taxBp: 750, inventory: 40 });
  P('ikeja', { sku: 'IKE-PWR-01', kind: 'service', name: 'Commercial electricity supply (monthly)', category: 'Utilities', unitPrice: '320000.00', taxBp: 750 });
  P('crest', { sku: 'CRE-AUD-01', kind: 'service', name: 'Year-end audit support', category: 'Professional services', unitPrice: '2000000.00', taxBp: 750, whtBp: 500 });
  P('premier', { sku: 'PRM-VEN-01', kind: 'service', name: 'Conference venue hire (per day)', category: 'Hospitality', unitPrice: '450000.00', taxBp: 750 });
  P('newleaf', { sku: 'NLA-DASH-01', kind: 'service', name: 'Analytics dashboard build', category: 'Analytics', unitPrice: '900000.00', taxBp: 750, whtBp: 500 });

  /* ---------------------------- customer: Apex ---------------------------- */
  const apex = svc.auth.createOrg({ name: 'Apex Insurance & Financial Services Ltd.', isDemo: true });
  member('adaeze', apex, 'adaeze', 'Adaeze Okonkwo', 'adaeze.okonkwo@apex.example', 'org_admin', { limit: 100_000_000, dept: 'Executive Office', cc: 'CC-EXE-00', bank: ['GTBank', '0123456789'], address: '12 Allen Avenue, Ikeja, Lagos' });
  member('chidi', apex, 'chidi', 'Chidi Nwosu', 'chidi.nwosu@apex.example', 'employee', { dept: 'IT', cc: 'CC-IT-40', bank: ['UBA', '0567891234'] });
  member('funmi', apex, 'funmi', 'Funmi Adebayo', 'funmi.adebayo@apex.example', 'procurement_officer', { limit: 2_000_000, dept: 'Operations', cc: 'CC-OPS-30', bank: ['Access Bank', '0678912345'] });
  member('tunde', apex, 'tunde', 'Tunde Bakare', 'tunde.bakare@apex.example', 'finance_officer', { limit: 2_000_000, dept: 'Finance', cc: 'CC-FIN-20', bank: ['Access Bank', '0234567891'], address: '7 Adeola Odeku Street, Victoria Island, Lagos' });
  member('kunle', apex, 'kunle', 'Kunle Raji', 'kunle.raji@apex.example', 'finance_officer', { limit: 500_000, dept: 'Finance', cc: 'CC-FIN-20', bank: ['Zenith Bank', '0789123456'] });
  member('ngozi', apex, 'ngozi', 'Ngozi Eze', 'ngozi.eze@apex.example', 'finance_approver', { limit: 500_000_000, dept: 'Finance', cc: 'CC-FIN-20', bank: ['First Bank', '0345678912'], address: '3 Aminu Kano Crescent, Wuse 2, Abuja' });
  member('ibrahim', apex, 'ibrahim', 'Ibrahim Musa', 'ibrahim.musa@apex.example', 'accountant', { dept: 'Finance', cc: 'CC-FIN-20', bank: ['Zenith Bank', '0456789123'] });
  member('bola', apex, 'bola', 'Bola Adewale', 'bola.adewale@apex.example', 'employee', { dept: 'Claims', cc: 'CC-CLM-10', bank: ['GTBank', '0891234567'] });
  for (const [code, name, dept] of [['CC-EXE-00', 'Executive Office', 'Executive'], ['CC-CLM-10', 'Claims', 'Claims'], ['CC-FIN-20', 'Finance', 'Finance'], ['CC-OPS-30', 'Operations', 'Operations'], ['CC-IT-40', 'Information Technology', 'IT'], ['CC-LEG-50', 'Legal', 'Legal'], ['CC-ADM-70', 'Administration', 'Administration']])
    svc.admin.saveCostCenter(as('adaeze'), { code, name, department: dept });
  const B = (cc, cls, amt) => svc.admin.saveBudget(as('ngozi'), { costCenter: cc, classification: cls, allocatedMinor: $(amt) });
  [['CC-EXE-00', 'opex', 5e6], ['CC-CLM-10', 'opex', 300_000], ['CC-FIN-20', 'opex', 10e6], ['CC-OPS-30', 'opex', 20e6], ['CC-IT-40', 'opex', 30e6], ['CC-LEG-50', 'opex', 8e6], ['CC-ADM-70', 'opex', 6e6], ['CC-IT-40', 'capex', 25e6], ['CC-OPS-30', 'capex', 10e6]]
    .forEach(([c, k, a]) => B(c, k, a));
  // wallets (SIMULATED balances)
  const W = (name, kind, bal, extra = {}) => { const w = svc.payments.createWallet(as('ngozi'), { name, kind, ...extra }); if (bal) svc.payments.topup(as('ngozi'), w.id, $(bal)); return w; };
  const wOpex = W('OPEX Main (sandbox)', 'opex', 50e6, { perTxnLimitMinor: $(10e6), dualControlMinor: $(5e6) });
  const wCapex = W('CAPEX Main (sandbox)', 'capex', 20e6, { perTxnLimitMinor: $(15e6) });
  const wReimb = W('Employee Reimbursements (sandbox)', 'reimbursement', 2e6, { perTxnLimitMinor: $(1e6) });
  const wLow = W('OPEX Low Balance — insufficient-funds demo', 'opex', 100_000);
  const wDecline = W('Provider Decline Test — failed-payment demo', 'opex', 5e6);
  svc.payments.updateWallet(as('ngozi'), wDecline.id, { sandboxBehavior: 'decline' });
  // policy: the supplied document, imported and activated as a SAMPLE policy
  const pol = await svc.policy.importPolicy(as('adaeze'), { filename: 'PayUno_Finance_Operations_Policy.docx', buffer: fs.readFileSync(path.join(ROOT, 'data', 'PayUno_Finance_Operations_Policy.docx')), isDemo: true });
  svc.policy.activate(as('adaeze'), pol.id);
  svc.admin.saveIntegration(as('adaeze'), { kind: 'erp_export', name: 'ERP journal export (sandbox)', config: { format: 'payuno.journal-export/1.0' } });

  /* -------------------------- customer 2: Greenfield -------------------------- */
  const green = svc.auth.createOrg({ name: 'Greenfield Foods Plc', isDemo: true });
  member('emeka', green, 'emeka', 'Emeka Obi', 'emeka.obi@greenfield.example', 'org_admin', { limit: 50_000_000, dept: 'Management', cc: 'GF-MGT' });
  member('zainab', green, 'zainab', 'Zainab Bello', 'zainab.bello@greenfield.example', 'employee', { dept: 'Plant', cc: 'GF-PLT' });
  member('hauwa', green, 'hauwa', 'Hauwa Musa', 'hauwa.musa@greenfield.example', 'finance_officer', { limit: 1_000_000, dept: 'Finance', cc: 'GF-FIN' });
  svc.admin.saveCostCenter(as('emeka'), { code: 'GF-PLT', name: 'Plant', department: 'Plant' });

  /* ---------------------------- invitations & links ---------------------------- */
  const invite = (who, key, name) => { const r = svc.auth.createInvitation(as(who), { kind: 'vendor', email: people[key].user.email, vendorName: name }); return svc.auth.acceptInvitation(r.token, { ctx: as(key) }); };
  invite('funmi', 'seyi', 'SecureTech Nigeria Ltd');
  invite('funmi', 'okafor', 'Okafor & Partners');
  invite('funmi', 'dell', 'Dell Nigeria Ltd');
  invite('funmi', 'ikeja', 'Ikeja Electric');
  invite('funmi', 'crest', 'Crestview Audit Partners');
  invite('funmi', 'premier', 'Lagos Premier Hotels');
  invite('funmi', 'newleaf', 'NewLeaf Analytics Ltd'); // KYB not verified -> relationship waits in pending_kyb
  invite('emeka', 'seyi', 'SecureTech Nigeria Ltd');
  // an invitation that has not been accepted yet (so the join-by-invitation flow can be tried): token below is for demos only
  db.insert('invitations', { id: uid(), kind: 'vendor', org_id: apex.id, email: 'ops@brightpath.example', invited_org_name: 'BrightPath Logistics Ltd', role: 'vendor_owner', token_hash: sha256(DEMO_INVITE_TOKEN), status: 'pending',
    expires_at: iso(new Date(core.now().getTime() + 7 * 86400e3)), invited_by: people.funmi.user.id, created_at: core.iso() });
  svc.vendor.updateProfile(as('seyi'), { paymentTermsDays: 14 });
  svc.vendor.savePricingRule(as('seyi'), { productId: prod('SEC-MON-01').id, customerOrgId: apex.id, minQtyMilli: 1000, discountBp: 500, note: 'Agreed Apex rate: 5% off monitoring' });
  svc.chat.ensureGeneral(apex.id); svc.chat.syncOrgChannels(apex.id);
  svc.chat.ensureGeneral(green.id); svc.chat.syncOrgChannels(green.id);
  svc.rtfepe.syncParties(apex.id);

  /* ======================= scenario A: complete happy path (PAID) ======================= */
  const catalogReq = (who, vendorKey, title, items, kind = 'rfq') => svc.commerce.createRequest(as(who), { vendorOrgId: sec(vendorKey), kind, title, purchaseRef: 'PR-DEMO', items: items.map(([sku, qty]) => ({ productId: db.get('SELECT id FROM products WHERE org_id = ? AND sku = ?', sec(vendorKey), sku).id, qty })) });
  const draftQuote = async (prep, appr, req, instruction) => {
    const ctx = as(prep);
    const items = JSON.parse(db.get('SELECT items_json FROM requests WHERE id = ?', req.id).items_json).map(i => ({ productId: i.productId, qtyMilli: i.qtyMilli }));
    const q = svc.commerce.createQuote(ctx, { requestId: req.id, lines: items }, { via: 'agent', extraFlags: [{ level: 'info', code: 'ai_draft', msg: 'AI-prepared DRAFT' }] });
    return q;
  };
  const rfq1 = catalogReq('chidi', 'securetech', 'Managed cybersecurity monitoring — 3 months', [['SEC-MON-01', 3]]);
  let q1 = await draftQuote('kemi', 'seyi', rfq1);
  svc.commerce.submitQuote(as('kemi'), q1.id); svc.commerce.approveQuote(as('seyi'), q1.id, { comment: 'Approved at agreed Apex rate' });
  svc.commerce.acceptQuote(as('funmi'), q1.id);
  let inv1 = svc.commerce.createInvoice(as('kemi'), { quoteId: q1.id });
  svc.commerce.submitInvoice(as('kemi'), inv1.id); svc.commerce.approveInvoice(as('seyi'), inv1.id); inv1 = svc.commerce.issueInvoice(as('seyi'), inv1.id);
  const bill1 = inv1.billId;
  svc.bills.validate(as('tunde'), bill1, { classification: 'opex', costCenter: 'CC-IT-40' });
  svc.bills.confirmReceipt(as('chidi'), bill1);
  svc.bills.submit(as('tunde'), bill1);
  const stepsOf = id => svc.bills.get(as('tunde'), id).workflow.steps;
  for (const [who, slot] of [['funmi', 'dept_head'], ['ngozi', 'finance_manager']]) svc.bills.decide(as(who), stepsOf(bill1).find(s => s.slot === slot).id, { decision: 'approved', comment: 'Within budget' });
  const pay = (billId, wallet, initiator, executor) => {
    const i = svc.payments.createIntent(as(initiator), { billId, walletId: wallet.id, idempotencyKey: `seed-${billId.slice(0, 8)}-${wallet.id.slice(0, 4)}` });
    return svc.payments.execute(as(executor), i.id, { password: DEMO_PASSWORD });
  };
  pay(bill1, wOpex, 'chidi', 'kunle');

  /* =================== scenario B: approved & issued, awaiting QR payment =================== */
  const rfq2 = catalogReq('chidi', 'securetech', 'Annual penetration test', [['SEC-PEN-01', 1]]);
  const q2 = await draftQuote('kemi', 'seyi', rfq2);
  svc.commerce.submitQuote(as('kemi'), q2.id); svc.commerce.approveQuote(as('seyi'), q2.id, {}); svc.commerce.acceptQuote(as('funmi'), q2.id);
  let inv2 = svc.commerce.createInvoice(as('kemi'), { quoteId: q2.id });
  svc.commerce.submitInvoice(as('kemi'), inv2.id); svc.commerce.approveInvoice(as('seyi'), inv2.id); inv2 = svc.commerce.issueInvoice(as('seyi'), inv2.id);
  svc.bills.validate(as('tunde'), inv2.billId, { classification: 'opex', costCenter: 'CC-IT-40' });
  svc.bills.confirmReceipt(as('chidi'), inv2.billId); svc.bills.submit(as('tunde'), inv2.billId);
  for (const [who, slot] of [['funmi', 'dept_head'], ['ngozi', 'finance_manager']]) svc.bills.decide(as(who), stepsOf(inv2.billId).find(s => s.slot === slot).id, { decision: 'approved' });

  /* ============== scenario C: CAPEX bill pending approval; rejected bill; dispute ============== */
  const rfq3 = catalogReq('chidi', 'securetech', 'Replacement firewall for head office', [['SEC-FW-01', 1]]);
  const q3 = await draftQuote('kemi', 'seyi', rfq3);
  svc.commerce.submitQuote(as('kemi'), q3.id); svc.commerce.approveQuote(as('seyi'), q3.id, {}); svc.commerce.acceptQuote(as('funmi'), q3.id);
  let inv3 = svc.commerce.createInvoice(as('kemi'), { quoteId: q3.id });
  svc.commerce.submitInvoice(as('kemi'), inv3.id); svc.commerce.approveInvoice(as('seyi'), inv3.id); inv3 = svc.commerce.issueInvoice(as('seyi'), inv3.id);
  svc.bills.validate(as('tunde'), inv3.billId, { classification: 'capex', costCenter: 'CC-IT-40' });
  svc.bills.confirmReceipt(as('chidi'), inv3.billId); svc.bills.submit(as('tunde'), inv3.billId);

  const rfq4 = catalogReq('chidi', 'securetech', 'Endpoint licences — 20 seats', [['SEC-EDR-01', 20]]);
  const q4 = await draftQuote('kemi', 'seyi', rfq4);
  svc.commerce.submitQuote(as('kemi'), q4.id); svc.commerce.approveQuote(as('seyi'), q4.id, {}); svc.commerce.acceptQuote(as('funmi'), q4.id);
  let inv4 = svc.commerce.createInvoice(as('kemi'), { quoteId: q4.id });
  svc.commerce.submitInvoice(as('kemi'), inv4.id); svc.commerce.approveInvoice(as('seyi'), inv4.id); inv4 = svc.commerce.issueInvoice(as('seyi'), inv4.id);
  svc.bills.validate(as('tunde'), inv4.billId, { classification: 'opex', costCenter: 'CC-IT-40' });
  svc.bills.confirmReceipt(as('chidi'), inv4.billId);
  svc.bills.submit(as('tunde'), inv4.billId);
  svc.bills.decide(as('funmi'), stepsOf(inv4.billId)[0].id, { decision: 'rejected', comment: 'Licence count not agreed with IT — please re-confirm quantity' });

  const rfq5 = catalogReq('bola', 'okafor', 'Legal advisory — lease review', [['LEG-ADV-01', 1]]);
  const q5 = await draftQuote('okafor', 'okafor', rfq5).catch(() => null);
  void q5;

  /* ============== scenario D: open requests for the AI agent to pick up ============== */
  catalogReq('chidi', 'securetech', 'Endpoint protection for new Abuja branch (60 seats)', [['SEC-EDR-01', 60]]);
  svc.commerce.createRequest(as('funmi'), { vendorOrgId: sec('dell'), kind: 'rfq', title: 'Laptops for claims team', items: [{ productId: db.get('SELECT id FROM products WHERE org_id = ? AND sku = ?', sec('dell'), 'DELL-LAP-01').id, qty: 12 }] });
  // a quote waiting for a vendor approver
  const rfq6 = catalogReq('chidi', 'securetech', 'Extra monitoring month — October', [['SEC-MON-01', 1]]);
  const q6 = await draftQuote('kemi', 'seyi', rfq6);
  svc.commerce.submitQuote(as('kemi'), q6.id);
  // an invoice issued and just received, waiting for finance validation
  const rfq7 = catalogReq('chidi', 'securetech', 'Monitoring — September', [['SEC-MON-01', 1]]);
  const q7 = await draftQuote('kemi', 'seyi', rfq7);
  svc.commerce.submitQuote(as('kemi'), q7.id); svc.commerce.approveQuote(as('seyi'), q7.id, {}); svc.commerce.acceptQuote(as('funmi'), q7.id);
  let inv7 = svc.commerce.createInvoice(as('kemi'), { quoteId: q7.id });
  svc.commerce.submitInvoice(as('kemi'), inv7.id); svc.commerce.approveInvoice(as('seyi'), inv7.id); svc.commerce.issueInvoice(as('seyi'), inv7.id);

  /* ============== scenario E: employee expense + RT-FEPE documents ============== */
  svc.bills.submitExpense(as('bola'), { description: 'Client meeting transport — Lagos to Ibadan', category: 'travel', amount: '38500', incurredOn: iso(new Date(core.now().getTime() - 5 * 86400e3)).slice(0, 10), costCenter: 'CC-CLM-10' }, null);
  for (const [who, file, intake, docType] of [['adaeze', 'memo_admin_expenses.txt', 'unstructured'], ['funmi', 'invoice_okafor.pdf', 'structured', 'invoice_payable']]) {
    const buffer = fs.readFileSync(path.join(ROOT, 'samples', file));
    svc.rtfepe.upload(as(who), { buffer, filename: file, intake, docType });
  }
  await core.idle();

  /* ======= scenario F: accounting posting failure (period locked), then unlocked for retry ======= */
  const rfq8 = catalogReq('chidi', 'securetech', 'Monitoring — August (late)', [['SEC-MON-01', 1]]);
  const q8 = await draftQuote('kemi', 'seyi', rfq8);
  svc.commerce.submitQuote(as('kemi'), q8.id); svc.commerce.approveQuote(as('seyi'), q8.id, {}); svc.commerce.acceptQuote(as('funmi'), q8.id);
  let inv8 = svc.commerce.createInvoice(as('kemi'), { quoteId: q8.id });
  svc.commerce.submitInvoice(as('kemi'), inv8.id); svc.commerce.approveInvoice(as('seyi'), inv8.id); inv8 = svc.commerce.issueInvoice(as('seyi'), inv8.id);
  svc.bills.validate(as('tunde'), inv8.billId, { classification: 'opex', costCenter: 'CC-IT-40' });
  svc.bills.confirmReceipt(as('chidi'), inv8.billId); svc.bills.submit(as('tunde'), inv8.billId);
  const period = core.today().slice(0, 7);
  svc.ledger.setPeriod(as('ibrahim'), period, true);
  for (const [who, slot] of [['funmi', 'dept_approver'], ['kunle', 'finance']]) svc.bills.decide(as(who), stepsOf(inv8.billId).find(s => s.slot === slot).id, { decision: 'approved' });
  svc.ledger.setPeriod(as('ibrahim'), period, false);

  // a few channel messages so the workspace is not empty
  const ch = db.get("SELECT * FROM channels WHERE kind='vendor' AND org_id = ? AND vendor_org_id = ?", apex.id, sec('securetech'));
  svc.chat.post(as('funmi'), ch.id, { body: 'Welcome to the Apex workspace, SecureTech team. Please raise quotes and invoices against our RFQs here.' });
  svc.chat.post(as('seyi'), ch.id, { body: 'Thanks @Funmi — happy to be onboarded. Our AI Billing Agent can answer catalogue questions with @agent.' });
  return { demoPassword: DEMO_PASSWORD, inviteToken: DEMO_INVITE_TOKEN };
}

module.exports = { seed, DEMO_PASSWORD, DEMO_INVITE_TOKEN };
