// Extractive summary of an unstructured document: keeps only sentences that describe key financial events.
const { amountsIn, datesIn } = require('./money');
const { findParties } = require('./parties');
const { prepareRows, bestMatchAcross } = require('./matcher');

const KEYWORDS = /\b(pay|paid|payment|invoice|invoiced|bill|billed|expense|expenses|reimburs\w*|claim\w*|travel\w*|hotel|flight|airfare|salary|salaries|payroll|fee|fees|purchase\w*|order\w*|vendor|supplier|rent|utility|utilities|electricity|loan|interest|tax|vat|paye|advance|deposit|refund|settle\w*|budget|cost|quote|quotation|contract|retainer|subscription|procure\w*|deliver\w*|receiv\w*)\b/i;

function sentencesOf(lines) {
  const out = [];
  for (const l of lines) {
    for (const s of l.text.split(/(?<=[.!?;])\s+(?=[A-Z0-9₦])/)) {
      const t = s.trim();
      if (t.length >= 12) out.push({ lineNo: l.n, text: t });
    }
  }
  return out;
}

const MAX_EVENTS = 10;

/**
 * @returns {{headline: string, events: object[], considered: number}}
 * Each event: { lineNo, text, amounts, dates, parties, match: {sourceDocument, event, phrase, score, rowIndex}|null, relevance }
 */
function summarise(lines, master, parties) {
  const prepared = prepareRows(master.rows);
  const seen = new Set();
  const scored = [];
  const sentences = sentencesOf(lines);
  for (const s of sentences) {
    const key = s.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const amounts = amountsIn(s.text);
    const m = bestMatchAcross(s.text, prepared);
    const kw = (s.text.match(new RegExp(KEYWORDS.source, 'gi')) || []).length;
    const relevance = (amounts.length ? 2 : 0) + Math.min(kw, 3) + (m.matched ? 3 : 0);
    if (!m.matched && relevance < 3) continue; // not a financial event
    scored.push({
      lineNo: s.lineNo, text: s.text, relevance,
      amounts: amounts.map(a => a.raw), dates: datesIn(s.text).map(d => d.iso),
      parties: findParties(s.text, parties).map(h => ({ id: h.party.id, name: h.party.name, kind: h.party.kind })),
      match: m.matched ? { sourceDocument: m.best.row.sourceDocument, event: m.best.row.financialEvent, phrase: m.best.row.phrase, score: m.best.score, rowIndex: m.best.row.index } : null,
    });
  }
  // keep the strongest MAX_EVENTS, but present them in document order
  const keep = new Set(scored.slice().sort((a, b) => b.relevance - a.relevance).slice(0, MAX_EVENTS));
  const events = scored.filter(e => keep.has(e));
  const names = [...new Set(events.filter(e => e.match).map(e => e.match.event))];
  const headline = events.length
    ? `${events.length} key financial event${events.length === 1 ? '' : 's'} identified${names.length ? `: ${names.join(', ')}` : ''}.`
    : 'No key financial events were identified in this document.';
  return { headline, events, considered: sentences.length };
}

module.exports = { summarise, sentencesOf };
