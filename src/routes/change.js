/**
 * Change Management API Routes
 * ==================================================
 * GET   /api/v1/change/dashboard          → aggregate KPIs
 * GET   /api/v1/change/initiatives        → list rollout initiatives
 * POST  /api/v1/change/initiatives        → create initiative
 * PATCH /api/v1/change/initiatives/:id    → update phase/adoption/sentiment/status
 * GET   /api/v1/change/communications     → communication log
 * POST  /api/v1/change/communications     → log a new communication
 * GET   /api/v1/change/risks              → risk register
 * POST  /api/v1/change/risks              → add risk
 * PATCH /api/v1/change/risks/:id          → update status/mitigation
 */

const express = require('express');
const router  = express.Router();
const { prisma } = require('../prisma');
const { authenticate, requireRole } = require('../middleware/rbac');

// ── DASHBOARD ────────────────────────────────────────────────
router.get('/change/dashboard', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [initiatives, comms, risks, trainingCount] = await Promise.all([
      prisma.changeInitiative.findMany({ where: { orgId } }),
      prisma.changeCommunication.count({ where: { orgId } }),
      prisma.changeRisk.findMany({ where: { orgId } }),
      prisma.hrTraining.count({ where: { orgId, changeTrainingModelId: { not: null } } }),
    ]);

    const avgAdoption  = initiatives.length ? initiatives.reduce((a,i) => a+i.adoptionPct, 0) / initiatives.length : 0;
    const avgSentiment = initiatives.length ? initiatives.reduce((a,i) => a+i.sentimentScore, 0) / initiatives.length : 0;
    const openRisks     = risks.filter(r => r.status !== 'RESOLVED').length;

    res.json({
      data: {
        activeInitiatives: initiatives.filter(i => i.status !== 'COMPLETE').length,
        avgAdoptionPct: Math.round(avgAdoption * 10) / 10,
        avgSentimentScore: Math.round(avgSentiment * 10) / 10,
        openRisks,
        communicationsSent: comms,
        aiTrainingRecords: trainingCount,
        byPhase: {
          DATA_FOUNDATION: initiatives.filter(i => i.phase === 'DATA_FOUNDATION').length,
          PILOT: initiatives.filter(i => i.phase === 'PILOT').length,
          SCALING: initiatives.filter(i => i.phase === 'SCALING').length,
          CONTINUOUS_IMPROVEMENT: initiatives.filter(i => i.phase === 'CONTINUOUS_IMPROVEMENT').length,
        },
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── INITIATIVES ──────────────────────────────────────────────
router.get('/change/initiatives', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { pillar, phase, status } = req.query;
    const where = { orgId };
    if (pillar) where.pillar = pillar;
    if (phase) where.phase = phase;
    if (status) where.status = status;
    const rows = await prisma.changeInitiative.findMany({ where, orderBy: { updatedAt: 'desc' } });
    res.json({ data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/change/initiatives', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const b = req.body;
    const row = await prisma.changeInitiative.create({
      data: {
        orgId, title: b.title, pillar: b.pillar, phase: b.phase || 'DATA_FOUNDATION',
        ownerName: b.ownerName || null, targetDept: b.targetDept || null, linkedModule: b.linkedModule || null,
        description: b.description || null,
        adoptionPct: b.adoptionPct != null ? Number(b.adoptionPct) : 0,
        sentimentScore: b.sentimentScore != null ? Number(b.sentimentScore) : 70,
        status: b.status || 'ON_TRACK',
        targetDate: b.targetDate ? new Date(b.targetDate) : null,
      }
    });
    res.status(201).json({ data: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/change/initiatives/:id', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const b = req.body;
    const data = {};
    ['title','pillar','phase','ownerName','targetDept','linkedModule','description','status'].forEach(k => {
      if (b[k] !== undefined) data[k] = b[k];
    });
    if (b.adoptionPct != null) data.adoptionPct = Number(b.adoptionPct);
    if (b.sentimentScore != null) data.sentimentScore = Number(b.sentimentScore);
    if (b.targetDate) data.targetDate = new Date(b.targetDate);
    const row = await prisma.changeInitiative.update({ where: { id: req.params.id }, data });
    res.json({ data: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── COMMUNICATIONS ───────────────────────────────────────────
router.get('/change/communications', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const rows = await prisma.changeCommunication.findMany({ where: { orgId }, orderBy: { sentAt: 'desc' } });
    res.json({ data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/change/communications', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const b = req.body;
    const row = await prisma.changeCommunication.create({
      data: {
        orgId, initiativeId: b.initiativeId || null, title: b.title,
        audience: b.audience || null, channel: b.channel || null, summary: b.summary || null,
        sentAt: b.sentAt ? new Date(b.sentAt) : new Date(),
      }
    });
    res.status(201).json({ data: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── RISK REGISTER ─────────────────────────────────────────────
router.get('/change/risks', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const rows = await prisma.changeRisk.findMany({ where: { orgId }, orderBy: { updatedAt: 'desc' } });
    res.json({ data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/change/risks', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const b = req.body;
    const row = await prisma.changeRisk.create({
      data: {
        orgId, title: b.title, category: b.category, severity: b.severity || 'MEDIUM',
        mitigation: b.mitigation || null, linkedModule: b.linkedModule || null,
      }
    });
    res.status(201).json({ data: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/change/risks/:id', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const b = req.body;
    const data = {};
    ['status','severity','mitigation','title','linkedModule'].forEach(k => { if (b[k] !== undefined) data[k] = b[k]; });
    const row = await prisma.changeRisk.update({ where: { id: req.params.id }, data });
    res.json({ data: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TRAINING MODELS — structured AI upskilling curricula ──────
const DEFAULT_TRAINING_MODELS = [
  {
    pillar: 'PREDICTIVE_MAINTENANCE', title: 'Predictive Maintenance for Operators',
    description: 'How to read AI-flagged RUL alerts, interpret vibration/temperature trend charts, and escalate before a machine crash — not after.',
    format: 'Hands-On Shadow', durationHours: 3, targetRole: 'Machine Operators, Maintenance Technicians', courseSlug: 'predictive-maintenance',
  },
  {
    pillar: 'QUALITY_CONTROL', title: 'Computer Vision QC Certification',
    description: 'Operating the AI optical inspection stations, understanding pass/fail confidence scores, and handling edge cases the model flags for human review.',
    format: 'Instructor-Led', durationHours: 4, targetRole: 'Quality Inspectors, Line Operators', courseSlug: 'vision-qc',
  },
  {
    pillar: 'SUPPLY_CHAIN', title: 'AI-Assisted Supply & Inventory Planning',
    description: 'Reading AI demand forecasts, adjusting reorder points, and validating model recommendations against supplier lead-time reality.',
    format: 'Self-Paced', durationHours: 2.5, targetRole: 'Supply Chain Analysts, Buyers', courseSlug: 'supply-chain-ai',
  },
  {
    pillar: 'PROCESS_OPTIMIZATION', title: 'Process Data & Golden Batch Analytics',
    description: 'Understanding how the ML model identifies optimal speed/feed/coolant combinations, and how to validate findings on the floor.',
    format: 'Self-Paced', durationHours: 3, targetRole: 'Process Engineers, Line Supervisors', courseSlug: 'golden-batch',
  },
  {
    pillar: 'OTHER', title: 'AI Literacy 101 — Upskilling, Not Replacing',
    description: 'Company-wide foundation course: what AI does and doesn\'t do on the floor, how it makes jobs safer, and how to raise concerns.',
    format: 'Self-Paced', durationHours: 1, targetRole: 'All Employees', courseSlug: 'ai-literacy',
  },
  {
    pillar: 'COMPLIANCE', title: 'IATF 16949 Fundamentals',
    description: 'The automotive quality management standard governing how Corverxis builds precision parts — APQP, PPAP, FMEA, MSA, SPC, and corrective action.',
    format: 'Instructor-Led', durationHours: 4, targetRole: 'All Production & Quality Staff', isRequired: true, courseSlug: 'iatf-16949',
  },
  {
    pillar: 'TECHNICAL', title: 'LLM Fine-Tuning for Manufacturing AI',
    description: 'How Corverxis adapts large language models to manufacturing-specific tasks like NCR drafting and work order summarization.',
    format: 'Self-Paced', durationHours: 5, targetRole: 'Engineering, AI Ops, Quality', courseSlug: 'llm-finetuning',
  },
  {
    pillar: 'OPERATIONS', title: 'Lean Six Sigma Green Belt',
    description: 'Core process-improvement tools — the 8 wastes, DMAIC, basic statistical process control, and running a Kaizen event.',
    format: 'Instructor-Led', durationHours: 6, targetRole: 'Operations, Process Engineering', courseSlug: 'lean-six-sigma',
  },
  {
    pillar: 'LEADERSHIP', title: 'People Management Essentials',
    description: 'Core supervisory skills — setting expectations, giving feedback, difficult conversations, delegation, and psychological safety.',
    format: 'Instructor-Led', durationHours: 5, targetRole: 'Supervisors & Managers', isRequired: true, courseSlug: 'people-management',
  },
  {
    pillar: 'SAFETY', title: 'Workplace Safety & OSHA',
    description: 'OSHA rights and responsibilities, Lockout/Tagout, machine guarding, hazard communication, and incident/near-miss reporting.',
    format: 'Instructor-Led', durationHours: 3, targetRole: 'All Plant Floor Employees', isRequired: true, courseSlug: 'workplace-safety',
  },
  {
    pillar: 'TECHNICAL', title: 'Data-Driven Decision Making',
    description: 'Reading dashboards critically, correlation vs. causation, basic statistical literacy, and making a data-backed proposal.',
    format: 'Self-Paced', durationHours: 3, targetRole: 'Analysts, Supervisors, Engineers', courseSlug: 'data-driven-decisions',
  },
];

// Bypasses the whole build/seed pipeline entirely — creates the default
// training curriculum via a direct authenticated call from the running
// app. Idempotent: safe to click more than once.
router.post('/change/training-models/seed-defaults', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const existing = await prisma.changeTrainingModel.count({ where: { orgId } });
    if (existing > 0) {
      const rows = await prisma.changeTrainingModel.findMany({ where: { orgId } });
      return res.json({ data: rows, created: 0, message: `${existing} training model(s) already exist — nothing new created.` });
    }
    const created = [];
    for (const t of DEFAULT_TRAINING_MODELS) {
      created.push(await prisma.changeTrainingModel.create({ data: { orgId, ...t } }));
    }
    res.status(201).json({ data: created, created: created.length, message: `${created.length} default training models created.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/change/training-models', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const models = await prisma.changeTrainingModel.findMany({
      where: { orgId },
      include: { enrollments: { select: { status: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const data = models.map(m => {
      const total = m.enrollments.length;
      const completed = m.enrollments.filter(e => e.status === 'COMPLETED').length;
      const { enrollments, ...rest } = m;
      return {
        ...rest,
        enrollmentCount: total,
        completedCount: completed,
        completionPct: total ? Math.round((completed / total) * 1000) / 10 : 0,
      };
    });
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/change/training-models', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const b = req.body;
    const row = await prisma.changeTrainingModel.create({
      data: {
        orgId, pillar: b.pillar, title: b.title, description: b.description || null,
        format: b.format || 'Self-Paced', durationHours: b.durationHours != null ? Number(b.durationHours) : 2,
        targetRole: b.targetRole || null, status: b.status || 'ACTIVE',
        isRequired: !!b.isRequired,
      }
    });
    res.status(201).json({ data: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/change/training-models/:id', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const b = req.body;
    const data = {};
    ['title','description','format','targetRole','status','pillar'].forEach(k => { if (b[k] !== undefined) data[k] = b[k]; });
    if (b.durationHours != null) data.durationHours = Number(b.durationHours);
    const row = await prisma.changeTrainingModel.update({ where: { id: req.params.id }, data });
    res.json({ data: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Enroll (assign) an employee into a training model — creates a real
// HrTraining record linked back to the model, so completion tracking
// is genuinely live rather than string-matched.
router.post('/change/training-models/:id/assign', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const model = await prisma.changeTrainingModel.findFirst({ where: { id: req.params.id, orgId } });
    if (!model) return res.status(404).json({ error: 'Training model not found' });
    const { employeeId, dueDate } = req.body;
    if (!employeeId) return res.status(400).json({ error: 'employeeId is required' });

    const row = await prisma.hrTraining.create({
      data: {
        orgId, employeeId, courseName: model.title, provider: 'Corverxis Change Academy',
        changeTrainingModelId: model.id, dueDate: dueDate ? new Date(dueDate) : null, status: 'NOT_STARTED',
      }
    });
    res.status(201).json({ data: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/change/training-models/:id/enrollments', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const rows = await prisma.hrTraining.findMany({
      where: { orgId, changeTrainingModelId: req.params.id },
      include: { employee: { select: { firstName:true, lastName:true, jobTitle:true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
