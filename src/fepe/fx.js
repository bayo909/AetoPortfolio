// Reference rates: 1 unit of currency = N USD. Static and indicative only (override with FX_RATES='{"NGN":0.0007}').
const DEFAULT_RATES = { USD: 1, EUR: 1.08, GBP: 1.27, NGN: 0.00065, GHS: 0.065, KES: 0.0077, ZAR: 0.054, CAD: 0.73, INR: 0.012 };

function loadRates(env = process.env) {
  let extra = {};
  try { extra = env.FX_RATES ? JSON.parse(env.FX_RATES) : {}; } catch { /* ignore malformed override */ }
  return { ...DEFAULT_RATES, ...extra };
}

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

function rateFor(currency, rates) {
  const r = rates[String(currency).toUpperCase()];
  if (!(r > 0)) return null;
  return r;
}

module.exports = { DEFAULT_RATES, loadRates, rateFor, r2 };
