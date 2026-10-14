// Employee / vendor / customer master records and name matching.
const SEED = [
  { id: 'EMP-001', kind: 'employee', name: 'Adaeze Okonkwo', address: '12 Allen Avenue, Ikeja, Lagos', email: 'adaeze.okonkwo@apex.example', accountNumber: '0123456789', bankName: 'GTBank', department: 'Claims', costCenter: 'CC-CLM-10' },
  { id: 'EMP-002', kind: 'employee', name: 'Tunde Bakare', address: '7 Adeola Odeku Street, Victoria Island, Lagos', email: 'tunde.bakare@apex.example', accountNumber: '0234567891', bankName: 'Access Bank', department: 'Finance', costCenter: 'CC-FIN-20' },
  { id: 'EMP-003', kind: 'employee', name: 'Ngozi Eze', address: '3 Aminu Kano Crescent, Wuse 2, Abuja', email: 'ngozi.eze@apex.example', accountNumber: '0345678912', bankName: 'First Bank', department: 'Operations', costCenter: 'CC-OPS-30' },
  { id: 'EMP-004', kind: 'employee', name: 'Ibrahim Musa', address: '21 Ahmadu Bello Way, Kaduna', email: 'ibrahim.musa@apex.example', accountNumber: '0456789123', bankName: 'Zenith Bank', department: 'IT', costCenter: 'CC-IT-40' },
  { id: 'VEN-001', kind: 'vendor', name: 'SecureTech Nigeria Ltd', aliases: ['SecureTech'], address: 'Plot 14, Adeola Odeku Street, Victoria Island, Lagos', email: 'accounts@securetech.example', accountNumber: '2034567890', bankName: 'Zenith Bank', taxId: 'TIN-10293847', department: 'IT', costCenter: 'CC-IT-40' },
  { id: 'VEN-002', kind: 'vendor', name: 'Okafor & Partners', aliases: ['Okafor and Partners'], address: '5 Marina Road, Lagos Island, Lagos', email: 'billing@okaforpartners.example', accountNumber: '1023456789', bankName: 'Stanbic IBTC', taxId: 'TIN-20384756', department: 'Legal', costCenter: 'CC-LEG-50' },
  { id: 'VEN-003', kind: 'vendor', name: 'ABC Insurance Brokers', aliases: ['ABC Brokers'], address: '18 Broad Street, Lagos Island, Lagos', email: 'finance@abcbrokers.example', accountNumber: '3045678901', bankName: 'UBA', taxId: 'TIN-30495867', department: 'Sales', costCenter: 'CC-SAL-60' },
  { id: 'VEN-004', kind: 'vendor', name: 'Dell Nigeria Ltd', aliases: ['Dell Nigeria', 'Dell'], address: '44 Awolowo Road, Ikoyi, Lagos', email: 'ar@dell-ng.example', accountNumber: '4056789012', bankName: 'Citibank Nigeria', taxId: 'TIN-40506978', department: 'IT', costCenter: 'CC-IT-40' },
  { id: 'VEN-005', kind: 'vendor', name: 'Ikeja Electric', aliases: ['Ikeja Electricity'], address: '1 Akowonjo Road, Alimosho, Lagos', email: 'payments@ikejaelectric.example', accountNumber: '5067890123', bankName: 'Wema Bank', taxId: 'TIN-50617089', department: 'Administration', costCenter: 'CC-ADM-70' },
  { id: 'VEN-006', kind: 'vendor', name: 'Lagos Premier Hotels', aliases: ['Premier Hotels'], address: '9 Ozumba Mbadiwe Avenue, Victoria Island, Lagos', email: 'corporate@premierhotels.example', accountNumber: '6078901234', bankName: 'FCMB', taxId: 'TIN-60728190', department: 'Administration', costCenter: 'CC-ADM-70' },
  { id: 'VEN-007', kind: 'vendor', name: 'Crestview Audit Partners', aliases: ['Crestview'], address: '27 Kofo Abayomi Street, Victoria Island, Lagos', email: 'fees@crestview.example', accountNumber: '7089012345', bankName: 'Fidelity Bank', taxId: 'TIN-70839201', department: 'Finance', costCenter: 'CC-FIN-20' },
  { id: 'CUS-001', kind: 'customer', name: 'Sterling Motors Ltd', aliases: ['Sterling Motors'], address: '60 Agege Motor Road, Lagos', email: 'accounts@sterlingmotors.example', accountNumber: '8090123456', bankName: 'Polaris Bank', taxId: 'TIN-80940312', department: '', costCenter: '' },
  { id: 'CUS-002', kind: 'customer', name: 'Greenfield Foods Plc', aliases: ['Greenfield Foods'], address: '2 Industrial Avenue, Ilupeju, Lagos', email: 'ap@greenfield.example', accountNumber: '9001234567', bankName: 'Keystone Bank', taxId: 'TIN-90051423', department: '', costCenter: '' },
];

const SUFFIX = /\b(ltd|limited|plc|inc|llc|co)\b/g;
const norm = s => ` ${String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim()} `;

/** Parties mentioned in `text`, in order of first appearance. */
function findParties(text, parties, kinds) {
  const hay = norm(text);
  const hits = [];
  for (const p of parties) {
    if (kinds && !kinds.includes(p.kind)) continue;
    let best = -1;
    for (const name of [p.name, ...(p.aliases || [])]) {
      const n = norm(name).trim();
      if (n.length < 4) continue;
      const i = hay.indexOf(` ${n} `);
      if (i >= 0 && (best < 0 || i < best)) best = i;
    }
    if (best >= 0) hits.push({ party: p, index: best });
  }
  return hits.sort((a, b) => a.index - b.index);
}

const PARTY_FIELDS = ['name', 'address', 'email', 'accountNumber', 'bankName', 'taxId', 'department', 'costCenter'];
const KINDS = ['employee', 'vendor', 'customer'];

module.exports = { SEED, findParties, norm, PARTY_FIELDS, KINDS };
