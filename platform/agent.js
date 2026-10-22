// AI Billing Agent. The model (or rule engine) only INTERPRETS free text into {sku, qty} proposals.
// Prices, discounts, tax and totals always come from the catalog + money.js on the server, and the result is a DRAFT
// that a human vendor approver must approve. The agent can never approve, issue, pay or change an approved price.
const { bad } = require('./errors');
const { priceLine, totals, fmt } = require('./money');

const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20 };
const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'to', 'and', 'please', 'quote', 'need', 'want', 'we', 'i', 'our', 'with', 'x', 'units', 'unit', 'pcs', 'licences', 'licenses', 'licence', 'license', 'months', 'month', 'hours', 'hour', 'days', 'day']);
const tokens = s => String(s).toLowerCase().replace(/[^a-z0-9.\s-]/g, ' ').split(/\s+/).filter(Boolean);
const stem = t => t.replace(/(ing|es|s)$/, '');

/** Deterministic, offline interpreter: splits a request into segments and matches catalog items by token overlap. */
const rulesProvider = {
  name: 'rules',
  async interpret({ text, catalog }) {
    const segs = String(text).split(/\n|;|,|\band\b|\+/i).map(s => s.trim()).filter(Boolean);
    const items = [], questions = [];
    for (const seg of segs) {
      const toks = tokens(seg);
      let qty = null;
      for (const t of toks) { if (/^\d+(\.\d+)?$/.test(t)) { qty = Number(t); break; } if (WORDS[t]) { qty = WORDS[t]; break; } }
      const words = new Set(toks.filter(t => !STOP.has(t) && !/^\d/.test(t)).map(stem));
      if (!words.size) continue;
      let best = null;
      for (const p of catalog) {
        const nameToks = tokens(`${p.name} ${p.sku} ${p.category}`).filter(t => !STOP.has(t)).map(stem);
        const pset = new Set(nameToks);
        const hit = [...words].filter(w => pset.has(w)).length;
        const nameCover = tokens(p.name).filter(t => !STOP.has(t)).map(stem).filter(w => words.has(w)).length / Math.max(1, tokens(p.name).filter(t => !STOP.has(t)).length);
        const score = hit / words.size * 0.5 + nameCover * 0.5 + (toks.includes(p.sku.toLowerCase()) ? 1 : 0);
        if (hit && (!best || score > best.score)) best = { p, score };
      }
      if (best && best.score >= 0.45) {
        items.push({ sku: best.p.sku, qty, text: seg, confidence: Math.min(1, +best.score.toFixed(2)) });
        if (qty == null) questions.push(`How many of "${best.p.name}" do you need?`);
      } else questions.push(`I could not find "${seg}" in the vendor's published catalogue. Which listed product or service do you mean?`);
    }
    return { items, questions };
  },
};

/** Optional LLM interpreter (Anthropic Messages API). Output is schema-validated and falls back to the rule engine on any problem. */
function llmProvider(env) {
  return {
    name: 'llm',
    async interpret({ text, catalog }) {
      const system = 'You convert a purchasing request into JSON only: {"items":[{"sku":string,"qty":number|null,"text":string}],"questions":[string]}. ' +
        'Use ONLY the SKUs in the catalogue provided. Never invent SKUs, prices, taxes or totals. If a quantity or product is unclear, add a question instead.';
      const res = await fetch(env.AI_API_URL || 'https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: env.AI_MODEL || 'claude-sonnet-5-5', max_tokens: 800, system, messages: [{ role: 'user', content: `Catalogue:\n${catalog.map(p => `${p.sku} | ${p.name} | ${p.category}`).join('\n')}\n\nRequest:\n${text}` }] }),
      });
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
      const body = await res.json();
      const raw = (body.content || []).map(c => c.text || '').join('');
      const out = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      const skus = new Set(catalog.map(p => p.sku));
      const items = (out.items || []).filter(i => skus.has(i.sku) && (i.qty == null || (typeof i.qty === 'number' && i.qty > 0)));
      return { items: items.map(i => ({ sku: i.sku, qty: i.qty ?? null, text: String(i.text || ''), confidence: 0.8 })), questions: (out.questions || []).map(String) };
    },
  };
}

