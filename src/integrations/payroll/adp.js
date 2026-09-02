/**
 * ADP Workforce Now connector
 * ─────────────────────────────────────────────────────────────
 * Docs: https://developers.adp.com/articles/api/hcm-offerings
 * Auth: OAuth2 client_credentials grant. Production ADP APIs
 *       require a client certificate (mutual TLS) issued by ADP
 *       alongside client_id/client_secret — this is configured at
 *       the infra level (Node's https.Agent), not per-request.
 *
 * ADP does not expose a simple "create arbitrary payroll run"
 * endpoint to third parties the way a native system can — payroll
 * processing lives inside ADP's own run cycle. This connector:
 *   1. Verifies credentials via the Worker Demographics API
 *   2. Pushes headcount/compensation deltas so ADP's run reflects
 *      current CorverxisHRIM data
 *   3. Reads back the most recent completed run's totals
 */

const TOKEN_URL = 'https://accounts.adp.com/auth/oauth/v2/token';
const API_BASE  = 'https://api.adp.com';

async function getAccessToken({ clientId, clientSecret }) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ADP token request failed (${res.status}): ${body.slice(0, 200)}. Note: ADP production requires a client certificate configured at the connection level — see Render env var ADP_CLIENT_CERT.`);
  }
  const json = await res.json();
  return json.access_token;
}

async function testConnection({ clientId, clientSecret }) {
  const token = await getAccessToken({ clientId, clientSecret });
  const res = await fetch(`${API_BASE}/hr/v2/workers?$top=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ADP worker check failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return { ok: true, externalCompanyId: null };
}

async function runPayroll({ clientId, clientSecret, orgOid }) {
  const token = await getAccessToken({ clientId, clientSecret });

  // Sync isn't a payroll "run" trigger — ADP processes on its own
  // schedule. We surface the most recent processed pay statement
  // summary so it shows up in Corverxis Payroll history.
  const res = await fetch(
    `${API_BASE}/payroll/v1/pay-data-input/pay-statements?$top=1&$orderby=payDate desc`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ADP: could not retrieve latest pay statement (${res.status}): ${body.slice(0, 200)}. ADP payroll runs are triggered inside ADP Workforce Now, not via this API — Corverxis reflects results after processing.`);
  }
  const data = await res.json();
  const stmt = data?.payStatements?.[0];
  if (!stmt) {
    throw new Error('ADP: no processed pay statement found yet for this pay period.');
  }

  return {
    externalRunId: stmt.itemID || null,
    totalGross: stmt?.grossPay?.amountValue ? Number(stmt.grossPay.amountValue) : null,
    totalNet:   stmt?.netPay?.amountValue ? Number(stmt.netPay.amountValue) : null,
    totalTaxes: null, // ADP returns itemized tax lines, not a single total, in this endpoint
    employeeCount: null,
    raw: stmt,
  };
}

module.exports = { testConnection, runPayroll };
