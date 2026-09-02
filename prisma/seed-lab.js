const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const PROJECTS = [
  {
    pillar: 'PREDICTIVE_MAINTENANCE', title: 'Predictive Maintenance — Lab Build',
    clientSiteName: 'TBD — CNC Machining Cell', courseSlug: 'predictive-maintenance', phase: 'MODEL_TRAINING',
    description: 'IIoT sensor onboarding, RUL model training, and the data pipeline behind the Predictive Maintenance pilot.',
    dataSources: [
      { name: 'Line 3 Vibration Sensors (IIoT Gateway)', type: 'IIOT_SENSOR', origin: 'NEW_BUILD', status: 'CONNECTED', recordsIngested: 4820000 },
      { name: 'Line 3 Temperature & Acoustic Array', type: 'IIOT_SENSOR', origin: 'NEW_BUILD', status: 'CONNECTED', recordsIngested: 3140000 },
      { name: 'Plex MES — Work Order History', type: 'MES', origin: 'EXISTING', status: 'CONNECTED', recordsIngested: 218400 },
      { name: 'SAP ERP — Asset Master Data', type: 'ERP', origin: 'EXISTING', status: 'CONNECTING', recordsIngested: 0 },
    ],
    pipelines: [
      { name: 'Raw Sensor Ingestion', stage: 'INGESTION', origin: 'NEW_BUILD', status: 'ACTIVE', recordsProcessed: 4820000 },
      { name: 'Sensor Noise Cleaning', stage: 'CLEANING', origin: 'NEW_BUILD', status: 'ACTIVE', recordsProcessed: 4610000 },
      { name: 'RUL Feature Engineering', stage: 'FEATURE_ENGINEERING', origin: 'NEW_BUILD', status: 'ACTIVE', recordsProcessed: 890000 },
      { name: 'Failure Event Labeling', stage: 'LABELING', origin: 'HYBRID', status: 'DRAFT', recordsProcessed: 0 },
    ],
    datasets: [
      { name: 'RUL Training Set — Bearing Failures', version: 'v3', rowCount: 612000, sizeMb: 840, splitTrainPct: 70, splitValPct: 15, splitTestPct: 15 },
      { name: 'RUL Training Set — Bearing Failures', version: 'v2', rowCount: 480000, sizeMb: 660, splitTrainPct: 70, splitValPct: 15, splitTestPct: 15 },
    ],
    trainingJobs: [
      { modelType: 'TIME_SERIES', baseModel: 'EKF Ensemble', method: 'Ensemble Fit', gpuTier: 'CPU Cluster', status: 'COMPLETED', progressPct: 100, metrics: { rul_mae_hours: 6.2, confidence_avg: 0.91 } },
      { modelType: 'TIME_SERIES', baseModel: 'LSTM', method: 'Supervised Training', gpuTier: 'Flash — Single GPU', status: 'RUNNING', progressPct: 64, metrics: { epoch: 42, loss: 0.083 } },
    ],
    models: [
      { name: 'NexGen Predict — RUL Ensemble', type: 'TIME_SERIES', status: 'PRODUCTION', accuracyPct: 91.4, deployedToPilot: true },
      { name: 'NexGen Predict — LSTM Candidate', type: 'TIME_SERIES', status: 'STAGING', accuracyPct: 87.9, deployedToPilot: false },
    ],
  },
  {
    pillar: 'QUALITY_CONTROL', title: 'Computer Vision QC — Lab Build',
    clientSiteName: 'TBD — Inspection Station', courseSlug: 'vision-qc', phase: 'TRAINING_PIPELINE',
    description: 'Camera calibration, labeled defect datasets, and CNN training behind the Computer Vision QC pilot.',
    dataSources: [
      { name: 'Inspection Station Camera Feed', type: 'VISION_CAMERA', origin: 'NEW_BUILD', status: 'CONNECTED', recordsIngested: 182400 },
      { name: 'Manual Inspection Log (parallel run)', type: 'FILE_UPLOAD', origin: 'EXISTING', status: 'CONNECTED', recordsIngested: 41200 },
    ],
    pipelines: [
      { name: 'Image Ingestion & Calibration Check', stage: 'INGESTION', origin: 'NEW_BUILD', status: 'ACTIVE', recordsProcessed: 182400 },
      { name: 'Defect Labeling Queue', stage: 'LABELING', origin: 'NEW_BUILD', status: 'ACTIVE', recordsProcessed: 38600 },
      { name: 'Augmentation Pipeline', stage: 'TRANSFORMATION', origin: 'NEW_BUILD', status: 'DRAFT', recordsProcessed: 0 },
    ],
    datasets: [
      { name: 'Labeled Defect Set — Cracks/Porosity/Dimensional', version: 'v2', rowCount: 38600, sizeMb: 12400, splitTrainPct: 75, splitValPct: 15, splitTestPct: 10 },
    ],
    trainingJobs: [
      { modelType: 'VISION', baseModel: 'ResNet-50', method: 'Transfer Learning', gpuTier: 'Flash — Single GPU', status: 'COMPLETED', progressPct: 100, metrics: { accuracy: 0.953, false_positive_rate: 0.08 } },
    ],
    models: [
      { name: 'Corverxis Vision — Defect Classifier', type: 'VISION', status: 'STAGING', accuracyPct: 95.3, deployedToPilot: false },
    ],
  },
  {
    pillar: 'SUPPLY_CHAIN', title: 'Supply Chain AI — Lab Build',
    clientSiteName: 'TBD — Critical Material Category', courseSlug: 'supply-chain-ai', phase: 'DATA_INFRASTRUCTURE',
    description: 'ERP consumption data pipeline and demand-forecast model training behind the Supply Chain AI pilot.',
    dataSources: [
      { name: 'SAP ERP — Purchase Order History', type: 'ERP', origin: 'EXISTING', status: 'CONNECTED', recordsIngested: 96400 },
      { name: 'Supplier Portal — Lead Time Feed', type: 'API_FEED', origin: 'NEW_BUILD', status: 'ERROR', recordsIngested: 0 },
    ],
    pipelines: [
      { name: 'Consumption History Ingestion', stage: 'INGESTION', origin: 'HYBRID', status: 'ACTIVE', recordsProcessed: 96400 },
      { name: 'Supplier Reliability Cleaning', stage: 'CLEANING', origin: 'NEW_BUILD', status: 'DRAFT', recordsProcessed: 0 },
    ],
    datasets: [],
    trainingJobs: [],
    models: [],
  },
  {
    pillar: 'PROCESS_OPTIMIZATION', title: 'Process Optimization — Lab Build',
    clientSiteName: 'TBD — CNC Cell / Part Number', courseSlug: 'golden-batch', phase: 'SITE_ONBOARDING',
    description: 'Historical MES data pipeline and Golden Batch parameter-combination model training.',
    dataSources: [
      { name: 'MES Work Order Parameter Log', type: 'MES', origin: 'EXISTING', status: 'CONNECTING', recordsIngested: 0 },
    ],
    pipelines: [],
    datasets: [],
    trainingJobs: [],
    models: [],
  },
];

