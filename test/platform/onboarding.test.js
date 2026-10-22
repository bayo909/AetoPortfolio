const test = require('node:test');
const assert = require('node:assert');
const { seeded, denies } = require('./helpers');
const { DEMO_INVITE_TOKEN } = require('../../platform/seed');

test('vendors join a customer workspace only through a valid, unexpired, single-use invitation bound to their email', async () => {
  const w = await seeded();
  const { svc, db } = w;
  denies(assert, () => svc.auth.createInvitation(w.as('chidi'), { kind: 'vendor', email: 'v@x.co', vendorName: 'V' }), 403);          // employees cannot invite
  denies(assert, () => svc.auth.createInvitation(w.as('seyi'), { kind: 'vendor', email: 'v@x.co', vendorName: 'V' }), 403);          // vendors cannot invite vendors
  const inv = svc.auth.createInvitation(w.as('funmi'), { kind: 'vendor', email: 'new.vendor@acme.example', vendorName: 'Acme Supplies' });
  assert.ok(inv.token.length > 30);
  assert.ok(!JSON.stringify(db.all('SELECT * FROM invitations')).includes(inv.token), 'only a hash of the token is stored');
  denies(assert, () => svc.auth.previewInvitation('nonsense'), 404);
  assert.strictEqual(svc.auth.previewInvitation(inv.token).inviter, 'Apex Insurance & Financial Services Ltd.');
  // an existing, signed-in user with a different email cannot take the invitation
  denies(assert, () => svc.auth.acceptInvitation(inv.token, { ctx: w.as('dell') }), 403, 'invite_email_mismatch');
  // weak password rejected, nothing created
  denies(assert, () => svc.auth.acceptInvitation(inv.token, { name: 'New Vendor', password: 'short', orgName: 'Acme Supplies' }), 400);
  const ok = svc.auth.acceptInvitation(inv.token, { name: 'New Vendor', password: 'a-strong-password', orgName: 'Acme Supplies', country: 'NG' });
  assert.strictEqual(ok.relationship, 'pending_kyb', 'unverified vendors get no access yet');
  denies(assert, () => svc.auth.acceptInvitation(inv.token, { name: 'Again', password: 'a-strong-password' }), 410);   // single use
  // pending relationship: no channel, no storefront visible, cannot receive requests
  assert.strictEqual(db.get("SELECT COUNT(*) n FROM channels WHERE kind = 'vendor' AND vendor_org_id = ?", ok.org.id).n, 0);
  const acme = svc.auth.authenticate(ok.session.token);
  denies(assert, () => svc.commerce.getRequest(acme, 'nope'), 404);
  denies(assert, () => svc.vendor.storefront(w.as('funmi'), ok.org.id), 403, 'vendor_not_verified');
  denies(assert, () => svc.commerce.createRequest(w.as('chidi'), { vendorOrgId: ok.org.id, title: 't', items: [{ description: 'x', qty: 1 }] }), 403, 'no_relationship');
});

test('invitations expire and can be revoked', async () => {
  const w = await seeded();
  const { svc } = w;
  const a = svc.auth.createInvitation(w.as('funmi'), { kind: 'vendor', email: 'late@x.example', vendorName: 'Late Ltd' });
  w.clock.t = new Date(w.clock.t.getTime() + 8 * 86400e3);
  denies(assert, () => svc.auth.acceptInvitation(a.token, { name: 'Late', password: 'a-strong-password' }), 410);
  assert.strictEqual(svc.auth.listInvitations(w.as('funmi')).find(i => i.id === a.id).status, 'expired');
  w.clock.t = new Date(w.clock.t.getTime() - 8 * 86400e3);
  const b = svc.auth.createInvitation(w.as('funmi'), { kind: 'vendor', email: 'rev@x.example', vendorName: 'Rev Ltd' });
  svc.auth.revokeInvitation(w.as('funmi'), b.id);
  denies(assert, () => svc.auth.acceptInvitation(b.token, { name: 'Rev', password: 'a-strong-password' }), 410);
  denies(assert, () => svc.auth.revokeInvitation(w.as('emeka'), b.id), 404);                         // other tenants cannot even see it
});

