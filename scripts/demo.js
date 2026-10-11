// Demo data for local use: DEMO=1 npm start. All accounts share the password below.
const PASSWORD = 'demo-pass-123';

function seed(svc) {
  if (Object.keys(svc.state.users).length) return;
  const reg = (email, name, extra) => svc.register({ email, name, password: PASSWORD, ...extra }).user;
  const ada = reg('ada@northwind.test', 'Ada Obi (Admin)', { orgName: 'Northwind Holdings' });
  const org = svc.orgInfo(ada);
  const login = e => svc.authenticate(svc.login({ email: e, password: PASSWORD }).token);
  reg('kemi@northwind.test', 'Kemi Bello (Approver)', { orgJoinCode: org.joinCode });
  reg('tolu@northwind.test', 'Tolu Adeyemi (Finance)', { orgJoinCode: org.joinCode });
  const A = login('ada@northwind.test');
  svc.setRole(A, login('kemi@northwind.test').id, 'approver');
  svc.setRole(A, login('tolu@northwind.test').id, 'approver');
  const ws = svc.createWorkspace(A, { name: 'Northwind Finance' });
  const ws0 = Object.values(svc.state.workspaces)[0];
  for (const [email, name, company] of [['tunde@securetech.test', 'Tunde Eze', 'SecureTech Nigeria Ltd'], ['chidi@okafor.test', 'Chidi Okafor', 'Okafor & Partners']]) {
    reg(email, name, { orgName: company });
    svc.joinWorkspace(login(email), { code: ws0.inviteCode });
  }
  const view = svc.getWorkspace(A, ws.id);
  const tpl = svc.listTemplates(A, ws.id);
  const t = n => tpl.find(x => x.name === n).id;
  const chan = n => view.channels.find(c => c.name.includes(n)).id;
  svc.createRequest(A, chan('securetech'), { templateId: t('Vendor Invoice'), title: 'September cybersecurity invoice', note: 'Please send the invoice for September, referencing PO-1001.', dueDate: '2026-10-20' });
  svc.createRequest(A, chan('okafor'), { templateId: t('Vendor Invoice'), title: 'Legal advisory invoice', note: 'Invoice for the contract review, thanks.' });
  svc.createRequest(A, chan('securetech'), { templateId: t('Tax Exemption / Compliance Certificate'), title: 'Current tax clearance certificate' });
}

module.exports = { seed, PASSWORD };