async function seedLab() {
  const org = await prisma.org.findUnique({ where: { slug: 'corverxis-demo' } });
  if (!org) { console.log('⚠ No demo org found — skipping Lab seed'); return; }

  const existing = await prisma.labProject.count({ where: { orgId: org.id } });
  if (existing > 0) { console.log(`✓ CorverxisLab already seeded (${existing} projects) — skipping`); return; }

  for (const p of PROJECTS) {
    const { dataSources, pipelines, datasets, trainingJobs, models, ...projectData } = p;
    try {
      const project = await prisma.labProject.create({ data: { orgId: org.id, ...projectData } });

      for (const ds of dataSources || []) {
        await prisma.labDataSource.create({ data: { orgId: org.id, projectId: project.id, ...ds, lastSyncAt: ds.status === 'CONNECTED' ? new Date() : null } }).catch(() => {});
      }
      for (const pl of pipelines || []) {
        await prisma.labPipeline.create({ data: { orgId: org.id, projectId: project.id, ...pl, lastRunAt: pl.status === 'ACTIVE' ? new Date() : null } }).catch(() => {});
      }
      const createdDatasets = [];
      for (const d of datasets || []) {
        const row = await prisma.labDataset.create({ data: { orgId: org.id, projectId: project.id, ...d } }).catch(() => null);
        if (row) createdDatasets.push(row);
      }
      for (const tj of trainingJobs || []) {
        const datasetId = createdDatasets.length ? createdDatasets[0].id : null;
        await prisma.labTrainingJob.create({
          data: {
            orgId: org.id, projectId: project.id, datasetId,
            modelType: tj.modelType, baseModel: tj.baseModel, method: tj.method, gpuTier: tj.gpuTier,
            status: tj.status, progressPct: tj.progressPct, metrics: tj.metrics,
            startedAt: tj.status !== 'QUEUED' ? new Date() : null,
            completedAt: tj.status === 'COMPLETED' ? new Date() : null,
          }
        }).catch(() => {});
      }
      for (const m of models || []) {
        const modelRow = await prisma.labModel.create({ data: { orgId: org.id, projectId: project.id, ...m } }).catch(() => null);
        if (modelRow) {
          await prisma.labModelVersion.create({ data: { modelId: modelRow.id, version: modelRow.latestVersion, metrics: { accuracy: m.accuracyPct } } }).catch(() => {});
        }
      }
      console.log(`✓ CorverxisLab: seeded "${project.title}" (${(dataSources||[]).length} sources, ${(pipelines||[]).length} pipelines, ${(datasets||[]).length} datasets, ${(trainingJobs||[]).length} jobs, ${(models||[]).length} models)`);
    } catch (e) {
      console.error(`⚠ CorverxisLab: failed to seed project "${p.title}" (non-fatal):`, e.message);
    }
  }
}

module.exports = { seedLab };

if (require.main === module) {
  seedLab()
    .catch((e) => { console.error('❌ Lab seed failed:', e); process.exit(1); })
    .finally(async () => { await prisma.$disconnect(); });
}
