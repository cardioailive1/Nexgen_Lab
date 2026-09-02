/**
 * Process Improvement & Automation API Routes
 * ============================================
 * GET  /api/v1/improvement              → list all projects with KPIs
 * GET  /api/v1/improvement/:id          → single project with kaizen + wastes
 * POST /api/v1/improvement              → create project (manual or auto)
 * PATCH /api/v1/improvement/:id         → update project / close with results
 * DELETE /api/v1/improvement/:id        → cancel project
 *
 * GET  /api/v1/improvement/:id/kaizen   → kaizen events for project
 * POST /api/v1/improvement/:id/kaizen   → add kaizen event
 * PATCH /api/v1/improvement/:id/kaizen/:eid → update kaizen event
 *
 * POST /api/v1/improvement/:id/waste    → log waste reduction measurement
 *
 * GET  /api/v1/lines/:id/improvements   → all improvement projects for a line
 * GET  /api/v1/improvement/summary      → dashboard KPIs
 *
 * Auto-triggers (called internally):
 *   autoProjectFromAlert()  — critical sensor alert → auto project
 *   autoProjectFromNCR()    — NCR opened → auto DMAIC project
 */

const express    = require('express');
const router     = express.Router();
const { prisma } = require('../prisma');
const { authenticate, requireRole } = require('../middleware/rbac');
const { nextSequence } = require('../automation');

