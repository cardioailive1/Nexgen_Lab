const gusto  = require('./gusto');
const adp    = require('./adp');
const intuit = require('./intuit');

const CONNECTORS = { GUSTO: gusto, ADP: adp, INTUIT: intuit };

const PROVIDER_META = {
  NATIVE: { name: 'Corverxis Native', credentialFields: [] },
  GUSTO:  { name: 'Gusto',            credentialFields: ['accessToken', 'env'] },
  ADP:    { name: 'ADP Workforce Now',credentialFields: ['clientId', 'clientSecret', 'orgOid'] },
  INTUIT: { name: 'QuickBooks Payroll (Intuit)', credentialFields: ['accessToken', 'realmId', 'env'] },
};

function getConnector(provider) {
  const c = CONNECTORS[provider];
  if (!c) throw new Error(`Unknown or unsupported payroll provider: ${provider}`);
  return c;
}

module.exports = { getConnector, PROVIDER_META, CONNECTORS };
