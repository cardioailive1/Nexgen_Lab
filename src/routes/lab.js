/**
 * CorverxisLab API Routes
 * ==================================================
 * GET   /api/v1/lab/projects                          → all lab projects (one per pilot pillar)
 * POST  /api/v1/lab/projects                           → create a project
 * GET   /api/v1/lab/projects/:id                        → single project with full detail
 * PATCH /api/v1/lab/projects/:id                        → update phase/description
 * POST  /api/v1/lab/projects/seed-defaults               → create the 4 pillar projects (idempotent, live)
 *
 * GET   /api/v1/lab/projects/:id/data-sources            → list
 * POST  /api/v1/lab/projects/:id/data-sources            → add a data source
 * PATCH /api/v1/lab/data-sources/:id                     → update status/records
 *
 * GET   /api/v1/lab/projects/:id/pipelines                → list
 * POST  /api/v1/lab/projects/:id/pipelines                → add a pipeline
 * PATCH /api/v1/lab/pipelines/:id                         → update status/run
 *
 * GET   /api/v1/lab/projects/:id/datasets                 → list
 * POST  /api/v1/lab/projects/:id/datasets                 → register a dataset
 *
 * GET   /api/v1/lab/projects/:id/training-jobs            → list
 * POST  /api/v1/lab/projects/:id/training-jobs            → launch a training job
 * PATCH /api/v1/lab/training-jobs/:id                     → update status/progress/metrics
 *
 * GET   /api/v1/lab/projects/:id/models                   → list
 * POST  /api/v1/lab/projects/:id/models                   → register a model
 * PATCH /api/v1/lab/models/:id                            → update status/deploy flag
 *
 * GET   /api/v1/lab/dashboard                             → org-wide lab KPI rollup
 */

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { prisma } = require('../prisma');
const { authenticate, requireRole } = require('../middleware/rbac');
const { autoNcrFromVisionFail, autoNcrFromSensorCrit, autoScarFromSupplierIssue } = require('../automation');

// Gateway agents authenticate with a bearer API key, not a user session —
// they're machines running on the client's plant network, not logged-in
// people. The raw key is shown exactly once at creation/regeneration and
// only its SHA-256 hash is ever stored, matching how GitHub/Stripe-style
// API tokens work.
// Deployment target and its human label depend on the project's PILLAR,
// not the model's `type` (CLASSICAL_ML is shared by Predictive
// Maintenance and Process Optimization, so type alone is ambiguous).
// Shared by both places models get listed, so the two can't drift apart.
function deploymentInfoFor(model) {
  const pillar = model.project?.pillar;
  const counts = model._count || {};
  if (pillar === 'QUALITY_CONTROL') return { deployedToCount: counts.activeForVisionJobs || 0, deployedToLabel: 'vision job(s)' };
  if (pillar === 'PREDICTIVE_MAINTENANCE') return { deployedToCount: counts.activeForSensors || 0, deployedToLabel: 'sensor(s)' };
  if (pillar === 'PROCESS_OPTIMIZATION') return { deployedToCount: counts.goldenBatchRecommendations || 0, deployedToLabel: 'asset recommendation(s)' };
  if (pillar === 'SUPPLY_CHAIN') return { deployedToCount: counts.demandForecastRecommendations || 0, deployedToLabel: 'item recommendation(s)' };
  return { deployedToCount: 0, deployedToLabel: '' };
}

function generateApiKey() {
  const raw = 'lab_' + crypto.randomBytes(24).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash, last4: raw.slice(-4) };
}
function hashApiKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// ── Default projects: one per pilot pillar, matching the Pilot Studies tab ──
const DEFAULT_PROJECTS = [
  {
    pillar: 'PREDICTIVE_MAINTENANCE', title: 'Predictive Maintenance — Lab Build',
    clientSiteName: 'TBD — CNC Machining Cell', courseSlug: 'predictive-maintenance',
    description: 'IIoT sensor onboarding, RUL model training, and the data pipeline behind the Predictive Maintenance pilot.',
  },
  {
    pillar: 'QUALITY_CONTROL', title: 'Computer Vision QC — Lab Build',
    clientSiteName: 'TBD — Inspection Station', courseSlug: 'vision-qc',
    description: 'Camera calibration, labeled defect datasets, and CNN training behind the Computer Vision QC pilot.',
  },
  {
    pillar: 'SUPPLY_CHAIN', title: 'Supply Chain AI — Lab Build',
    clientSiteName: 'TBD — Critical Material Category', courseSlug: 'supply-chain-ai',
    description: 'ERP consumption data pipeline and demand-forecast model training behind the Supply Chain AI pilot.',
  },
  {
    pillar: 'PROCESS_OPTIMIZATION', title: 'Process Optimization — Lab Build',
    clientSiteName: 'TBD — CNC Cell / Part Number', courseSlug: 'golden-batch',
    description: 'Historical MES data pipeline and Golden Batch parameter-combination model training.',
  },
];

