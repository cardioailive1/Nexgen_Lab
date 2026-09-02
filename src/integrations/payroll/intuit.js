/**
 * Intuit QuickBooks Online Payroll connector
 * ─────────────────────────────────────────────────────────────
 * Docs: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/employee
 * Auth: OAuth2 authorization-code grant. The customer connects
 *       their QuickBooks Online company; we store the resulting
 *       access/refresh token pair plus their realmId (company id).
 *
 * Intuit's public Accounting API exposes Employee records and
 * TimeActivity, but full automated payroll-RUN creation is gated
 * behind Intuit's invitation-only Payroll API partner program —
 * most third-party integrations sync employee/comp data into QBO
 * and let the customer run payroll inside QuickBooks itself, then
 * read back the result. This connector follows that model.
 */

const API_BASE = 'https://quickbooks.api.intuit.com';       // production
const API_BASE_SANDBOX = 'https://sandbox-quickbooks.api.intuit.com';

function baseUrl(env) {
  return env === 'production' ? API_BASE : API_BASE_SANDBOX;
}

async function testConnection({ accessToken, realmId, env }) {
  const res = await fetch(
    `${baseUrl(env)}/v3/company/${realmId}/companyinfo/${realmId}?minorversion=65`,
    { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Intuit company-info check failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return { ok: true, externalCompanyId: realmId, companyName: json?.CompanyInfo?.CompanyName || null };
}

async function runPayroll({ accessToken, realmId, env }) {
  // Pull current employee list from QBO as the source of truth for
  // who's on payroll there, and read back the most recent paycheck
  // totals available via the Accounting API's report endpoints.
  const empRes = await fetch(
    `${baseUrl(env)}/v3/company/${realmId}/query?query=${encodeURIComponent("select * from Employee where Active = true")}&minorversion=65`,
    { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } }
  );
  if (!empRes.ok) {
    const body = await empRes.text().catch(() => '');
    throw new Error(`Intuit: employee query failed (${empRes.status}): ${body.slice(0, 200)}`);
  }
  const empJson = await empRes.json();
  const employees = empJson?.QueryResponse?.Employee || [];

  if (!employees.length) {
    throw new Error('Intuit: no active employees found in this QuickBooks company. Payroll runs must be processed inside QuickBooks Online Payroll — Corverxis reflects results after the fact.');
  }

  return {
    externalRunId: null, // QBO's public API doesn't return a payroll-run id for third parties
    totalGross: null,
    totalNet: null,
    totalTaxes: null,
    employeeCount: employees.length,
    raw: { note: 'Employee roster synced from QuickBooks. Actual payroll processing happens inside QuickBooks Online Payroll.', employees: employees.map(e => e.DisplayName) },
  };
}

module.exports = { testConnection, runPayroll };
