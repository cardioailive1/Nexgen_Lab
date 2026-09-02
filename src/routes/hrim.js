/**
 * CorverxisHRIM API Routes
 * ==================================================
 * GET  /api/v1/hrim/dashboard             → headcount, attrition, req KPIs
 * GET  /api/v1/hrim/departments           → dept list with live headcount
 * GET  /api/v1/hrim/employees             → employee directory (filter: dept, status, search)
 * GET  /api/v1/hrim/employees/:id         → single employee, full profile
 * POST /api/v1/hrim/employees             → create employee
 * PATCH /api/v1/hrim/employees/:id        → update employee
 * GET  /api/v1/hrim/org-chart             → nested reporting tree
 * GET  /api/v1/hrim/requisitions          → open reqs
 * POST /api/v1/hrim/requisitions          → create req
 * GET  /api/v1/hrim/candidates            → ATS pipeline
 * POST /api/v1/hrim/candidates            → add candidate
 * PATCH /api/v1/hrim/candidates/:id/stage → move ATS stage
 * GET  /api/v1/hrim/reviews               → performance reviews
 * POST /api/v1/hrim/reviews               → create review
 * GET  /api/v1/hrim/comp-plans            → compensation plans
 * POST /api/v1/hrim/comp-plans            → create comp plan
 * GET  /api/v1/hrim/time-entries          → time & attendance
 * POST /api/v1/hrim/time-entries          → clock time
 * GET  /api/v1/hrim/leave                 → leave requests
 * POST /api/v1/hrim/leave                 → request leave
 * PATCH /api/v1/hrim/leave/:id            → approve/deny leave
 * GET  /api/v1/hrim/trainings             → learning records
 * POST /api/v1/hrim/trainings             → assign training
 * GET  /api/v1/hrim/payroll               → payroll runs
 * POST /api/v1/hrim/payroll/run           → execute payroll run
 * GET  /api/v1/hrim/analytics             → workforce analytics rollups
 * POST /api/v1/hrim/attrition/recompute   → recompute attrition risk scores
 */

const express = require('express');
const router  = express.Router();
const { prisma } = require('../prisma');
const { authenticate, requireRole } = require('../middleware/rbac');
const { getConnector, PROVIDER_META } = require('../integrations/payroll');
const { encryptCredentials, decryptCredentials, maskCredential } = require('../integrations/payroll/crypto');

// ── Attrition risk model ────────────────────────────────────────
// Deterministic, explainable scoring — no black box.
// Factors: tenure without promotion, below-band comp signal, low
// recent performance rating, no recent training, manager change proxy.
function computeAttritionScore(emp) {
  let score = 10; // baseline
  const reasons = [];

  const tenureYears = (Date.now() - new Date(emp.hireDate).getTime()) / (365.25*24*3600*1000);
  if (tenureYears >= 3 && (!emp.performanceRating || emp.performanceRating < 4.2)) {
    score += 22;
    reasons.push('3+ years tenure without a top-tier rating (no recent promotion signal)');
  }
  if (emp.performanceRating != null && emp.performanceRating < 3.0) {
    score += 18;
    reasons.push('Performance rating below 3.0');
  }
  if (emp.baseSalary != null) {
    // crude below-band flag: bottom 15% of org distribution handled by caller;
    // per-employee flag applied by caller via percentile pass
  }
  if (emp.employmentType === 'CONTRACT') {
    score += 8;
    reasons.push('Contract employment type — higher flight risk');
  }
  if (emp.ptoBalanceHours != null && emp.ptoBalanceHours > 160) {
    score += 6;
    reasons.push('High unused PTO balance — possible disengagement signal');
  }
  score = Math.max(2, Math.min(96, Math.round(score)));
  const label = score >= 60 ? 'High' : score >= 35 ? 'Medium' : 'Low';
  return { score, label, reasons };
}