// ── DASHBOARD ────────────────────────────────────────────────
router.get('/lab/dashboard', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [projects, dataSources, pipelines, datasets, jobs, models] = await Promise.all([
      prisma.labProject.findMany({ where: { orgId } }),
      prisma.labDataSource.findMany({ where: { orgId } }),
      prisma.labPipeline.findMany({ where: { orgId } }),
      prisma.labDataset.findMany({ where: { orgId } }),
      prisma.labTrainingJob.findMany({ where: { orgId } }),
      prisma.labModel.findMany({ where: { orgId } }),
    ]);
    res.json({
      data: {
        totalProjects: projects.length,
        connectedSources: dataSources.filter(d => d.status === 'CONNECTED').length,
        totalSources: dataSources.length,
        activePipelines: pipelines.filter(p => p.status === 'ACTIVE').length,
        totalDatasets: datasets.length,
        totalRows: datasets.reduce((a, d) => a + d.rowCount, 0),
        runningJobs: jobs.filter(j => j.status === 'RUNNING').length,
        completedJobs: jobs.filter(j => j.status === 'COMPLETED').length,
        productionModels: models.filter(m => m.status === 'PRODUCTION').length,
        deployedToPilot: models.filter(m => m.deployedToPilot).length,
        infraMix: {
          // The exact "mix of existing infrastructure and starting from
          // scratch" reality — counted across data sources and pipelines.
          existing: dataSources.filter(d => d.origin === 'EXISTING').length + pipelines.filter(p => p.origin === 'EXISTING').length,
          newBuild: dataSources.filter(d => d.origin === 'NEW_BUILD').length + pipelines.filter(p => p.origin === 'NEW_BUILD').length,
          hybrid: dataSources.filter(d => d.origin === 'HYBRID').length + pipelines.filter(p => p.origin === 'HYBRID').length,
        },
        byPhase: {
          SITE_ONBOARDING: projects.filter(p => p.phase === 'SITE_ONBOARDING').length,
          DATA_INFRASTRUCTURE: projects.filter(p => p.phase === 'DATA_INFRASTRUCTURE').length,
          COLLECTION_PROCESSING: projects.filter(p => p.phase === 'COLLECTION_PROCESSING').length,
          TRAINING_PIPELINE: projects.filter(p => p.phase === 'TRAINING_PIPELINE').length,
          MODEL_TRAINING: projects.filter(p => p.phase === 'MODEL_TRAINING').length,
          VALIDATION: projects.filter(p => p.phase === 'VALIDATION').length,
        },
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PROJECTS ─────────────────────────────────────────────────
router.get('/lab/projects', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const projects = await prisma.labProject.findMany({
      where: { orgId },
      include: {
        _count: { select: { dataSources: true, pipelines: true, datasets: true, trainingJobs: true, models: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ data: projects });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/lab/projects/seed-defaults', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const existing = await prisma.labProject.count({ where: { orgId } });
    if (existing > 0) {
      const rows = await prisma.labProject.findMany({ where: { orgId } });
      return res.json({ data: rows, created: 0, message: `${existing} lab project(s) already exist.` });
    }
    const created = [];
    for (const p of DEFAULT_PROJECTS) {
      created.push(await prisma.labProject.create({ data: { orgId, ...p } }));
    }
    res.status(201).json({ data: created, created: created.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/lab/projects', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const b = req.body;
    const row = await prisma.labProject.create({
      data: {
        orgId, title: b.title, pillar: b.pillar, phase: b.phase || 'SITE_ONBOARDING',
        clientSiteName: b.clientSiteName || null, description: b.description || null, courseSlug: b.courseSlug || null,
      }
    });
    res.status(201).json({ data: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/lab/projects/:id', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const project = await prisma.labProject.findFirst({
      where: { id: req.params.id, orgId },
      include: {
        dataSources: { orderBy: { createdAt: 'desc' } },
        pipelines: { orderBy: { createdAt: 'desc' } },
        datasets: { orderBy: { createdAt: 'desc' } },
        trainingJobs: { orderBy: { createdAt: 'desc' }, include: { dataset: { select: { name: true, version: true } } } },
        models: {
          orderBy: { createdAt: 'desc' },
          include: {
            versions: { orderBy: { createdAt: 'desc' }, take: 5 },
            _count: { select: { activeForVisionJobs: true, activeForSensors: true, goldenBatchRecommendations: true, demandForecastRecommendations: true } },
          },
        },
      },
    });
    if (!project) return res.status(404).json({ error: 'Lab project not found' });
    // Flatten the deployment count onto each model — same field the
    // standalone models list endpoint returns, so the frontend has one
    // consistent shape regardless of which endpoint it called.
    project.models = project.models.map(m => ({
      ...m, project: { pillar: project.pillar },
      ...deploymentInfoFor({ ...m, project: { pillar: project.pillar } }),
    }));
    res.json({ data: project });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/lab/projects/:id', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const b = req.body;
    const data = {};
    ['title', 'phase', 'clientSiteName', 'description'].forEach(k => { if (b[k] !== undefined) data[k] = b[k]; });
    const row = await prisma.labProject.update({ where: { id: req.params.id }, data });
    res.json({ data: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DATA SOURCES (site onboarding / integration) ─────────────
router.get('/lab/projects/:id/data-sources', authenticate, async (req, res) => {
  try {
    const rows = await prisma.labDataSource.findMany({ where: { projectId: req.params.id }, orderBy: { createdAt: 'desc' } });
    res.json({ data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/lab/projects/:id/data-sources', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const b = req.body;
    const key = generateApiKey();
    let name = b.name;
    let notes = b.notes || null;

    // If created from a SensorModel catalog entry, inherit its name/notes
    // as sensible defaults rather than starting from a blank config —
    // this is the actual "configure the sensor model" workflow.
    if (b.catalogEntryId) {
      const entry = await prisma.sensorModelCatalogEntry.findUnique({ where: { id: b.catalogEntryId } });
      if (entry) {
        name = name || (entry.vertical + ' — ' + entry.name);
        notes = notes || `Started from SensorModel catalog: ${entry.name} (${entry.vertical}). Reference thresholds — warn ${entry.warnThreshold}${entry.unit}, critical ${entry.critThreshold}${entry.unit}, typical RUL at critical ~${entry.ruLHoursAtCrit}h. ${entry.description}`;
      }
    }
    if (b.visionPartId) {
      const part = await prisma.visionPartCatalogEntry.findUnique({ where: { id: b.visionPartId } });
      if (part) {
        name = name || ('Vision — ' + part.partName);
        notes = notes || `Started from CorverxisVision part catalog: ${part.partName}. Defect types applicable: ${part.applicableDefectTypes.join(', ')}.`;
      }
    }

    // For gateway-type sources, auto-create a real Asset now — this is
    // the actual bridge. Without it, a real gateway agent's pushed data
    // has nowhere in the Sensor/SensorReading tables to land, so it would
    // never surface in SensorModel or the IIoT page, only in CorverxisLab's
    // own ingestion log.
    let linkedAssetId = null;
    // Includes MES now — Process Optimization's parameter-drift data
    // sources (speed/feed/coolant readings from a machining cell) are
    // structurally identical to IIoT sensor readings, and were being
    // silently excluded from the whole Sensor/SensorReading bridge
    // before this, leaving Process Optimization with no real ingest
    // path at all.
    const isGatewayType = ['IIOT_SENSOR', 'SCADA_HISTORIAN', 'MES'].includes(b.type);
    if (isGatewayType) {
      const project = await prisma.labProject.findUnique({ where: { id: req.params.id } });
      const catalogEntry = b.catalogEntryId ? await prisma.sensorModelCatalogEntry.findUnique({ where: { id: b.catalogEntryId } }) : null;
      const asset = await prisma.asset.create({
        data: {
          orgId, name: name || 'Gateway Asset',
          description: `Auto-created for CorverxisLab data source "${name}"`,
          vertical: catalogEntry?.vertical || 'Manufacturing',
          location: project?.clientSiteName || null,
        },
      });
      linkedAssetId = asset.id;
    }

    // Same bridge for VISION_CAMERA sources — auto-create a real VisionJob
    // now, so a real inspection station's pushed results have somewhere
    // real to land (VisionSession/VisionResult), not just CorverxisLab's
    // own ingestion log.
    let linkedVisionJobId = null;
    if (b.type === 'VISION_CAMERA') {
      const visionPart = b.visionPartId ? await prisma.visionPartCatalogEntry.findUnique({ where: { id: b.visionPartId } }) : null;
      const job = await prisma.visionJob.create({
        data: {
          orgId, name: name || 'Vision Inspection Job',
          partNumber: visionPart?.partKey || 'UNSPEC',
        },
      });
      linkedVisionJobId = job.id;
    }

    const row = await prisma.labDataSource.create({
      data: {
        orgId, projectId: req.params.id, name, type: b.type, origin: b.origin || 'NEW_BUILD',
        status: b.status || 'NOT_CONNECTED', notes,
        catalogEntryId: b.catalogEntryId || null,
        visionPartId: b.visionPartId || null,
        linkedAssetId, linkedVisionJobId,
        apiKeyHash: key.hash, apiKeyLast4: key.last4,
      },
      include: { catalogEntry: true, visionPart: true, linkedAsset: true, linkedVisionJob: true },
    });
    // apiKey (raw) is returned ONLY in this response — the server never
    // stores or can retrieve it again. If it's lost, regenerate instead.
    res.status(201).json({ data: row, apiKey: key.raw });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/lab/data-sources/:id/regenerate-key', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const key = generateApiKey();
    const row = await prisma.labDataSource.update({
      where: { id: req.params.id },
      data: { apiKeyHash: key.hash, apiKeyLast4: key.last4 },
    });
    res.json({ data: row, apiKey: key.raw });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Gateway ingestion — machine-to-machine, NOT session-authenticated ──
// This is what a real on-prem agent actually calls. Auth is a bearer
// API key scoped to exactly one data source, not a logged-in user.
router.post('/lab/data-sources/:id/ingest', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const providedKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!providedKey) return res.status(401).json({ error: 'Missing Authorization: Bearer <api key>' });

    const source = await prisma.labDataSource.findUnique({
      where: { id: req.params.id },
      include: { catalogEntry: true },
    });
    if (!source || !source.apiKeyHash) return res.status(404).json({ error: 'Data source not found or has no API key configured' });

    if (hashApiKey(providedKey) !== source.apiKeyHash) {
      return res.status(403).json({ error: 'Invalid API key for this data source' });
    }

    // VISION_CAMERA sources push inspection RESULTS (pass/fail + defect
    // info), not numeric time-series readings — a genuinely different
    // shape from the sensor path below, so it's handled separately and
    // writes to VisionSession/VisionResult instead of Sensor/SensorReading.
    if (source.type === 'VISION_CAMERA' && Array.isArray(req.body?.results)) {
      const results = req.body.results;
      if (!results.length) return res.status(400).json({ error: 'results array is empty' });
      if (!source.linkedVisionJobId) return res.status(400).json({ error: 'This data source has no linked VisionJob — it may have been created before this bridge existed. Recreate it to get one.' });

      let session = await prisma.visionSession.findFirst({
        where: { jobId: source.linkedVisionJobId, endedAt: null },
        orderBy: { startedAt: 'desc' },
      });
      if (!session) {
        session = await prisma.visionSession.create({ data: { jobId: source.linkedVisionJobId } });
      }

      const passCount = results.filter(r => r.result === 'PASS').length;
      const failCount = results.filter(r => r.result === 'FAIL').length;
      const avgCycle = results.reduce((a, r) => a + (r.cycleMs || 0), 0) / results.length;

      await prisma.$transaction([
        prisma.visionResult.createMany({
          data: results.map(r => ({
            sessionId: session.id,
            result: r.result === 'PASS' || r.result === 'FAIL' ? r.result : 'FAIL',
            confidence: typeof r.confidence === 'number' ? r.confidence : 0,
            defectCount: r.defectCount || 0,
            defectTypes: r.defectTypes || [],
            cycleMs: typeof r.cycleMs === 'number' ? r.cycleMs : 0,
            timestamp: r.timestamp ? new Date(r.timestamp) : new Date(),
          })),
        }),
        prisma.visionSession.update({
          where: { id: session.id },
          data: {
            totalCount: { increment: results.length },
            passCount: { increment: passCount },
            failCount: { increment: failCount },
            avgCycleMs: avgCycle, // last-batch average — a real historian would do a proper running average
          },
        }),
        prisma.labIngestionEvent.create({
          data: { dataSourceId: source.id, recordCount: results.length, summary: { pass: passCount, fail: failCount }, sourceIp: req.ip || null },
        }),
        prisma.labDataSource.update({
          where: { id: source.id },
          data: { status: 'CONNECTED', lastSyncAt: new Date(), recordsIngested: { increment: results.length } },
        }),
      ]);

      // Close the actual Quality loop: a real FAIL from a real deployed
      // model should be able to raise a real NCR, not just sit in Lab
      // data waiting for someone to notice. autoNcrFromVisionFail()
      // already existed in automation.js with its own confidence/
      // defect-count threshold logic — it just had never been called
      // from anywhere until now.
      for (const r of results) {
        if (r.result === 'FAIL') {
          await autoNcrFromVisionFail({
            jobId: source.linkedVisionJobId, sessionId: session.id,
            confidence: r.confidence, defectCount: r.defectCount || 0,
            defectTypes: r.defectTypes || [], cycleMs: r.cycleMs || 0,
            orgId: source.orgId,
          });
        }
      }

      return res.status(201).json({ data: { accepted: results.length, sessionId: session.id, pass: passCount, fail: failCount } });
    }

    // SUPPLY_CHAIN sources push supplier reliability/quality EVENTS, not
    // numeric readings or pass/fail results — the third genuinely
    // different payload shape. Suppliers are real named business
    // entities that should already exist (seeded or client-added), so
    // unlike Asset/VisionJob this never auto-creates one — an event for
    // an unrecognized supplier name is skipped, not fabricated into a
    // new record.
    if (Array.isArray(req.body?.supplierEvents)) {
      const events = req.body.supplierEvents;
      if (!events.length) return res.status(400).json({ error: 'supplierEvents array is empty' });

      let scarsRaised = [];
      let matchedCount = 0;
      for (const evt of events) {
        if (!evt || !evt.supplierName) continue;
        const supplier = await prisma.supplier.findFirst({ where: { orgId: source.orgId, name: evt.supplierName } });
        if (!supplier) continue; // unknown supplier name — skipped, not fabricated
        matchedCount++;

        const updateData = {};
        if (typeof evt.otif === 'number') updateData.otif = evt.otif;
        if (typeof evt.qualityPpm === 'number') updateData.qualityPpm = evt.qualityPpm;
        if (typeof evt.score === 'number') updateData.score = evt.score;
        if (Object.keys(updateData).length) {
          await prisma.supplier.update({ where: { id: supplier.id }, data: updateData });
        }

        const raisableEvents = ['LATE_DELIVERY', 'QUALITY_ISSUE'];
        if (raisableEvents.includes(evt.event) && ['MAJOR', 'CRITICAL'].includes((evt.severity || '').toUpperCase())) {
          const scar = await autoScarFromSupplierIssue({
            supplier, event: evt.event, severity: evt.severity, details: evt.details, orgId: source.orgId,
          });
          if (scar) scarsRaised.push(scar.id);
        }
      }

      await prisma.$transaction([
        prisma.labIngestionEvent.create({
          data: { dataSourceId: source.id, recordCount: events.length, summary: { matched: matchedCount, scarsRaised: scarsRaised.length }, sourceIp: req.ip || null },
        }),
        prisma.labDataSource.update({
          where: { id: source.id },
          data: { status: 'CONNECTED', lastSyncAt: new Date(), recordsIngested: { increment: events.length } },
        }),
      ]);

      return res.status(201).json({ data: { accepted: events.length, matched: matchedCount, scarsRaised } });
    }

    const { records, summary } = req.body || {};
    const recordCount = Array.isArray(records) ? records.length : (Number(req.body?.recordCount) || 0);
    if (!recordCount) return res.status(400).json({ error: 'Provide either records (sensor) or results (vision), plus optional summary' });

    // Compute a summary from raw records if the agent sent them and didn't
    // already summarize client-side (either is accepted — summarizing
    // on the agent saves bandwidth for high-frequency sensors).
    let computedSummary = summary || null;
    const byParam = {};
    if (Array.isArray(records) && records.length) {
      for (const r of records) {
        if (!r || typeof r.parameter !== 'string' || typeof r.value !== 'number') continue;
        if (!byParam[r.parameter]) byParam[r.parameter] = [];
        byParam[r.parameter].push(r);
      }
      if (!computedSummary) {
        computedSummary = {};
        for (const [param, entries] of Object.entries(byParam)) {
          const values = entries.map(e => e.value);
          computedSummary[param] = {
            avg: Math.round((values.reduce((a,v)=>a+v,0) / values.length) * 1000) / 1000,
            min: Math.min(...values), max: Math.max(...values), count: values.length,
          };
        }
      }
    }

    // THE BRIDGE: write real SensorReading rows so this data shows up in
    // SensorModel's "Live" group and CorverxisONE's own IIoT page — not
    // just in CorverxisLab's own ingestion log. One Sensor per unique
    // `parameter` channel in the batch (a gateway typically reports
    // several — vibration, temperature, etc. — under one data source).
    let sensorWritesCount = 0;
    if (source.linkedAssetId && Object.keys(byParam).length) {
      for (const [param, entries] of Object.entries(byParam)) {
        let sensor = await prisma.sensor.findFirst({ where: { assetId: source.linkedAssetId, name: param }, include: { asset: true } });
        if (!sensor) {
          const unit = entries[0].unit || (source.catalogEntry?.unit) || '';
          const firstVal = entries[0].value;
          // Use catalog thresholds only if this specific parameter plausibly
          // matches the catalog entry (by name); otherwise a simple
          // heuristic (1.5x / 2.5x the first observed value) beats no
          // threshold at all, and is clearly derived, not asserted as fact.
          const catalogMatches = source.catalogEntry && source.catalogEntry.name.toLowerCase().includes(param.toLowerCase());
          const warn = catalogMatches ? source.catalogEntry.warnThreshold : Math.abs(firstVal) * 1.5;
          const crit = catalogMatches ? source.catalogEntry.critThreshold : Math.abs(firstVal) * 2.5;
          sensor = await prisma.sensor.create({
            data: {
              name: param, type: param, unit, assetId: source.linkedAssetId,
              mlAlgorithm: 'ensemble', thresholds: { warn, crit, baseline: firstVal },
            },
            include: { asset: true },
          });
        }
        const thr = sensor.thresholds || {};
        const readingsWithStatus = entries.map(e => ({
          sensorId: sensor.id, value: e.value,
          status: thr.crit && e.value >= thr.crit ? 'CRITICAL' : thr.warn && e.value >= thr.warn ? 'WARNING' : 'OK',
          timestamp: e.timestamp ? new Date(e.timestamp) : new Date(),
        }));
        await prisma.sensorReading.createMany({ data: readingsWithStatus });
        sensorWritesCount += entries.length;

        // Same Quality-loop closure as the vision path above:
        // autoNcrFromSensorCrit() already existed with its own 4-hour
        // dedup logic (so a noisy sensor doesn't flood NCRs) — it just
        // had never been called from anywhere until now.
        const criticalReading = readingsWithStatus.find(r => r.status === 'CRITICAL');
        if (criticalReading) {
          await autoNcrFromSensorCrit({ sensor, value: criticalReading.value, orgId: source.orgId });
        }
      }
    }

    const [, updated] = await prisma.$transaction([
      prisma.labIngestionEvent.create({
        data: { dataSourceId: source.id, recordCount, summary: computedSummary, sourceIp: req.ip || null },
      }),
      prisma.labDataSource.update({
        where: { id: source.id },
        data: { status: 'CONNECTED', lastSyncAt: new Date(), recordsIngested: { increment: recordCount } },
      }),
    ]);

    res.status(201).json({
      data: {
        accepted: recordCount, totalIngested: updated.recordsIngested, status: updated.status,
        sensorReadingsWritten: sensorWritesCount, // 0 means no linkedAsset — check the data source was created after this bridge was added
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/lab/data-sources/:id/ingestion-events', authenticate, async (req, res) => {
  try {
    const rows = await prisma.labIngestionEvent.findMany({
      where: { dataSourceId: req.params.id },
      orderBy: { receivedAt: 'desc' },
      take: 25,
    });
    res.json({ data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/lab/data-sources/:id', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const b = req.body;
    const data = {};
    ['status', 'name', 'notes', 'origin'].forEach(k => { if (b[k] !== undefined) data[k] = b[k]; });
    if (b.recordsIngested != null) data.recordsIngested = Number(b.recordsIngested);
    if (data.status === 'CONNECTED') data.lastSyncAt = new Date();
    const row = await prisma.labDataSource.update({ where: { id: req.params.id }, data });
    res.json({ data: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PIPELINES (data infrastructure / processing) ─────────────
router.get('/lab/projects/:id/pipelines', authenticate, async (req, res) => {
  try {
    const rows = await prisma.labPipeline.findMany({ where: { projectId: req.params.id }, orderBy: { createdAt: 'desc' } });
    res.json({ data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/lab/projects/:id/pipelines', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const b = req.body;
    const row = await prisma.labPipeline.create({
      data: { orgId, projectId: req.params.id, name: b.name, stage: b.stage, origin: b.origin || 'NEW_BUILD', status: b.status || 'DRAFT' }
    });
    res.status(201).json({ data: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/lab/pipelines/:id', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const b = req.body;
    const data = {};
    ['status', 'name', 'origin'].forEach(k => { if (b[k] !== undefined) data[k] = b[k]; });
    if (b.recordsProcessed != null) data.recordsProcessed = Number(b.recordsProcessed);
    if (data.status === 'ACTIVE') data.lastRunAt = new Date();
    const row = await prisma.labPipeline.update({ where: { id: req.params.id }, data });
    res.json({ data: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DATASETS ─────────────────────────────────────────────────
router.get('/lab/projects/:id/datasets', authenticate, async (req, res) => {
  try {
    const rows = await prisma.labDataset.findMany({ where: { projectId: req.params.id }, orderBy: { createdAt: 'desc' } });
    res.json({ data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/lab/projects/:id/datasets', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const b = req.body;
    const row = await prisma.labDataset.create({
      data: {
        orgId, projectId: req.params.id, name: b.name, version: b.version || 'v1',
        rowCount: b.rowCount != null ? Number(b.rowCount) : 0, sizeMb: b.sizeMb != null ? Number(b.sizeMb) : 0,
        splitTrainPct: b.splitTrainPct != null ? Number(b.splitTrainPct) : 70,
        splitValPct: b.splitValPct != null ? Number(b.splitValPct) : 15,
        splitTestPct: b.splitTestPct != null ? Number(b.splitTestPct) : 15,
      }
    });
    res.status(201).json({ data: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TRAINING JOBS ────────────────────────────────────────────
router.get('/lab/projects/:id/training-jobs', authenticate, async (req, res) => {
  try {
    const rows = await prisma.labTrainingJob.findMany({
      where: { projectId: req.params.id }, orderBy: { createdAt: 'desc' },
      include: { dataset: { select: { name: true, version: true } } },
    });
    res.json({ data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/lab/projects/:id/training-jobs', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const b = req.body;
    const row = await prisma.labTrainingJob.create({
      data: {
        orgId, projectId: req.params.id, datasetId: b.datasetId || null, modelType: b.modelType,
        baseModel: b.baseModel || null, method: b.method || null, gpuTier: b.gpuTier || null,
        status: 'QUEUED',
      }
    });
    res.status(201).json({ data: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/lab/training-jobs/:id', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const b = req.body;
    const data = {};
    ['status', 'baseModel', 'method', 'gpuTier'].forEach(k => { if (b[k] !== undefined) data[k] = b[k]; });
    if (b.progressPct != null) data.progressPct = Number(b.progressPct);
    if (b.metrics !== undefined) data.metrics = b.metrics;
    if (data.status === 'RUNNING' && !data.startedAt) data.startedAt = new Date();
    if (data.status === 'COMPLETED') { data.completedAt = new Date(); data.progressPct = 100; }
    const row = await prisma.labTrainingJob.update({ where: { id: req.params.id }, data });
    res.json({ data: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── MODELS ───────────────────────────────────────────────────
router.get('/lab/projects/:id/models', authenticate, async (req, res) => {
  try {
    const project = await prisma.labProject.findUnique({ where: { id: req.params.id }, select: { pillar: true } });
    const rows = await prisma.labModel.findMany({
      where: { projectId: req.params.id }, orderBy: { createdAt: 'desc' },
      include: {
        versions: { orderBy: { createdAt: 'desc' }, take: 5 },
        _count: { select: { activeForVisionJobs: true, activeForSensors: true, goldenBatchRecommendations: true, demandForecastRecommendations: true } },
      },
    });
    res.json({
      data: rows.map(r => ({
        ...r, project: { pillar: project?.pillar },
        ...deploymentInfoFor({ ...r, project: { pillar: project?.pillar } }),
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/lab/projects/:id/models', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const b = req.body;
    const row = await prisma.labModel.create({
      data: { orgId, projectId: req.params.id, name: b.name, type: b.type, status: b.status || 'DRAFT' }
    });
    await prisma.labModelVersion.create({ data: { modelId: row.id, version: 'v1' } });
    res.status(201).json({ data: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/lab/models/:id', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const b = req.body;
    const data = {};
    ['status', 'name', 'latestVersion'].forEach(k => { if (b[k] !== undefined) data[k] = b[k]; });
    if (b.accuracyPct != null) data.accuracyPct = Number(b.accuracyPct);
    if (b.deployedToPilot != null) data.deployedToPilot = !!b.deployedToPilot;
    const row = await prisma.labModel.update({
      where: { id: req.params.id }, data,
      include: { project: { select: { pillar: true } } },
    });

    // THE ACTUAL DEPLOYMENT: previously "deployedToPilot" was just a flag
    // with no consequence. What "deployment" means is genuinely different
    // per pillar, so this branches on the project's PILLAR — not the
    // model's `type`, which is deliberately generic (CLASSICAL_ML is used
    // by both Predictive Maintenance AND Process Optimization models, so
    // type alone can't distinguish them; branching on type here was a
    // real bug that would have silently routed a deployed Golden Batch
    // model through the sensor-deployment path).
    const pillar = row.project?.pillar;
    let deployedTo = [], deployedToSensorIds = [], deployedToAssetIds = [], deployedToItemIds = [];

    if (b.deployedToPilot === true && pillar === 'QUALITY_CONTROL') {
      const sources = await prisma.labDataSource.findMany({
        where: { projectId: row.projectId, linkedVisionJobId: { not: null } },
        select: { linkedVisionJobId: true },
      });
      const jobIds = [...new Set(sources.map(s => s.linkedVisionJobId))];
      for (const jobId of jobIds) {
        await prisma.visionJob.update({ where: { id: jobId }, data: { activeModelId: row.id } });
      }
      deployedTo = jobIds;
    }

    // Predictive Maintenance deployment target is per-SENSOR, not a single
    // job-level target like Vision — a PM model (e.g. an RUL ensemble)
    // typically applies across every sensor on the assets this project's
    // data sources are linked to, and each sensor has its own independent
    // prediction, so each needs its own activeModelId.
    if (b.deployedToPilot === true && pillar === 'PREDICTIVE_MAINTENANCE') {
      const sources = await prisma.labDataSource.findMany({
        where: { projectId: row.projectId, linkedAssetId: { not: null } },
        select: { linkedAssetId: true },
      });
      const assetIds = [...new Set(sources.map(s => s.linkedAssetId))];
      if (assetIds.length) {
        const sensors = await prisma.sensor.findMany({ where: { assetId: { in: assetIds } }, select: { id: true } });
        const sensorIds = sensors.map(s => s.id);
        if (sensorIds.length) {
          await prisma.sensor.updateMany({ where: { id: { in: sensorIds } }, data: { activeModelId: row.id } });
        }
        deployedToSensorIds = sensorIds;
      }
    }

    // Process Optimization doesn't produce a continuous reading — it
    // produces a discrete parameter recommendation ("run this part at
    // this speed/feed/coolant combination"). Deployment creates a
    // PENDING_TRIAL recommendation on each linked Asset, never touching
    // any live production parameter directly — matching the pilot
    // study's own rule that this is "a recommendation to trial, never
    // an automatic change." The actual recommended values, if supplied
    // at deploy time, come from req.body — nothing here fabricates
    // numbers the model hasn't actually produced.
    if (b.deployedToPilot === true && pillar === 'PROCESS_OPTIMIZATION') {
      const sources = await prisma.labDataSource.findMany({
        where: { projectId: row.projectId, linkedAssetId: { not: null } },
        select: { linkedAssetId: true },
      });
      const assetIds = [...new Set(sources.map(s => s.linkedAssetId))];
      for (const assetId of assetIds) {
        const rec = await prisma.goldenBatchRecommendation.create({
          data: {
            orgId: row.orgId, assetId, modelId: row.id,
            partNumber: b.partNumber || null,
            recommendedParams: b.recommendedParams || null,
            predictedImprovement: b.predictedImprovement || null,
            status: 'PENDING_TRIAL',
            statusHistory: [{ status: 'PENDING_TRIAL', notes: 'Created from model deployment', changedAt: new Date().toISOString(), changedBy: req.user.name || req.user.email || 'unknown' }],
          },
        });
        deployedToAssetIds.push(rec.assetId);
      }
    }

    // Supply Chain doesn't produce a continuous reading or a per-asset
    // recommendation — it produces a reorder-point/safety-stock
    // suggestion for a specific inventory item. Same rule: creates a
    // PENDING_REVIEW recommendation, never writes InventoryItem's live
    // reorderPoint/safetyStock fields directly. Requires an explicit
    // inventoryItemIds list in the request — unlike Vision/PM/Process
    // Opt, Supply Chain's LabDataSource has no linkedInventoryItemId
    // bridge (a data source represents a supplier feed, not one item),
    // so which items this forecast actually applies to has to be stated.
    if (b.deployedToPilot === true && pillar === 'SUPPLY_CHAIN' && Array.isArray(b.inventoryItemIds)) {
      for (const itemId of b.inventoryItemIds) {
        const item = await prisma.inventoryItem.findFirst({ where: { id: itemId, orgId: row.orgId } });
        if (!item) continue; // skip items that don't belong to this org rather than fail the whole batch
        const rec = await prisma.demandForecastRecommendation.create({
          data: {
            orgId: row.orgId, inventoryItemId: item.id, modelId: row.id,
            recommendedReorderPoint: b.recommendedReorderPoint != null ? Number(b.recommendedReorderPoint) : null,
            recommendedSafetyStock: b.recommendedSafetyStock != null ? Number(b.recommendedSafetyStock) : null,
            forecastBasis: b.forecastBasis || null,
            status: 'PENDING_REVIEW',
            statusHistory: [{ status: 'PENDING_REVIEW', notes: 'Created from model deployment', changedAt: new Date().toISOString(), changedBy: req.user.name || req.user.email || 'unknown' }],
          },
        });
        deployedToItemIds.push(rec.inventoryItemId);
      }
    }

    res.json({
      data: row, deployedToVisionJobs: deployedTo, deployedToSensors: deployedToSensorIds,
      deployedToAssets: deployedToAssetIds, deployedToInventoryItems: deployedToItemIds,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GOLDEN BATCH RECOMMENDATIONS (Process Optimization deployment) ──
router.get('/lab/golden-batch-recommendations', authenticate, async (req, res) => {
  try {
    const rows = await prisma.goldenBatchRecommendation.findMany({
      where: { orgId: req.user.orgId },
      orderBy: { createdAt: 'desc' },
      include: { asset: { select: { name: true, location: true } }, model: { select: { name: true, latestVersion: true, accuracyPct: true } } },
    });
    res.json({ data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/lab/golden-batch-recommendations/:id', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const b = req.body;
    const existing = await prisma.goldenBatchRecommendation.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Recommendation not found' });

    const data = {};
    if (b.status && ['PENDING_TRIAL', 'VALIDATED', 'REJECTED'].includes(b.status)) data.status = b.status;
    if (b.trialNotes !== undefined) data.trialNotes = b.trialNotes;

    // Append to the audit trail rather than just overwriting status/notes —
    // this is the actual "history" a process engineer would want to see:
    // every decision made on this recommendation, not just the latest one.
    if (data.status || data.trialNotes !== undefined) {
      data.statusHistory = [
        ...(existing.statusHistory || []),
        { status: data.status || existing.status, notes: data.trialNotes ?? existing.trialNotes ?? null, changedAt: new Date().toISOString(), changedBy: req.user.name || req.user.email || 'unknown' },
      ];
    }

    const row = await prisma.goldenBatchRecommendation.update({ where: { id: req.params.id }, data });
    res.json({ data: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DEMAND FORECAST RECOMMENDATIONS (Supply Chain deployment) ───────
router.get('/lab/demand-forecast-recommendations', authenticate, async (req, res) => {
  try {
    const rows = await prisma.demandForecastRecommendation.findMany({
      where: { orgId: req.user.orgId },
      orderBy: { createdAt: 'desc' },
      include: { inventoryItem: { select: { partNumber: true, description: true, reorderPoint: true, safetyStock: true } }, model: { select: { name: true, latestVersion: true, accuracyPct: true } } },
    });
    res.json({ data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/lab/demand-forecast-recommendations/:id', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const b = req.body;
    const existing = await prisma.demandForecastRecommendation.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Recommendation not found' });

    const data = {};
    if (b.status && ['PENDING_REVIEW', 'ACCEPTED', 'OVERRIDDEN'].includes(b.status)) data.status = b.status;
    if (b.buyerNotes !== undefined) data.buyerNotes = b.buyerNotes;

    if (data.status || data.buyerNotes !== undefined) {
      data.statusHistory = [
        ...(existing.statusHistory || []),
        { status: data.status || existing.status, notes: data.buyerNotes ?? existing.buyerNotes ?? null, changedAt: new Date().toISOString(), changedBy: req.user.name || req.user.email || 'unknown' },
      ];
    }

    const row = await prisma.demandForecastRecommendation.update({ where: { id: req.params.id }, data });
    res.json({ data: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
