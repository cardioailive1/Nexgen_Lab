/**
 * Gusto connector
 * ─────────────────────────────────────────────────────────────
 * Docs: https://docs.gusto.com/embedded-payroll/reference
 * Auth: OAuth2 Bearer token (customer connects their own Gusto
 *       account via Gusto's OAuth flow; the resulting access token
 *       is what CorverxisHRIM stores and uses here).
 *
 * Gusto payroll runs follow the company's own pay schedule — you
 * don't create arbitrary ad-hoc runs via the API the way a native
 * system can. This connector:
 *   1. Verifies the token (testConnection)
 *   2. Lists the next scheduled/open payroll for the company
 *   3. Submits it for processing (the Corverxis "Run Payroll"
 *      action effectively triggers Gusto's next open run)
 */

const BASE_PROD = 'https://api.gusto.com';
const BASE_DEMO = 'https://api.gusto-demo.com'; // Gusto's sandbox environment

function baseUrl(env) {
  return env === 'production' ? BASE_PROD : BASE_DEMO;
}

async function testConnection({ accessToken, env }) {
  const res = await fetch(`${baseUrl(env)}/v1/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gusto auth check failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const me = await res.json();
  return { ok: true, externalCompanyId: me?.roles?.company_admin_roles?.[0]?.company_id || null };
}

async function runPayroll({ accessToken, env, companyId }) {
  // 1. Find the next open/unprocessed payroll for this company
  const listRes = await fetch(
    `${baseUrl(env)}/v1/companies/${companyId}/payrolls?processed=false`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!listRes.ok) {
    throw new Error(`Gusto: could not list open payrolls (${listRes.status})`);
  }
  const openPayrolls = await listRes.json();
  const next = Array.isArray(openPayrolls) ? openPayrolls[0] : null;
  if (!next) {
    throw new Error('Gusto: no open payroll found on the company\'s pay schedule. Payrolls must be created in Gusto\'s own calendar first.');
  }

  // 2. Submit it for processing
  const submitRes = await fetch(
    `${baseUrl(env)}/v1/companies/${companyId}/payrolls/${next.payroll_id}/submit`,
    { method: 'PUT', headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!submitRes.ok) {
    const body = await submitRes.text().catch(() => '');
    throw new Error(`Gusto: payroll submission failed (${submitRes.status}): ${body.slice(0, 200)}`);
  }
  const result = await submitRes.json();

  return {
    externalRunId: String(next.payroll_id),
    totalGross: result?.totals?.gross_pay ? Number(result.totals.gross_pay) : null,
    totalNet:   result?.totals?.net_pay ? Number(result.totals.net_pay) : null,
    totalTaxes: result?.totals?.employee_taxes ? Number(result.totals.employee_taxes) : null,
    employeeCount: Array.isArray(result?.employee_compensations) ? result.employee_compensations.length : null,
    raw: result,
  };
}

module.exports = { testConnection, runPayroll };
