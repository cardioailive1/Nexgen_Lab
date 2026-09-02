/**
 * Org Bootstrap
 * ==================================================
 * A brand-new org created via /api/register starts completely empty —
 * no departments, no training models, no change initiatives, no lab
 * projects. Each module has its own live "seed-defaults" endpoint
 * (built for exactly this kind of recovery), but nothing orchestrates
 * calling all of them for a newly provisioned client. This does.
 *
 * POST /api/v1/onboarding/bootstrap  → run every module's defaults for
 *                                       the caller's org, idempotently
 * GET  /api/v1/onboarding/checklist  → what's set up vs. still empty
 */

const express = require('express');
const router  = express.Router();
const { prisma } = require('../prisma');
const { authenticate, requireRole } = require('../middleware/rbac');

const DEFAULT_DEPARTMENTS = [
  { name:'Manufacturing Ops',            budgetAnnual: 8400000, costCenter:'CC-100' },
  { name:'Quality Engineering',          budgetAnnual: 2100000, costCenter:'CC-110' },
  { name:'Supply Chain',                 budgetAnnual: 1600000, costCenter:'CC-120' },
  { name:'R&D / AI Engineering',         budgetAnnual: 5200000, costCenter:'CC-130' },
  { name:'Finance',                      budgetAnnual: 1200000, costCenter:'CC-140' },
  { name:'Sales & Customer Success',     budgetAnnual: 1900000, costCenter:'CC-150' },
  { name:'IT / Platform',                budgetAnnual: 1500000, costCenter:'CC-160' },
  { name:'People & Talent',              budgetAnnual: 850000,  costCenter:'CC-170' },
  { name:'Executive',                    budgetAnnual: 2600000, costCenter:'CC-180' },
];

const DEFAULT_INITIATIVES = [
  { title: 'Predictive Maintenance Rollout — CNC & Robotic Cells', pillar: 'PREDICTIVE_MAINTENANCE', phase: 'DATA_FOUNDATION', ownerName: 'VP Manufacturing', targetDept: 'Manufacturing Ops', linkedModule: 'pred', description: 'IoT-sensor-driven vibration, temperature, and acoustic monitoring to predict tool wear and machine failure before it happens.', adoptionPct: 0, sentimentScore: 70, status: 'ON_TRACK' },
  { title: 'AI-Powered Optical Inspection — Computer Vision QC', pillar: 'QUALITY_CONTROL', phase: 'DATA_FOUNDATION', ownerName: 'Quality Director', targetDept: 'Quality Engineering', linkedModule: 'vision', description: 'AI-powered optical inspection to catch micro-defects that traditional gauges or the human eye miss.', adoptionPct: 0, sentimentScore: 70, status: 'ON_TRACK' },
  { title: 'AI-Driven Supply Chain & Inventory Optimization', pillar: 'SUPPLY_CHAIN', phase: 'DATA_FOUNDATION', ownerName: 'Supply Chain Manager', targetDept: 'Supply Chain', linkedModule: 'supply', description: 'Demand-pattern and lead-time analysis to improve inventory management and reduce carrying costs.', adoptionPct: 0, sentimentScore: 70, status: 'ON_TRACK' },
  { title: '"Golden Batch" Process Optimization', pillar: 'PROCESS_OPTIMIZATION', phase: 'DATA_FOUNDATION', ownerName: 'Process Engineering Lead', targetDept: 'Manufacturing Ops', linkedModule: 'pia', description: 'ML analysis of historical production data to identify the optimal speed/feed/coolant combination.', adoptionPct: 0, sentimentScore: 65, status: 'ON_TRACK' },
];

const DEFAULT_RISKS = [
  { title: 'Data Silos — legacy MES not fully integrated with ERP', category: 'DATA_SILOS', severity: 'HIGH', mitigation: 'Complete ERP↔MES integration via ERP Integration Hub before scaling further pilots.', linkedModule: 'erp' },
  { title: 'Expanded attack surface from shop-floor network connectivity', category: 'CYBERSECURITY', severity: 'HIGH', mitigation: 'Segment OT network from IT network; enforce least-privilege access for sensor gateways.', linkedModule: 'aiops' },
  { title: 'Skill gap — limited in-house ML/data analyst capacity', category: 'SKILL_GAP', severity: 'MEDIUM', mitigation: 'Partner with external AI consultants short-term; hire data analysts with manufacturing OT background.', linkedModule: 'hrim' },
  { title: 'Shop-floor resistance — fear that AI signals future layoffs', category: 'RESISTANCE', severity: 'MEDIUM', mitigation: 'Reframe as upskilling, not replacement; involve operators directly in AI system design.', linkedModule: 'hrim' },
];

const DEFAULT_LAB_PROJECTS = [
  { pillar: 'PREDICTIVE_MAINTENANCE', title: 'Predictive Maintenance — Lab Build', clientSiteName: null, courseSlug: 'predictive-maintenance', description: 'IIoT sensor onboarding, RUL model training, and the data pipeline behind the Predictive Maintenance pilot.' },
  { pillar: 'QUALITY_CONTROL', title: 'Computer Vision QC — Lab Build', clientSiteName: null, courseSlug: 'vision-qc', description: 'Camera calibration, labeled defect datasets, and CNN training behind the Computer Vision QC pilot.' },
  { pillar: 'SUPPLY_CHAIN', title: 'Supply Chain AI — Lab Build', clientSiteName: null, courseSlug: 'supply-chain-ai', description: 'ERP consumption data pipeline and demand-forecast model training behind the Supply Chain AI pilot.' },
  { pillar: 'PROCESS_OPTIMIZATION', title: 'Process Optimization — Lab Build', clientSiteName: null, courseSlug: 'golden-batch', description: 'Historical MES data pipeline and Golden Batch parameter-combination model training.' },
];