module.exports = function agentService(core) {
  const { db } = core;
  const provider = core.env.ANTHROPIC_API_KEY && core.env.AI_PROVIDER !== 'rules' ? llmProvider(core.env) : rulesProvider;

  const catalogOf = vendorOrgId => db.all('SELECT * FROM products WHERE org_id = ? AND deleted_at IS NULL AND available = 1', vendorOrgId);

  async function interpret(vendorOrgId, text) {
    const catalog = catalogOf(vendorOrgId);
    try { return { ...(await provider.interpret({ text, catalog })), provider: provider.name }; }
    catch { return { ...(await rulesProvider.interpret({ text, catalog })), provider: 'rules (fallback)' }; }
  }

  /**
   * Turns proposals into priced draft lines. Anything the catalogue cannot price becomes a `price_required` line
   * that blocks submission: the agent never guesses a price.
   */
  function priceDraft(vendorOrgId, customerOrgId, items, { currency }) {
    const lines = [], flags = [], explain = [];
    for (const it of items) {
      const p = it.productId
        ? db.get('SELECT * FROM products WHERE id = ? AND org_id = ? AND deleted_at IS NULL', it.productId, vendorOrgId)
        : it.sku ? db.get('SELECT * FROM products WHERE org_id = ? AND sku = ? AND deleted_at IS NULL', vendorOrgId, it.sku) : null;
      const qtyMilli = it.qtyMilli;
      if (!qtyMilli) { flags.push({ level: 'error', code: 'qty_missing', msg: `Quantity missing for "${it.description || it.text || (p && p.name)}"` }); continue; }
      if (!p) {
        const l = { product_id: null, sku: '', description: it.description || it.text || 'Item', qty_milli: qtyMilli, unit_price_minor: it.manualUnitPriceMinor ?? 0,
          price_source: it.manualUnitPriceMinor != null ? 'manual' : 'price_required', discount_bp: 0, tax_bp: it.taxBp || 0, wht_bp: 0 };
        lines.push({ ...l, ...priceLine(l) });
        flags.push({ level: it.manualUnitPriceMinor != null ? 'warning' : 'error', code: it.manualUnitPriceMinor != null ? 'manual_price' : 'price_required', msg: `"${l.description}" is not in the catalogue — ${it.manualUnitPriceMinor != null ? 'manual price needs approver review' : 'a price must be entered by the vendor'}` });
        continue;
      }
      if (p.currency !== currency) flags.push({ level: 'error', code: 'currency_conflict', msg: `${p.name} is priced in ${p.currency}, document currency is ${currency}` });
      const pr = core.svc.vendor.resolvePrice(p, customerOrgId, qtyMilli);
      const manual = it.manualUnitPriceMinor != null && it.manualUnitPriceMinor !== p.unit_price_minor;
      const l = {
        product_id: p.id, sku: p.sku, description: it.description || p.name, qty_milli: qtyMilli, unit_price_minor: manual ? it.manualUnitPriceMinor : pr.unit_price_minor,
        price_source: manual ? 'manual' : pr.price_source, discount_bp: manual ? 0 : pr.discount_bp, tax_bp: p.tax_bp, wht_bp: p.wht_bp,
      };
      const priced = priceLine(l);
      lines.push({ ...l, ...priced });
      if (manual) flags.push({ level: 'warning', code: 'manual_price', msg: `${p.name}: unit price ${fmt(l.unit_price_minor, p.currency)} differs from catalogue ${fmt(p.unit_price_minor, p.currency)} — approver must confirm` });
      if (p.inventory != null && p.kind === 'product' && qtyMilli / 1000 > p.inventory) flags.push({ level: 'warning', code: 'stock', msg: `${p.name}: requested ${qtyMilli / 1000} but only ${p.inventory} in stock — confirm delivery dates` });
      explain.push(`${qtyMilli / 1000} × ${p.name} @ ${fmt(l.unit_price_minor, p.currency)} = ${fmt(priced.net_minor, p.currency)}` +
        (l.discount_bp ? `, less ${(l.discount_bp / 100).toFixed(2)}% ${pr.price_source === 'customer_rule' ? 'agreed customer discount' : 'volume discount'} (${fmt(priced.discount_minor, p.currency)})` : '') +
        (l.tax_bp ? `, plus ${(l.tax_bp / 100).toFixed(2)}% VAT (${fmt(priced.tax_minor, p.currency)})` : ', no VAT') + ` → ${fmt(priced.total_minor, p.currency)}`);
    }
    return { lines, flags, explain, totals: totals(lines) };
  }

  /** Storefront Q&A: answers only from published catalogue and approved pricing rules. */
  function answer(vendorOrgId, customerOrgId, question) {
    const q = tokens(question).filter(t => !STOP.has(t)).map(stem);
    const rows = catalogOf(vendorOrgId).map(p => {
      const set = new Set(tokens(`${p.name} ${p.category} ${p.description} ${p.sku}`).map(stem));
      return { p, hit: q.filter(w => set.has(w)).length };
    }).filter(r => r.hit > 0).sort((a, b) => b.hit - a.hit).slice(0, 4);
    if (!rows.length) return { text: 'I cannot find that in this vendor\'s published catalogue, so I will not guess. You can open an RFQ and the vendor team will respond.', products: [] };
    const lines = rows.map(({ p }) => {
      const pr = core.svc.vendor.resolvePrice(p, customerOrgId, 1000);
      return `• ${p.name} (${p.sku}) — ${fmt(p.unit_price_minor, p.currency)} per ${p.unit}` + (pr.discount_bp ? `, your agreed discount ${(pr.discount_bp / 100).toFixed(2)}%` : '') + (p.tax_bp ? `, VAT ${(p.tax_bp / 100).toFixed(2)}%` : ', VAT-exempt');
    });
    return { text: `Here is what the published catalogue says:\n${lines.join('\n')}\nPrices are indicative until a vendor-approved quote is issued.`, products: rows.map(r => r.p.sku) };
  }

  return { interpret, priceDraft, answer, providerName: provider.name, catalogOf };
};
module.exports.rulesProvider = rulesProvider;
