class HttpError extends Error {
  constructor(status, message, issues, code) { super(message); this.status = status; this.issues = issues; this.code = code; }
}
const bad = (m, issues, code) => new HttpError(400, m, issues, code);
const forbidden = (m = 'You do not have permission to do that', code = 'forbidden') => new HttpError(403, m, undefined, code);
const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`);
const conflict = (m, code) => new HttpError(409, m, undefined, code);
const unprocessable = (m, issues, code) => new HttpError(422, m, issues, code);
module.exports = { HttpError, bad, forbidden, notFound, conflict, unprocessable };