test('vendor staff are invited into the vendor\'s OWN workspace and never gain access to customers\' records', async () => {
  const w = await seeded();
  const { svc } = w;
  denies(assert, () => svc.auth.createInvitation(w.as('seyi'), { kind: 'staff', email: 's@x.example', role: 'finance_officer' }), 400);   // customer-only role
  const inv = svc.auth.createInvitation(w.as('seyi'), { kind: 'staff', email: 'new.sales@securetech.example', role: 'vendor_sales' });
  const r = svc.auth.acceptInvitation(inv.token, { name: 'New Sales', password: 'a-strong-password' });
  const ctx = svc.auth.authenticate(r.session.token);
  assert.strictEqual(ctx.role, 'vendor_sales'); assert.strictEqual(ctx.org.name, 'SecureTech Nigeria Ltd');
  assert.ok(svc.chat.list(ctx).some(c => c.kind === 'vendor'), 'new vendor staff are added to the customer channels the vendor already has');
  denies(assert, () => svc.bills.list(ctx), 403);
  denies(assert, () => svc.auth.createInvitation(ctx, { kind: 'staff', email: 'x@y.example', role: 'vendor_owner' }), 403);   // sales cannot invite
});

test('KYB gates vendor access: onboarding → platform review → relationship activated with a private channel', async () => {
  const w = await seeded();
  const { svc, db } = w;
  const inv = db.get('SELECT token_hash FROM invitations WHERE invited_org_name = ?', 'BrightPath Logistics Ltd');
  assert.ok(inv);
  // accept the seeded demo invitation like a real new vendor would
  const ok = svc.auth.acceptInvitation(DEMO_INVITE_TOKEN, { name: 'Bright Path', password: 'a-strong-password', orgName: 'BrightPath Logistics Ltd', country: 'GB' });
  assert.strictEqual(ok.relationship, 'pending_kyb');
  const v = svc.auth.authenticate(ok.session.token);
  const mine = svc.compliance.myCase(v);
  assert.strictEqual(mine.case.country, 'GB');
  assert.strictEqual(mine.config.validationStatus, 'pending_compliance_validation', 'country rules are flagged as awaiting compliance validation');
  assert.ok(mine.config.fields.some(f => /Companies House/.test(f.label)));
  // cannot submit an incomplete case
  denies(assert, () => svc.compliance.submit(v), 422);
  svc.compliance.saveData(v, { registered_name: 'BrightPath Logistics Ltd', registration_no: '01234567', registered_address: '1 High St, London', directors: [{ name: 'Dee Rector', dob: '1980-01-01' }], beneficial_owners: [{ name: 'Sanctioned Holdings', pct: 40 }], representative: { name: 'Bright Path' } });
  for (const kind of mine.config.evidence) svc.compliance.addEvidence(v, { kind, filename: `${kind}.pdf`, buffer: Buffer.from('%PDF-1.4 demo evidence') });
  denies(assert, () => svc.compliance.addEvidence(v, { kind: 'bank_statement', filename: 'x.pdf', buffer: Buffer.from('x') }), 400);
  const sub = svc.compliance.submit(v);
  assert.strictEqual(sub.case.status, 'submitted'); assert.strictEqual(sub.case.screening.sanctions, 'potential_match'); assert.strictEqual(sub.case.risk, 'high');
  // only the platform reviews; a potential match needs a recorded rationale
  denies(assert, () => svc.compliance.decide(w.as('funmi'), sub.case.id, { decision: 'verified' }), 403);
  denies(assert, () => svc.compliance.decide(w.as('platform'), sub.case.id, { decision: 'verified' }), 422);
  const rejected = svc.compliance.decide(w.as('platform'), sub.case.id, { decision: 'rejected', note: 'Sanctions screening hit not cleared' });
  assert.strictEqual(rejected.status, 'rejected');
  // vendor corrects and resubmits with a clean owner
  svc.compliance.saveData(v, { beneficial_owners: [{ name: 'Clean Holdings', pct: 40 }] });
  const again = svc.compliance.submit(v);
  assert.strictEqual(again.case.screening.sanctions, 'clear');
  svc.compliance.decide(w.as('platform'), again.case.id, { decision: 'verified', note: 'Documents checked' });
  const rel = db.get("SELECT status FROM vendor_relationships WHERE vendor_org_id = ?", ok.org.id);
  assert.strictEqual(rel.status, 'active');
  assert.ok(svc.vendor.listVendors(w.as('funmi')).some(x => x.name === 'BrightPath Logistics Ltd' && x.relationship === 'active'));
  const ch = svc.chat.list(v).find(c => c.kind === 'vendor');
  assert.ok(ch && ch.orgName.startsWith('Apex'), 'private vendor channel created on activation');
  assert.ok(svc.compliance.queue(w.as('platform')).length >= 1);
  // ongoing review: expired evidence / overdue review pulls verification back
  w.clock.t = new Date(w.clock.t.getTime() + 400 * 86400e3);
  assert.ok(svc.compliance.runExpiry(w.as('platform')).expired >= 1);
  assert.strictEqual(db.get('SELECT kyb_status FROM vendor_profiles WHERE org_id = ?', ok.org.id).kyb_status, 'expired');
});