// ── Summary KPIs ─────────────────────────────────────────────
router.get('/improvement/summary', authenticate, requireRole('TECHNICIAN'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [active, closed, kaizen, savings] = await Promise.all([
      prisma.improvementProject.count({ where: { orgId, status: { in: ['OPEN','IN_PROGRESS'] } } }),
      prisma.improvementProject.count({ where: { orgId, status: 'CLOSED' } }),
      prisma.kaizenEvent.count({ where: { project: { orgId }, status: 'ACTIVE' } }),
      prisma.improvementProject.aggregate({
        where:  { orgId, status: 'CLOSED' },
        _sum:   { actualSaving: true, savingPerMonth: true },
      }),
    ]);
    const projects = await prisma.improvementProject.findMany({
      where: { orgId, status: { in: ['OPEN','IN_PROGRESS'] } },
      select: { type: true },
    });
    const byType = {};
    projects.forEach(p => { byType[p.type] = (byType[p.type]||0) + 1; });

    res.json({
      active, closed,
      activeKaizen:    kaizen,
      monthlySaving:   savings._sum.savingPerMonth || 0,
      actualSaving:    savings._sum.actualSaving   || 0,
      byType,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── List projects ─────────────────────────────────────────────
router.get('/improvement', authenticate, requireRole('TECHNICIAN'), async (req, res) => {
  try {
    const { status, type, lineId, limit = 50 } = req.query;
    const where = { orgId: req.user.orgId };
    if (status) where.status = status;
    if (type)   where.type   = type;
    if (lineId) where.lineId = lineId;

    const projects = await prisma.improvementProject.findMany({
      where,
      include: {
        line:         { select: { id: true, name: true } },
        kaizenEvents: { select: { id: true, status: true } },
        wastes:       { select: { wasteType: true, currentPct: true, targetPct: true } },
        _count:       { select: { kaizenEvents: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit),
    });

    res.json({ data: projects, count: projects.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Single project ────────────────────────────────────────────
router.get('/improvement/:id', authenticate, requireRole('TECHNICIAN'), async (req, res) => {
  try {
    const project = await prisma.improvementProject.findUnique({
      where:   { id: req.params.id },
      include: {
        line:         true,
        kaizenEvents: { orderBy: { week: 'asc' } },
        wastes:       true,
      },
    });
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json({ data: project });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Create project ────────────────────────────────────────────
router.post('/improvement', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const {
      title, type = 'KAIZEN', lineId, department, champion,
      description, problem, currentState, targetState,
      savingPerMonth = 0, priority = 3, startDate, targetDate,
      oeeBeforeStr, cycleTimeBefore, scrapBefore,
      sigmaLevel, sigmaTarget, dmaicPhase,
      teamSize = 1, autoRaised = false, autoSource,
    } = req.body;

    if (!title) return res.status(400).json({ error: 'title required' });

    const number = await nextSequence(req.user.orgId, 'improvement', 'PI');

    const project = await prisma.improvementProject.create({
      data: {
        orgId:          req.user.orgId,
        number,
        title,
        type,
        status:         'OPEN',
        lineId:         lineId || null,
        department:     department || null,
        champion:       champion || null,
        teamSize:       parseInt(teamSize),
        description:    description || null,
        problem:        problem || null,
        currentState:   currentState || null,
        targetState:    targetState || null,
        savingPerMonth: parseFloat(savingPerMonth),
        priority:       parseInt(priority),
        startDate:      startDate  ? new Date(startDate)  : new Date(),
        targetDate:     targetDate ? new Date(targetDate) : null,
        oeeBeforeStr:   oeeBeforeStr || null,
        cycleTimeBefore: cycleTimeBefore ? parseFloat(cycleTimeBefore) : null,
        scrapBefore:    scrapBefore ? parseFloat(scrapBefore) : null,
        sigmaLevel:     sigmaLevel  ? parseFloat(sigmaLevel)  : null,
        sigmaTarget:    sigmaTarget ? parseFloat(sigmaTarget) : null,
        dmaicPhase:     dmaicPhase || (type === 'DMAIC' ? 'Define' : null),
        autoRaised:     !!autoRaised,
        autoSource:     autoSource || null,
      },
      include: { line: { select: { name: true } } },
    });

    // Auto-seed 8 waste types for LEAN / KAIZEN projects
    if (['KAIZEN','LEAN'].includes(type)) {
      const WASTES = ['DEFECTS','OVERPRODUCTION','WAITING','NON_UTILISED_TALENT',
                      'TRANSPORTATION','INVENTORY','MOTION','EXTRA_PROCESSING'];
      await prisma.wasteReduction.createMany({
        data: WASTES.map(w => ({
          projectId:   project.id,
          wasteType:   w,
          baselinePct: 0,
          currentPct:  0,
          targetPct:   20,
        })),
      }).catch(() => {});
    }

    await prisma.auditLog.create({
      data: { userId: req.user.id, orgId: req.user.orgId,
              action: 'improvement.created', resource: 'improvement_project',
              resourceId: project.id, outcome: 'success',
              metadata: { number, title, type, lineId } },
    }).catch(() => {});

    res.status(201).json({ success: true, data: project });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Update project ────────────────────────────────────────────
router.patch('/improvement/:id', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const allowed = [
      'title','status','type','lineId','department','champion','teamSize',
      'description','problem','currentState','targetState','savingPerMonth',
      'actualSaving','priority','targetDate','closedAt','dmaicPhase',
      'sigmaLevel','sigmaTarget','oeeBeforeStr','oeeAfterStr',
      'cycleTimeBefore','cycleTimeAfter','scrapBefore','scrapAfter',
    ];
    const data = {};
    allowed.forEach(k => {
      if (req.body[k] !== undefined) {
        if (['savingPerMonth','actualSaving','sigmaLevel','sigmaTarget',
             'cycleTimeBefore','cycleTimeAfter','scrapBefore','scrapAfter'].includes(k)) {
          data[k] = parseFloat(req.body[k]);
        } else if (['teamSize','priority'].includes(k)) {
          data[k] = parseInt(req.body[k]);
        } else if (['targetDate','closedAt'].includes(k)) {
          data[k] = req.body[k] ? new Date(req.body[k]) : null;
        } else {
          data[k] = req.body[k];
        }
      }
    });

    // Auto-set closedAt when status set to CLOSED
    if (data.status === 'CLOSED' && !data.closedAt) data.closedAt = new Date();

    const project = await prisma.improvementProject.update({
      where:   { id: req.params.id },
      data,
      include: { line: { select: { name: true } }, kaizenEvents: true, wastes: true },
    });
    res.json({ success: true, data: project });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Delete/cancel project ─────────────────────────────────────
router.delete('/improvement/:id', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    await prisma.improvementProject.update({
      where: { id: req.params.id },
      data:  { status: 'CANCELLED' },
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Kaizen events ─────────────────────────────────────────────
router.get('/improvement/:id/kaizen', authenticate, requireRole('TECHNICIAN'), async (req, res) => {
  try {
    const events = await prisma.kaizenEvent.findMany({
      where:   { projectId: req.params.id },
      include: { line: { select: { name: true } } },
      orderBy: { week: 'asc' },
    });
    res.json({ data: events });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/improvement/:id/kaizen', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const {
      title, description, lineId, week = 1, totalWeeks = 4,
      teamSize = 4, teamMembers, currentMetric, targetMetric,
      metricUnit, dueAt, findings, actions,
    } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });

    const event = await prisma.kaizenEvent.create({
      data: {
        projectId:     req.params.id,
        lineId:        lineId || null,
        title, description: description || null,
        week: parseInt(week), totalWeeks: parseInt(totalWeeks),
        teamSize: parseInt(teamSize), teamMembers: teamMembers || null,
        currentMetric: currentMetric ? parseFloat(currentMetric) : null,
        targetMetric:  targetMetric  ? parseFloat(targetMetric)  : null,
        metricUnit:    metricUnit    || null,
        dueAt:         dueAt ? new Date(dueAt) : null,
        findings:      findings || null,
        actions:       actions  || null,
        status:        'ACTIVE',
      },
    });
    // Update project status to IN_PROGRESS
    await prisma.improvementProject.update({
      where: { id: req.params.id },
      data:  { status: 'IN_PROGRESS' },
    }).catch(() => {});
    res.status(201).json({ success: true, data: event });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/improvement/:id/kaizen/:eid', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const allowed = ['title','description','status','findings','actions',
                     'currentMetric','targetMetric','teamMembers','closedAt'];
    const data = {};
    allowed.forEach(k => {
      if (req.body[k] !== undefined) data[k] = req.body[k];
    });
    if (data.status === 'CLOSED' && !data.closedAt) data.closedAt = new Date();
    if (data.currentMetric) data.currentMetric = parseFloat(data.currentMetric);
    if (data.targetMetric)  data.targetMetric  = parseFloat(data.targetMetric);

    const event = await prisma.kaizenEvent.update({
      where: { id: req.params.eid }, data,
    });
    res.json({ success: true, data: event });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Waste reduction measurement ────────────────────────────────
router.post('/improvement/:id/waste', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const { wasteType, currentPct, targetPct, notes } = req.body;
    if (!wasteType || currentPct === undefined) {
      return res.status(400).json({ error: 'wasteType and currentPct required' });
    }
    // Upsert so each project has one record per waste type
    const waste = await prisma.wasteReduction.upsert({
      where: {
        id: (await prisma.wasteReduction.findFirst({
          where: { projectId: req.params.id, wasteType },
          select: { id: true },
        }))?.id || 'new',
      },
      update: { currentPct: parseFloat(currentPct), targetPct: targetPct ? parseFloat(targetPct) : undefined, notes, measuredAt: new Date() },
      create: { projectId: req.params.id, wasteType, currentPct: parseFloat(currentPct), targetPct: parseFloat(targetPct||20), notes },
    });
    res.json({ success: true, data: waste });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Line improvements ─────────────────────────────────────────
router.get('/lines/:id/improvements', authenticate, requireRole('TECHNICIAN'), async (req, res) => {
  try {
    const projects = await prisma.improvementProject.findMany({
      where:   { lineId: req.params.id, orgId: req.user.orgId },
      include: { kaizenEvents: { select: { id: true, title: true, status: true } }, wastes: true },
      orderBy: { createdAt: 'desc' },
    });
    const line = await prisma.productionLine.findUnique({ where: { id: req.params.id } });
    res.json({ data: projects, line, count: projects.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Auto-raise project from alert ────────────────────────────
async function autoProjectFromAlert({ sensor, alert, orgId }) {
  try {
    const org = orgId
      ? { id: orgId }
      : await prisma.org.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!org) return null;

    // Don't duplicate — check for open auto-project for this sensor in last 7 days
    const recent = await prisma.improvementProject.findFirst({
      where: { orgId: org.id, autoSource: `alert:${alert.id}`, status: { in: ['OPEN','IN_PROGRESS'] } },
    });
    if (recent) return null;

    const number  = await nextSequence(org.id, 'improvement', 'PI');
    const project = await prisma.improvementProject.create({
      data: {
        orgId:       org.id,
        number,
        title:       `Auto: ${sensor?.name || 'Sensor'} — Process Out of Control`,
        type:        'DMAIC',
        status:      'OPEN',
        dmaicPhase:  'Define',
        department:  'Manufacturing',
        description: `Auto-raised from IIoT critical alert. Sensor ${sensor?.name} exceeded critical threshold.`,
        problem:     `Sensor ${sensor?.name} breached critical threshold (value: ${alert.value} ${sensor?.unit}, limit: ${alert.threshold} ${sensor?.unit}).`,
        currentState:`${sensor?.name} reading: ${alert.value} ${sensor?.unit}`,
        priority:    1,
        autoRaised:  true,
        autoSource:  `alert:${alert.id}`,
        startDate:   new Date(),
      },
    });
    console.log(`[AUTO] Improvement project raised from alert: ${number}`);
    return project;
  } catch (e) {
    console.error('[AUTO] autoProjectFromAlert failed:', e.message);
    return null;
  }
}

// ── Auto-raise project from NCR ───────────────────────────────
async function autoProjectFromNCR({ ncr, orgId }) {
  try {
    const org = orgId
      ? { id: orgId }
      : await prisma.org.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!org) return null;
    if (ncr.severity !== 'CRITICAL') return null; // only auto-raise for CRITICAL NCRs

    const number  = await nextSequence(org.id, 'improvement', 'PI');
    const project = await prisma.improvementProject.create({
      data: {
        orgId:       org.id,
        number,
        title:       `DMAIC: ${ncr.partNumber} — ${ncr.defectType || 'Quality Non-Conformance'}`,
        type:        'DMAIC',
        status:      'OPEN',
        dmaicPhase:  'Define',
        department:  'Quality',
        description: `Auto-raised from critical NCR ${ncr.number}. Part: ${ncr.partNumber}. Defect: ${ncr.defectType}.`,
        problem:     ncr.description || `Critical NCR on ${ncr.partNumber}`,
        priority:    1,
        autoRaised:  true,
        autoSource:  `ncr:${ncr.id}`,
        startDate:   new Date(),
      },
    });
    console.log(`[AUTO] DMAIC project raised from NCR ${ncr.number}: ${number}`);
    return project;
  } catch (e) {
    console.error('[AUTO] autoProjectFromNCR failed:', e.message);
    return null;
  }
}

module.exports = router;
module.exports.autoProjectFromAlert = autoProjectFromAlert;
module.exports.autoProjectFromNCR   = autoProjectFromNCR;