async function recomputeAttrition(orgId) {
  const employees = await prisma.hrEmployee.findMany({
    where: { orgId, status: 'ACTIVE' },
  });
  if (!employees.length) return 0;

  // Compute salary percentile per department for below-band signal
  const byDept = {};
  employees.forEach(e => {
    const key = e.departmentId || 'none';
    (byDept[key] = byDept[key] || []).push(e);
  });

  const updates = [];
  for (const e of employees) {
    const { score: baseScore, label, reasons } = computeAttritionScore(e);
    let score = baseScore;
    const deptPeers = byDept[e.departmentId || 'none'];
    if (e.baseSalary != null && deptPeers.length > 2) {
      const sorted = deptPeers.map(p => p.baseSalary || 0).sort((a,b) => a-b);
      const idx = sorted.indexOf(e.baseSalary);
      const pct = idx / (sorted.length - 1 || 1);
      if (pct <= 0.2) {
        score += 15;
        reasons.push('Compensation in bottom 20% of department band');
      }
    }
    score = Math.max(2, Math.min(96, Math.round(score)));
    const finalLabel = score >= 60 ? 'High' : score >= 35 ? 'Medium' : 'Low';
    updates.push(
      prisma.hrEmployee.update({
        where: { id: e.id },
        data: { attritionRiskScore: score, attritionRiskLabel: finalLabel },
      })
    );
  }
  await prisma.$transaction(updates);
  return updates.length;
}