test('country KYB configuration is versioned and every supported jurisdiction exists but is not claimed as validated', async () => {
  const w = await seeded();
  const { svc } = w;
  const cfgs = svc.compliance.configs(w.as('seyi'));
  assert.deepStrictEqual(cfgs.map(c => c.country).sort(), ['AU', 'GB', 'GH', 'NG', 'US']);
  assert.ok(cfgs.every(c => c.validationStatus === 'pending_compliance_validation' && c.effectiveFrom && c.reviewMonths));
  const ng = cfgs.find(c => c.country === 'NG');
  const v2 = svc.compliance.saveConfig(w.as('platform'), { country: 'NG', fields: ng.fields, evidence: ng.evidence, reviewMonths: 6 });
  assert.strictEqual(v2.version, 2);
  assert.strictEqual(svc.compliance.validateConfig(w.as('platform'), 'NG').validationStatus, 'validated');
  denies(assert, () => svc.compliance.saveConfig(w.as('seyi'), { country: 'NG', fields: [], evidence: [] }), 403);
});

test('subscriptions: entitlements, usage limits, QR gating, failed payments, upgrades and downgrades', async () => {
  const w = await seeded();
  const { svc, db } = w;
  // Okafor is on Starter: no QR payments => its customers cannot use QR, but can still open the bill
  const r = svc.commerce.createRequest(w.as('funmi'), { vendorOrgId: w.orgs.vendors.okafor.id, kind: 'rfq', title: 'Lease review', items: [{ productId: db.get("SELECT id FROM products WHERE sku = 'LEG-ADV-01'").id, qty: 1 }] });
  const q = svc.commerce.createQuote(w.as('okafor'), { requestId: r.id, lines: [{ productId: db.get("SELECT id FROM products WHERE sku = 'LEG-ADV-01'").id, qtyMilli: 1000 }] });
  assert.ok(q.id);
  denies(assert, () => svc.commerce.qrFor(w.as('okafor'), db.get('SELECT id FROM invoices LIMIT 1').id), 404);
  assert.strictEqual(svc.subscriptions.isEntitled(w.orgs.vendors.okafor.id, 'qr_payments'), false);
  assert.strictEqual(svc.subscriptions.isEntitled(w.orgs.vendors.securetech.id, 'qr_payments'), true);
  // a trial that has run out stops issuing
  const nl = w.orgs.vendors.newleaf.id;
  assert.strictEqual(svc.subscriptions.effective(db.get('SELECT * FROM subscriptions WHERE org_id = ?', nl)), 'trialing');
  w.clock.t = new Date(w.clock.t.getTime() + 40 * 86400e3);
  assert.strictEqual(svc.subscriptions.effective(db.get('SELECT * FROM subscriptions WHERE org_id = ?', nl)), 'trial_expired');
  denies(assert, () => svc.subscriptions.assertEntitled(nl, 'invoices'), 402, 'entitlement_required');
  w.clock.t = new Date(w.clock.t.getTime() - 40 * 86400e3);
  // upgrade with a declining card => past_due and blocked features; fixing the card + retry recovers
  const ok = w.as('okafor');
  svc.subscriptions.setPaymentMethod(ok, 'decline');
  const up = svc.subscriptions.change(ok, { planKey: 'growth', billingPeriod: 'annual' });
  assert.strictEqual(up.chargeOk, false); assert.strictEqual(up.status, 'past_due');
  denies(assert, () => svc.subscriptions.assertEntitled(w.orgs.vendors.okafor.id, 'invoices'), 402);
  assert.strictEqual(up.invoices[0].status, 'failed');
  svc.subscriptions.setPaymentMethod(ok, 'ok');
  const rec = svc.subscriptions.retryPayment(ok);
  assert.strictEqual(rec.chargeOk, true); assert.strictEqual(rec.status, 'active');
  assert.strictEqual(svc.subscriptions.isEntitled(w.orgs.vendors.okafor.id, 'qr_payments'), true);
  // downgrade is scheduled for period end; renewal applies it and cancellation ends service
  const down = svc.subscriptions.change(ok, { planKey: 'starter' });
  assert.strictEqual(down.pendingPlanKey, 'starter'); assert.strictEqual(down.planKey, 'growth');
  svc.subscriptions.cancel(ok);
  w.clock.t = new Date(w.clock.t.getTime() + 400 * 86400e3);
  const ren = svc.subscriptions.processRenewals();
  assert.ok(ren.some(x => x.org === w.orgs.vendors.okafor.id && x.result === 'cancelled'));
  denies(assert, () => svc.subscriptions.assertEntitled(w.orgs.vendors.okafor.id, 'quotes'), 402);
  // administrators configure plans; subscription billing never touches wallets
  const plans = svc.subscriptions.savePlan(w.as('platform'), { key: 'starter', entitlements: { invoices: 5 } });
  assert.strictEqual(plans.find(p => p.key === 'starter').entitlements.invoices, 5);
  assert.strictEqual(db.get('SELECT COUNT(*) n FROM wallet_transactions WHERE memo LIKE ?', '%subscription%').n, 0);
});

test('authentication: lockout after repeated failures, sessions expire, accounts are separate from memberships', async () => {
  const w = await seeded();
  const { svc } = w;
  for (let i = 0; i < 5; i++) denies(assert, () => svc.auth.login('chidi.nwosu@apex.example', 'wrong-password'), 401);
  denies(assert, () => svc.auth.login('chidi.nwosu@apex.example', w.PASSWORD), 429);
  const ok = svc.auth.login('emeka.obi@greenfield.example', w.PASSWORD);
  const ctx = svc.auth.authenticate(ok.session.token);
  assert.strictEqual(ctx.org.name, 'Greenfield Foods Plc');
  denies(assert, () => svc.auth.switchOrg(ok.session.token, ctx, w.orgs.apex.id), 403);          // cannot step into a tenant you do not belong to
  w.clock.t = new Date(w.clock.t.getTime() + 13 * 3600e3);
  assert.strictEqual(svc.auth.authenticate(ok.session.token), null, 'sessions expire');
  denies(assert, () => svc.auth.register({ name: 'X', email: 'EMEKA.OBI@greenfield.example', password: 'long-enough-pass', orgName: 'Z' }), 409, 'email_taken');
});