async function bootstrapOrg(orgId, opts = {}) {
  const results = {};

  // Which SensorModel verticals this client actually operates in. Default
  // to Manufacturing + Industrial Automation — the two relevant to a
  // precision machining client — rather than assuming all 18 apply.
  // Set explicitly via opts.verticals to onboard a different kind of client.
  const verticals = opts.verticals && opts.verticals.length ? opts.verticals : ['Manufacturing', 'Industrial Automation'];

  try {
    const org = await prisma.org.findUnique({ where: { id: orgId }, select: { activeVerticals: true } });
    if (org && (!org.activeVerticals || org.activeVerticals.length === 0)) {
      await prisma.org.update({ where: { id: orgId }, data: { activeVerticals: verticals } });
      results.verticals = { set: verticals };
    } else {
      results.verticals = { alreadySet: org?.activeVerticals || [] };
    }
  } catch (e) { results.verticals = { error: e.message }; }

  try {
    const c = await prisma.productionLine.count({ where: { orgId } });
    if (c === 0) {
      const line = await prisma.productionLine.create({ data: { orgId, name: 'Line 1', description: 'Default starter production line — rename or add more as needed', location: 'Main Floor', active: true } });
      // Seed one starter Asset per selected vertical, with Sensors pulled
      // directly from the SensorModel catalog for that vertical — this is
      // the concrete "only configure what this client actually uses" path.
      let assetCount = 0, sensorCount = 0;
      for (const vertical of verticals) {
        const catalogSensors = await prisma.sensorModelCatalogEntry.findMany({ where: { vertical }, take: 4 });
        if (!catalogSensors.length) continue;
        const asset = await prisma.asset.create({ data: { orgId, name: `${vertical} Cell 1`, description: `Starter asset for the ${vertical} vertical`, vertical, location: 'Main Floor' } });
        assetCount++;
        for (const cs of catalogSensors) {
          await prisma.sensor.create({
            data: {
              name: cs.name, type: cs.freqCategory, unit: cs.unit, assetId: asset.id,
              mlAlgorithm: 'ensemble',
              thresholds: { warn: cs.warnThreshold, crit: cs.critThreshold, baseline: cs.baselineValue },
            },
          }).catch(() => {});
          sensorCount++;
        }
      }
      results.productionLines = { created: 1 };
      results.assets = { created: assetCount };
      results.sensors = { created: sensorCount };
    } else {
      results.productionLines = { skipped: c };
    }
  } catch (e) { results.productionLines = { error: e.message }; }

  try {
    const c = await prisma.supplier.count({ where: { orgId } });
    if (c === 0) {
      const starters = [
        { name: 'Starter Alloy Supply Co.', category: 'Raw Material', rating: 'APPROVED', country: 'USA', currency: 'USD' },
        { name: 'Starter Precision Tooling Ltd.', category: 'Tooling', rating: 'APPROVED', country: 'USA', currency: 'USD' },
      ];
      for (const s of starters) await prisma.supplier.create({ data: { orgId, ...s } });
      results.suppliers = { created: starters.length };
    } else {
      results.suppliers = { skipped: c };
    }
  } catch (e) { results.suppliers = { error: e.message }; }

  try {
    const c = await prisma.hrDepartment.count({ where: { orgId } });
    if (c === 0) {
      for (const d of DEFAULT_DEPARTMENTS) await prisma.hrDepartment.create({ data: { orgId, ...d } });
      results.departments = { created: DEFAULT_DEPARTMENTS.length };
    } else results.departments = { skipped: c };
  } catch (e) { results.departments = { error: e.message }; }

  try {
    const c = await prisma.changeInitiative.count({ where: { orgId } });
    if (c === 0) {
      for (const i of DEFAULT_INITIATIVES) await prisma.changeInitiative.create({ data: { orgId, ...i } });
      results.initiatives = { created: DEFAULT_INITIATIVES.length };
    } else results.initiatives = { skipped: c };
  } catch (e) { results.initiatives = { error: e.message }; }

  try {
    const c = await prisma.changeRisk.count({ where: { orgId } });
    if (c === 0) {
      for (const r of DEFAULT_RISKS) await prisma.changeRisk.create({ data: { orgId, ...r } });
      results.risks = { created: DEFAULT_RISKS.length };
    } else results.risks = { skipped: c };
  } catch (e) { results.risks = { error: e.message }; }

  try {
    const c = await prisma.labProject.count({ where: { orgId } });
    if (c === 0) {
      for (const p of DEFAULT_LAB_PROJECTS) await prisma.labProject.create({ data: { orgId, ...p } });
      results.labProjects = { created: DEFAULT_LAB_PROJECTS.length };
    } else results.labProjects = { skipped: c };
  } catch (e) { results.labProjects = { error: e.message }; }

  return results;
}

router.post('/onboarding/bootstrap', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    const results = await bootstrapOrg(req.user.orgId, { verticals: req.body?.verticals });
    res.status(201).json({ data: results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/onboarding/checklist', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [depts, initiatives, risks, labProjects, employees] = await Promise.all([
      prisma.hrDepartment.count({ where: { orgId } }),
      prisma.changeInitiative.count({ where: { orgId } }),
      prisma.changeRisk.count({ where: { orgId } }),
      prisma.labProject.count({ where: { orgId } }),
      prisma.hrEmployee.count({ where: { orgId } }).catch(() => 0),
    ]);
    res.json({
      data: {
        departments: depts, initiatives, risks, labProjects, employees,
        complete: depts > 0 && initiatives > 0 && risks > 0 && labProjects > 0,
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router, bootstrapOrg };