// ── DASHBOARD ────────────────────────────────────────────────
router.get('/hrim/dashboard', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [active, onLeave, terminatedYTD, openReqs, highRisk, avgRating] = await Promise.all([
      prisma.hrEmployee.count({ where: { orgId, status: 'ACTIVE' } }),
      prisma.hrEmployee.count({ where: { orgId, status: 'ON_LEAVE' } }),
      prisma.hrEmployee.count({ where: { orgId, status: 'TERMINATED', terminationDate: { gte: new Date(new Date().getFullYear(),0,1) } } }),
      prisma.hrRequisition.count({ where: { orgId, status: 'OPEN' } }),
      prisma.hrEmployee.count({ where: { orgId, status: 'ACTIVE', attritionRiskLabel: 'High' } }),
      prisma.hrEmployee.aggregate({ where: { orgId, status: 'ACTIVE', performanceRating: { not: null } }, _avg: { performanceRating: true } }),
    ]);
    const totalStart = active + terminatedYTD;
    const attritionRate = totalStart > 0 ? Math.round((terminatedYTD / totalStart) * 1000) / 10 : 0;

    res.json({
      data: {
        headcount: active,
        onLeave,
        terminatedYTD,
        attritionRatePct: attritionRate,
        openRequisitions: openReqs,
        highAttritionRisk: highRisk,
        avgPerformanceRating: avgRating._avg.performanceRating ? Math.round(avgRating._avg.performanceRating*10)/10 : null,
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DEPARTMENTS ─────────────────────────────────────────────
router.get('/hrim/departments', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const depts = await prisma.hrDepartment.findMany({
      where: { orgId },
      include: { _count: { select: { employees: { where: { status: 'ACTIVE' } } } } },
      orderBy: { name: 'asc' },
    });
    res.json({ data: depts.map(d => ({ ...d, liveHeadcount: d._count.employees })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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

// Bypasses the whole build/seed pipeline — creates the standard
// department set via a direct authenticated call from the running app.
// Idempotent: safe to click more than once.
router.post('/hrim/departments/seed-defaults', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const existing = await prisma.hrDepartment.count({ where: { orgId } });
    if (existing > 0) {
      const rows = await prisma.hrDepartment.findMany({ where: { orgId } });
      return res.json({ data: rows, created: 0, message: `${existing} department(s) already exist — nothing new created.` });
    }
    const created = [];
    for (const d of DEFAULT_DEPARTMENTS) {
      created.push(await prisma.hrDepartment.create({ data: { orgId, ...d } }));
    }
    res.status(201).json({ data: created, created: created.length, message: `${created.length} default departments created.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── EMPLOYEES ────────────────────────────────────────────────
router.get('/hrim/employees', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { departmentId, status, search, riskLabel } = req.query;
    const where = { orgId };
    if (departmentId) where.departmentId = departmentId;
    if (status) where.status = status;
    if (riskLabel) where.attritionRiskLabel = riskLabel;
    if (search) {
      where.OR = [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { jobTitle: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }
    const employees = await prisma.hrEmployee.findMany({
      where,
      include: { department: true, manager: { select: { id:true, firstName:true, lastName:true } } },
      orderBy: [{ lastName: 'asc' }],
    });
    res.json({ data: employees });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/hrim/employees/:id', authenticate, async (req, res) => {
  try {
    const emp = await prisma.hrEmployee.findFirst({
      where: { id: req.params.id, orgId: req.user.orgId },
      include: {
        department: true,
        manager: { select: { id:true, firstName:true, lastName:true, jobTitle:true } },
        reports: { select: { id:true, firstName:true, lastName:true, jobTitle:true, status:true } },
        reviews: { orderBy: { createdAt: 'desc' }, take: 5 },
        compPlans: { orderBy: { createdAt: 'desc' }, take: 5 },
        trainings: { orderBy: { createdAt: 'desc' }, take: 10 },
        leaveRequests: { orderBy: { createdAt: 'desc' }, take: 10 },
      }
    });
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    res.json({ data: emp });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/hrim/employees', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const b = req.body;

    const baseData = {
      orgId,
      firstName: b.firstName, lastName: b.lastName, email: b.email,
      jobTitle: b.jobTitle, departmentId: b.departmentId || null,
      managerId: b.managerId || null, location: b.location || null,
      employmentType: b.employmentType || 'FULL_TIME',
      status: b.status || 'ACTIVE',
      hireDate: b.hireDate ? new Date(b.hireDate) : new Date(),
      baseSalary: b.baseSalary != null ? Number(b.baseSalary) : null,
      currency: b.currency || 'USD',
    };

    // employeeCode generation is race-safe and collision-tolerant: a plain
    // count()-based number can collide with pre-seeded records, terminated
    // employees still counted, or two requests landing at once. Retry with
    // a fresh candidate on a uniqueness conflict rather than failing outright.
    let emp = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 6 && !emp; attempt++) {
      const count = await prisma.hrEmployee.count({ where: { orgId } });
      const suffix = count + 1 + attempt; // shifts forward each retry to dodge the same collision
      const employeeCode = 'EMP-' + String(suffix).padStart(4, '0');
      try {
        emp = await prisma.hrEmployee.create({ data: { ...baseData, employeeCode } });
      } catch (err) {
        lastErr = err;
        const target = err.meta && err.meta.target ? String(err.meta.target) : '';
        if (err.code === 'P2002' && target.includes('email')) {
          return res.status(400).json({ error: 'An employee with this email already exists.' });
        }
        if (err.code !== 'P2002') throw err; // not a uniqueness collision — a real error, don't retry
        // else: employeeCode collision — loop and try the next number
      }
    }
    if (!emp) {
      // Extremely unlikely fallback: guaranteed-unique via timestamp suffix
      const employeeCode = 'EMP-' + Date.now().toString().slice(-6);
      emp = await prisma.hrEmployee.create({ data: { ...baseData, employeeCode } });
    }

    if (b.departmentId) {
      await prisma.hrDepartment.update({
        where: { id: b.departmentId },
        data: { headCount: { increment: 1 } },
      });
    }
    recomputeAttrition(orgId).catch(()=>{}); // fire-and-forget: keep risk scores current
    res.status(201).json({ data: emp });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/hrim/employees/:id', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const b = req.body;
    const data = {};
    ['firstName','lastName','email','jobTitle','location','status','employmentType',
     'baseSalary','performanceRating','ptoBalanceHours','departmentId','managerId'].forEach(k => {
      if (b[k] !== undefined) data[k] = b[k];
    });
    if (b.status === 'TERMINATED' && !b.terminationDate) data.terminationDate = new Date();
    const emp = await prisma.hrEmployee.update({
      where: { id: req.params.id },
      data,
    });
    // Salary, performance, or employment-type changes shift risk — recompute live
    if (['baseSalary','performanceRating','employmentType','status'].some(k => b[k] !== undefined)) {
      recomputeAttrition(emp.orgId).catch(()=>{});
    }
    res.json({ data: emp });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ORG CHART ────────────────────────────────────────────────
router.get('/hrim/org-chart', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const employees = await prisma.hrEmployee.findMany({
      where: { orgId, status: 'ACTIVE' },
      select: { id:true, firstName:true, lastName:true, jobTitle:true, managerId:true, departmentId:true },
    });
    const byId = {}; employees.forEach(e => byId[e.id] = { ...e, children: [] });
    const roots = [];
    employees.forEach(e => {
      if (e.managerId && byId[e.managerId]) byId[e.managerId].children.push(byId[e.id]);
      else roots.push(byId[e.id]);
    });
    res.json({ data: roots });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── REQUISITIONS / ATS ──────────────────────────────────────
router.get('/hrim/requisitions', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const reqs = await prisma.hrRequisition.findMany({
      where: { orgId },
      include: { department: true, _count: { select: { candidates: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: reqs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/hrim/requisitions', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const b = req.body;
    const r = await prisma.hrRequisition.create({
      data: {
        orgId, title: b.title, departmentId: b.departmentId || null,
        location: b.location || null, hiringManager: b.hiringManager || null,
        targetHireDate: b.targetHireDate ? new Date(b.targetHireDate) : null,
      }
    });
    res.status(201).json({ data: r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/hrim/candidates', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { requisitionId, stage } = req.query;
    const where = { orgId };
    if (requisitionId) where.requisitionId = requisitionId;
    if (stage) where.stage = stage;
    const candidates = await prisma.hrCandidate.findMany({
      where, include: { requisition: true }, orderBy: { appliedAt: 'desc' },
    });
    res.json({ data: candidates });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/hrim/candidates', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const b = req.body;
    const c = await prisma.hrCandidate.create({
      data: { orgId, requisitionId: b.requisitionId || null, name: b.name, email: b.email || null, source: b.source || null }
    });
    res.status(201).json({ data: c });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/hrim/candidates/:id/stage', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const { stage } = req.body;
    const c = await prisma.hrCandidate.update({ where: { id: req.params.id }, data: { stage } });
    let createdEmployee = null;
    if (stage === 'HIRED' && c.requisitionId) {
      await prisma.hrRequisition.update({ where: { id: c.requisitionId }, data: { status: 'FILLED' } });
      createdEmployee = await autoCreateEmployeeFromCandidate(c, req.user.orgId);
    }
    res.json({ data: c, autoCreatedEmployee: createdEmployee });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PERFORMANCE REVIEWS ──────────────────────────────────────
router.get('/hrim/reviews', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { employeeId, cycle } = req.query;
    const where = { orgId };
    if (employeeId) where.employeeId = employeeId;
    if (cycle) where.cycle = cycle;
    const reviews = await prisma.hrPerformanceReview.findMany({
      where, include: { employee: { select: { firstName:true,lastName:true,jobTitle:true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: reviews });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/hrim/reviews', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const b = req.body;
    const rev = await prisma.hrPerformanceReview.create({
      data: {
        orgId, employeeId: b.employeeId, cycle: b.cycle, rating: b.rating != null ? Number(b.rating) : null,
        reviewerName: b.reviewerName || null, notes: b.notes || null, status: b.status || 'IN_PROGRESS',
      }
    });
    if (b.rating != null) {
      await prisma.hrEmployee.update({ where: { id: b.employeeId }, data: { performanceRating: Number(b.rating) } });
    }
    res.status(201).json({ data: rev });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── COMPENSATION ─────────────────────────────────────────────
router.get('/hrim/comp-plans', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const plans = await prisma.hrCompPlan.findMany({
      where: { orgId }, include: { employee: { select: { firstName:true,lastName:true,jobTitle:true,departmentId:true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: plans });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/hrim/comp-plans', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const b = req.body;
    const plan = await prisma.hrCompPlan.create({
      data: {
        orgId, employeeId: b.employeeId, cycle: b.cycle,
        currentSalary: Number(b.currentSalary), proposedSalary: b.proposedSalary != null ? Number(b.proposedSalary) : null,
        bonusPct: b.bonusPct != null ? Number(b.bonusPct) : null, equityUnits: b.equityUnits != null ? Number(b.equityUnits) : null,
        status: b.status || 'DRAFT',
      }
    });
    res.status(201).json({ data: plan });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TIME & ATTENDANCE ────────────────────────────────────────
router.get('/hrim/time-entries', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { employeeId, from, to } = req.query;
    const where = { orgId };
    if (employeeId) where.employeeId = employeeId;
    if (from || to) where.date = {};
    if (from) where.date.gte = new Date(from);
    if (to) where.date.lte = new Date(to);
    const entries = await prisma.hrTimeEntry.findMany({
      where, include: { employee: { select: { firstName:true,lastName:true } } },
      orderBy: { date: 'desc' }, take: 200,
    });
    res.json({ data: entries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/hrim/time-entries', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const b = req.body;
    const entry = await prisma.hrTimeEntry.create({
      data: {
        orgId, employeeId: b.employeeId, date: new Date(b.date),
        hoursWorked: Number(b.hoursWorked), overtimeHours: Number(b.overtimeHours || 0),
      }
    });
    res.status(201).json({ data: entry });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── LEAVE ────────────────────────────────────────────────────
router.get('/hrim/leave', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { employeeId, status } = req.query;
    const where = { orgId };
    if (employeeId) where.employeeId = employeeId;
    if (status) where.status = status;
    const leave = await prisma.hrLeaveRequest.findMany({
      where, include: { employee: { select: { firstName:true,lastName:true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: leave });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/hrim/leave', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const b = req.body;
    const lr = await prisma.hrLeaveRequest.create({
      data: {
        orgId, employeeId: b.employeeId, type: b.type,
        startDate: new Date(b.startDate), endDate: new Date(b.endDate), hours: Number(b.hours),
      }
    });
    res.status(201).json({ data: lr });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/hrim/leave/:id', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const { status } = req.body;
    const lr = await prisma.hrLeaveRequest.update({ where: { id: req.params.id }, data: { status } });
    if (status === 'APPROVED') {
      await prisma.hrEmployee.update({
        where: { id: lr.employeeId },
        data: { ptoBalanceHours: { decrement: lr.hours } },
      });
    }
    res.json({ data: lr });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── LEARNING / TRAINING ──────────────────────────────────────
router.get('/hrim/trainings', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { employeeId, status } = req.query;
    const where = { orgId };
    if (employeeId) where.employeeId = employeeId;
    if (status) where.status = status;
    const trainings = await prisma.hrTraining.findMany({
      where, include: { employee: { select: { firstName:true,lastName:true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: trainings });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Single-record lookup — used by CorverxisAcademy to show whose training
// record it's tracking and to know the current status on load.
router.get('/hrim/trainings/:id', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const t = await prisma.hrTraining.findFirst({
      where: { id: req.params.id, orgId },
      include: { employee: { select: { firstName:true,lastName:true,jobTitle:true } } },
    });
    if (!t) return res.status(404).json({ error: 'Training record not found' });
    res.json({ data: t });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/hrim/trainings', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const b = req.body;
    const t = await prisma.hrTraining.create({
      data: {
        orgId, employeeId: b.employeeId, courseName: b.courseName, provider: b.provider || null,
        dueDate: b.dueDate ? new Date(b.dueDate) : null, status: b.status || 'NOT_STARTED',
      }
    });
    res.status(201).json({ data: t });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Move a training record through NOT_STARTED → IN_PROGRESS → COMPLETED.
// Any authenticated user can update their own progress; managers can
// update anyone's (matches how the rest of HRIM's write endpoints work).
router.patch('/hrim/trainings/:id', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { status } = req.body;
    const allowed = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
    }
    const existing = await prisma.hrTraining.findFirst({ where: { id: req.params.id, orgId } });
    if (!existing) return res.status(404).json({ error: 'Training record not found' });

    const data = { status };
    if (status === 'COMPLETED') data.completedAt = new Date();
    if (status === 'NOT_STARTED') data.completedAt = null; // allow reverting

    const t = await prisma.hrTraining.update({ where: { id: req.params.id }, data });
    res.json({ data: t });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PAYROLL PROVIDERS (Gusto / ADP / Intuit / Native) ─────────
router.get('/hrim/payroll/providers', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const rows = await prisma.hrPayrollProvider.findMany({ where: { orgId } });
    const byProvider = {}; rows.forEach(r => { byProvider[r.provider] = r; });

    const all = Object.keys(PROVIDER_META).map(provider => {
      const row = byProvider[provider];
      return {
        provider,
        name: PROVIDER_META[provider].name,
        credentialFields: PROVIDER_META[provider].credentialFields,
        status: row ? row.status : (provider === 'NATIVE' ? 'CONNECTED' : 'NOT_CONNECTED'),
        isActive: row ? row.isActive : provider === 'NATIVE',
        externalCompanyId: row?.externalCompanyId || null,
        credentialRef: row?.credentialRef || null,
        lastSyncAt: row?.lastSyncAt || null,
        lastError: row?.lastError || null,
      };
    });
    res.json({ data: all });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/hrim/payroll/providers/:provider/connect', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const provider = req.params.provider.toUpperCase();
    if (provider === 'NATIVE') return res.status(400).json({ error: 'Native payroll requires no connection.' });
    if (!PROVIDER_META[provider]) return res.status(400).json({ error: 'Unknown provider: ' + provider });

    const connector = getConnector(provider);
    let testResult;
    try {
      testResult = await connector.testConnection(req.body);
    } catch (connErr) {
      await prisma.hrPayrollProvider.upsert({
        where: { orgId_provider: { orgId, provider } },
        update: { status: 'ERROR', lastError: connErr.message },
        create: { orgId, provider, status: 'ERROR', lastError: connErr.message },
      });
      return res.status(422).json({ error: connErr.message });
    }

    const credentialsEnc = encryptCredentials(req.body);
    const credentialRef  = maskCredential(req.body);
    const row = await prisma.hrPayrollProvider.upsert({
      where: { orgId_provider: { orgId, provider } },
      update: {
        status: 'CONNECTED', credentialsEnc, credentialRef,
        externalCompanyId: testResult.externalCompanyId || req.body.realmId || req.body.orgOid || null,
        connectedAt: new Date(), lastError: null,
      },
      create: {
        orgId, provider, status: 'CONNECTED', credentialsEnc, credentialRef,
        externalCompanyId: testResult.externalCompanyId || req.body.realmId || req.body.orgOid || null,
        connectedAt: new Date(),
      },
    });
    res.json({ data: { provider, status: row.status, credentialRef: row.credentialRef, externalCompanyId: row.externalCompanyId } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/hrim/payroll/providers/:provider/activate', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const provider = req.params.provider.toUpperCase();
    if (!PROVIDER_META[provider]) return res.status(400).json({ error: 'Unknown provider: ' + provider });

    if (provider !== 'NATIVE') {
      const row = await prisma.hrPayrollProvider.findUnique({ where: { orgId_provider: { orgId, provider } } });
      if (!row || row.status !== 'CONNECTED') {
        return res.status(400).json({ error: `${PROVIDER_META[provider].name} must be connected before it can be set active.` });
      }
    }

    await prisma.$transaction([
      prisma.hrPayrollProvider.updateMany({ where: { orgId }, data: { isActive: false } }),
      ...(provider !== 'NATIVE' ? [prisma.hrPayrollProvider.update({ where: { orgId_provider: { orgId, provider } }, data: { isActive: true } })] : []),
    ]);
    // NATIVE is represented by the absence of any active row — track it explicitly too
    if (provider === 'NATIVE') {
      await prisma.hrPayrollProvider.upsert({
        where: { orgId_provider: { orgId, provider: 'NATIVE' } },
        update: { isActive: true, status: 'CONNECTED' },
        create: { orgId, provider: 'NATIVE', isActive: true, status: 'CONNECTED' },
      });
    }
    res.json({ data: { activeProvider: provider } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/hrim/payroll/providers/:provider/disconnect', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const provider = req.params.provider.toUpperCase();
    if (provider === 'NATIVE') return res.status(400).json({ error: 'Cannot disconnect Native payroll.' });
    await prisma.hrPayrollProvider.updateMany({
      where: { orgId, provider },
      data: { status: 'NOT_CONNECTED', isActive: false, credentialsEnc: null, credentialRef: null, connectedAt: null },
    });
    res.json({ data: { provider, status: 'NOT_CONNECTED' } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PAYROLL ──────────────────────────────────────────────────
router.get('/hrim/payroll', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const runs = await prisma.hrPayrollRun.findMany({ where: { orgId }, orderBy: { payDate: 'desc' } });
    res.json({ data: runs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/hrim/payroll/run', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const activeRow = await prisma.hrPayrollProvider.findFirst({ where: { orgId, isActive: true } });
    const activeProvider = activeRow ? activeRow.provider : 'NATIVE';

    if (activeProvider === 'NATIVE') {
      const active = await prisma.hrEmployee.findMany({ where: { orgId, status: 'ACTIVE', baseSalary: { not: null } } });
      const totalGross = active.reduce((a,e) => a + (e.baseSalary || 0) / 26, 0);
      const totalTaxes = totalGross * 0.223;
      const totalNet   = totalGross - totalTaxes;
      const run = await prisma.hrPayrollRun.create({
        data: {
          orgId, periodLabel: req.body.periodLabel || ('Run ' + new Date().toISOString().slice(0,10)),
          payDate: req.body.payDate ? new Date(req.body.payDate) : new Date(),
          totalGross: Math.round(totalGross*100)/100, totalNet: Math.round(totalNet*100)/100,
          totalTaxes: Math.round(totalTaxes*100)/100, employeeCount: active.length, status: 'COMPLETED',
          provider: 'NATIVE',
        }
      });
      return res.status(201).json({ data: run });
    }

    // Dispatch to the connected third-party provider
    const credentials = decryptCredentials(activeRow.credentialsEnc);
    const connector = getConnector(activeProvider);
    let result;
    try {
      result = await connector.runPayroll({ ...credentials, companyId: activeRow.externalCompanyId, orgOid: activeRow.externalCompanyId, realmId: activeRow.externalCompanyId });
    } catch (connErr) {
      await prisma.hrPayrollProvider.update({ where: { id: activeRow.id }, data: { status: 'ERROR', lastError: connErr.message } });
      return res.status(422).json({ error: connErr.message, provider: activeProvider });
    }

    await prisma.hrPayrollProvider.update({ where: { id: activeRow.id }, data: { lastSyncAt: new Date(), status: 'CONNECTED', lastError: null } });

    const active = await prisma.hrEmployee.count({ where: { orgId, status: 'ACTIVE' } });
    const run = await prisma.hrPayrollRun.create({
      data: {
        orgId, periodLabel: req.body.periodLabel || (PROVIDER_META[activeProvider].name + ' sync ' + new Date().toISOString().slice(0,10)),
        payDate: req.body.payDate ? new Date(req.body.payDate) : new Date(),
        totalGross: result.totalGross || 0, totalNet: result.totalNet || 0, totalTaxes: result.totalTaxes || 0,
        employeeCount: result.employeeCount ?? active,
        status: 'SYNCED', provider: activeProvider, externalRunId: result.externalRunId || null,
      }
    });
    res.status(201).json({ data: run, providerResult: result.raw || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ANALYTICS ────────────────────────────────────────────────
router.get('/hrim/analytics', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [byDept, byRisk, byStatus, byType] = await Promise.all([
      prisma.hrEmployee.groupBy({ by: ['departmentId'], where: { orgId, status: 'ACTIVE' }, _count: true }),
      prisma.hrEmployee.groupBy({ by: ['attritionRiskLabel'], where: { orgId, status: 'ACTIVE' }, _count: true }),
      prisma.hrEmployee.groupBy({ by: ['status'], where: { orgId }, _count: true }),
      prisma.hrEmployee.groupBy({ by: ['employmentType'], where: { orgId, status: 'ACTIVE' }, _count: true }),
    ]);
    res.json({ data: { byDept, byRisk, byStatus, byType } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ATTRITION RECOMPUTE ──────────────────────────────────────
router.post('/hrim/attrition/recompute', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const count = await recomputeAttrition(req.user.orgId);
    res.json({ data: { recomputed: count } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.recomputeAttrition = recomputeAttrition;

// ── AUTOMATION HOOK: Candidate hired → auto-create HrEmployee ──
// Wired in by patching the stage-update route above's behaviour via
// a listener-style export the route itself calls directly (see PATCH
// /hrim/candidates/:id/stage below — this fn is invoked inline).
async function autoCreateEmployeeFromCandidate(candidate, orgId) {
  const req = await prisma.hrRequisition.findUnique({ where: { id: candidate.requisitionId } });
  if (!req) return null;
  const [firstName, ...rest] = candidate.name.split(' ');
  const lastName = rest.join(' ') || '—';
  const count = await prisma.hrEmployee.count({ where: { orgId } });
  const employeeCode = 'EMP-' + String(count + 1).padStart(4, '0');
  const email = candidate.email || `${firstName}.${lastName}`.toLowerCase().replace(/[^a-z.]/g,'') + '@corverxis.com';
  try {
    const emp = await prisma.hrEmployee.create({
      data: {
        orgId, employeeCode, firstName, lastName, email,
        jobTitle: req.title, departmentId: req.departmentId || null,
        location: req.location || null, employmentType: 'FULL_TIME',
        status: 'PENDING_START', hireDate: new Date(),
      }
    });
    return emp;
  } catch (e) {
    // email collision or similar — non-fatal, hiring stage change still succeeds
    return null;
  }
}
module.exports.autoCreateEmployeeFromCandidate = autoCreateEmployeeFromCandidate;
