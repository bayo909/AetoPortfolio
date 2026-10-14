// Amount and date detection in extracted text.
const AMOUNT = /(?:NGN|₦|\bN(?=\d))\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)|\b(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?)\b|\b(\d+\.\d{2})\b/g;

/** All monetary amounts in `text`, ignoring percentages. */
function amountsIn(text) {
  const t = String(text).replace(/\d+(?:\.\d+)?\s*%/g, ' ');
  const out = [];
  let m;
  AMOUNT.lastIndex = 0;
  while ((m = AMOUNT.exec(t))) {
    const raw = m[1] || m[2] || m[3];
    const value = Number(raw.replace(/,/g, ''));
    if (Number.isFinite(value) && value > 0) out.push({ value, raw: m[0].trim(), index: m.index, currency: /NGN|₦|N/.test(m[0]) });
  }
  return out;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const iso = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
};

/** Dates in `text` as ISO strings; numeric dates are read day-first (Nigerian convention). */
function datesIn(text) {
  const out = [];
  const add = (index, v) => v && out.push({ iso: v, index });
  let m;
  const a = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  while ((m = a.exec(text))) add(m.index, iso(+m[1], +m[2], +m[3]));
  const b = /\b(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})\b/g;
  while ((m = b.exec(text))) add(m.index, iso(+m[3], +m[2], +m[1]));
  const c = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g;
  while ((m = c.exec(text))) { const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()); if (mi >= 0) add(m.index, iso(+m[3], mi + 1, +m[1])); }
  const d = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g;
  while ((m = d.exec(text))) { const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()); if (mi >= 0) add(m.index, iso(+m[3], mi + 1, +m[2])); }
  return out.sort((x, y) => x.index - y.index);
}

module.exports = { amountsIn, datesIn };
