/**
 * Corverxis — Full Dynamic Data API
 * Replaces all hardcoded data in the frontend HTML
 * with real PostgreSQL data via Prisma
 */

const express    = require('express');
const router     = express.Router();
const { prisma } = require('../prisma');
const { authenticate, requireRole } = require('../middleware/rbac');

// ── DASHBOARD — Command Center KPIs ──────────────────────────────────────────
// Replaces: hardcoded OEE 94.2%, NCR 7, OTIF 91.8% etc
router.get('/dashboard/kpis', authenticate, requireRole('TECHNICIAN'), async (req, res) => {
  try {
    const orgId = req.user.orgId;

    const [
      openAlerts,
      criticalAlerts,
      openNcrs,
      totalSensors,
      activeSensors,
      recentPredictions,
      visionSession,
      workOrders,
    ] = await Promise.all([
      prisma.alert.count({ where: { resolved: false, sensor: { asset: { orgId } } } }),
      prisma.alert.count({ where: { resolved: false, severity: 'CRITICAL', sensor: { asset: { orgId } } } }),
      prisma.ncr.count({ where: { orgId, status: { not: 'CLOSED' } } }).catch(() => 0),
      prisma.sensor.count({ where: { asset: { orgId } } }),
      prisma.sensor.count({
        where: {
          asset: { orgId },
          readings: { some: { timestamp: { gte: new Date(Date.now() - 60000) } } }
        }
      }).catch(() => 0),
      prisma.prediction.findMany({
        where: { sensor: { asset: { orgId } } },
        orderBy: { timestamp: 'desc' },
        take: 5,
        include: { sensor: { select: { name: true, unit: true } } },
      }),
      prisma.visionSession.findFirst({
        where: { job: { orgId } },
        orderBy: { startedAt: 'desc' },
      }),
      prisma.workOrder.findMany({
        where: { orgId, status: { not: 'COMPLETED' } },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { line: { select: { name: true } } },
      }).catch(() => []),
    ]);

    const passRate = visionSession && visionSession.totalCount > 0
      ? (visionSession.passCount / visionSession.totalCount * 100).toFixed(1)
      : null;

    res.json({
      sensors:    { total: totalSensors, active: activeSensors, alerts: openAlerts, critical: criticalAlerts },
      quality:    { openNcrs, passRate },
      vision:     visionSession ? { totalCount: visionSession.totalCount, passCount: visionSession.passCount, failCount: visionSession.failCount, passRate } : null,
      predictions: recentPredictions.map(p => ({
        id: p.id, sensorName: p.sensor.name, unit: p.sensor.unit,
        predicted: p.predicted, confidence: p.confidence, rulHours: p.rulHours,
        timestamp: p.timestamp,
      })),
      workOrders: workOrders.map(wo => ({
        id: wo.id, number: wo.number, partNumber: wo.partNumber,
        customer: wo.customer, quantity: wo.quantity, completed: wo.completed,
        status: wo.status, dueDate: wo.dueDate, line: wo.line?.name,
      })),
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ALERTS — Live alerts for command center ───────────────────────────────────
// Replaces: hardcoded alert divs in dashboard
router.get('/alerts', authenticate, requireRole('TECHNICIAN'), async (req, res) => {
  try {
    const alerts = await prisma.alert.findMany({
      where:   { resolved: false, sensor: { asset: { orgId: req.user.orgId } } },
      orderBy: { createdAt: 'desc' },
      take:    20,
      include: { sensor: { select: { name: true, type: true, unit: true } } },
    });

    res.json({
      data: alerts.map(a => ({
        id: a.id, severity: a.severity, type: a.type, message: a.message,
        value: a.value, threshold: a.threshold,
        sensorName: a.sensor?.name,
        sensorType: a.sensor?.type,
        createdAt:  a.createdAt,
        age: Math.round((Date.now() - new Date(a.createdAt)) / 60000) + 'm ago',
      })),
      count: alerts.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Resolve an alert — ENGINEER+
router.patch('/alerts/:id/resolve', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    await prisma.alert.update({
      where: { id: req.params.id },
      data:  { resolved: true, resolvedAt: new Date(), resolvedBy: req.user.id },
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WORK ORDERS — MES ─────────────────────────────────────────────────────────
// Replaces: hardcoded WO-2851, WO-2849 table
router.get('/work-orders', authenticate, requireRole('TECHNICIAN'), async (req, res) => {
  try {
    const { status, limit = 50 } = req.query;
    const where = { orgId: req.user.orgId };
    if (status) where.status = status;

    const workOrders = await prisma.workOrder.findMany({
      where, orderBy: { createdAt: 'desc' }, take: parseInt(limit),
      include: { line: { select: { name: true } } },
    }).catch(() => []);

    res.json({ data: workOrders });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/work-orders', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const { number, partNumber, customer, quantity, lineId, dueDate, priority = 3 } = req.body;
    if (!number || !partNumber) return res.status(400).json({ error: 'number and partNumber required' });

    const wo = await prisma.workOrder.create({
      data: {
        number, partNumber, customer, quantity: parseInt(quantity) || 0,
        lineId, dueDate: dueDate ? new Date(dueDate) : null,
        priority, orgId: req.user.orgId, status: 'OPEN',
        createdBy: req.user.id,
      },
    });

    await prisma.auditLog.create({
      data: { userId: req.user.id, orgId: req.user.orgId ?? null,
              action: 'work_order.created', resource: 'work_order', resourceId: wo.id, outcome: 'success' },
    }).catch(() => {});

    res.status(201).json({ success: true, data: wo });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SENSORS — IIoT live readings ──────────────────────────────────────────────
// Replaces: Math.random() in IIoT page
router.get('/sensors/live', authenticate, requireRole('TECHNICIAN'), async (req, res) => {
  try {
    const sensors = await prisma.sensor.findMany({
      where: { asset: { orgId: req.user.orgId } }, // Sensor has no direct orgId — scoped via its Asset
      include: {
        readings: { orderBy: { timestamp: 'desc' }, take: 1 },
        alerts:   { where: { resolved: false }, orderBy: { createdAt: 'desc' }, take: 1 },
        asset:    { select: { name: true, vertical: true, location: true } },
        activeModel: { select: { name: true, latestVersion: true, accuracyPct: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const data = sensors.map(s => {
      const latest = s.readings[0];
      const thr    = s.thresholds;
      const val    = latest?.value ?? null;
      const status = !val ? 'UNKNOWN' :
                     thr.crit && val >= thr.crit ? 'CRITICAL' :
                     thr.warn && val >= thr.warn ? 'WARNING' : 'OK';
      return {
        id: s.id, name: s.name, type: s.type, unit: s.unit,
        value: val !== null ? parseFloat(val.toFixed(3)) : null,
        status, warn: thr.warn, crit: thr.crit,
        vertical: s.asset?.vertical, asset: s.asset?.name, location: s.asset?.location,
        activeModel: s.activeModel ? { name: s.activeModel.name, version: s.activeModel.latestVersion, accuracyPct: s.activeModel.accuracyPct } : null,
        lastReading: latest?.timestamp ?? null,
        hasAlert: s.alerts.length > 0,
        alertSeverity: s.alerts[0]?.severity ?? null,
        mlAlgorithm: s.mlAlgorithm,
      };
    });

    res.json({ data, count: data.length, timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sensor history for charts
router.get('/sensors/:id/history', authenticate, requireRole('TECHNICIAN'), async (req, res) => {
  try {
    const { points = 100 } = req.query;
    // Verify the sensor actually belongs to the caller's org before
    // returning anything — without this, any authenticated user could
    // read any other org's sensor history just by guessing/enumerating IDs.
    const owned = await prisma.sensor.findFirst({
      where: { id: req.params.id, asset: { orgId: req.user.orgId } },
      select: { id: true },
    });
    if (!owned) return res.status(404).json({ error: 'Sensor not found' });

    const readings = await prisma.sensorReading.findMany({
      where:   { sensorId: req.params.id },
      orderBy: { timestamp: 'desc' },
      take:    parseInt(points),
      select:  { value: true, timestamp: true, status: true },
    });
    res.json({ data: readings.reverse() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PREDICTIONS — RUL table ───────────────────────────────────────────────────
// Replaces: hardcoded predictive maintenance table
router.get('/predictions', authenticate, requireRole('TECHNICIAN'), async (req, res) => {
  try {
    const predictions = await prisma.prediction.findMany({
      where: { sensor: { asset: { orgId: req.user.orgId } } },
      orderBy: { timestamp: 'desc' },
      take: 50,
      distinct: ['sensorId'],
      include: {
        sensor: {
          include: { asset: { select: { name: true, location: true } } },
        },
      },
    });

    res.json({
      data: predictions.map(p => ({
        id: p.id,
        sensorId:   p.sensorId,
        sensorName: p.sensor.name,
        sensorUnit: p.sensor.unit,
        assetName:  p.sensor.asset?.name,
        location:   p.sensor.asset?.location,
        algorithm:  p.algorithm,
        predicted:  p.predicted,
        confidence: p.confidence,
        rulHours:   p.rulHours,
        status:     !p.rulHours ? 'HEALTHY' :
                    p.rulHours < 48   ? 'CRITICAL' :
                    p.rulHours < 168  ? 'WARNING' : 'MONITOR',
        timestamp:  p.timestamp,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Save a prediction — called from SensorModel ML engine
router.post('/predictions', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const { sensorId, algorithm, predicted, confidence, rulHours, features } = req.body;
    if (!sensorId || !algorithm) return res.status(400).json({ error: 'sensorId and algorithm required' });

    const pred = await prisma.prediction.create({
      data: { sensorId, algorithm, predicted: parseFloat(predicted),
              confidence: parseFloat(confidence), rulHours: rulHours ? parseFloat(rulHours) : null,
              features: features || {} },
    });

    // Auto-raise alert if RUL critical
    if (pred.rulHours !== null && pred.rulHours < 48) {
      const sensor = await prisma.sensor.findUnique({ where: { id: sensorId } });
      await prisma.alert.create({
        data: { sensorId, severity: pred.rulHours < 24 ? 'CRITICAL' : 'WARNING',
                type: 'rul_prediction',
                message: `${sensor?.name || sensorId}: RUL estimated ${Math.round(pred.rulHours)}h (${algorithm})`,
                value: pred.rulHours, threshold: 48 },
      }).catch(() => {});
    }

    res.status(201).json({ success: true, data: pred });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── NCRs — Quality Management ─────────────────────────────────────────────────
// Replaces: hardcoded NCR-0291, NCR-0290 table
router.get('/ncrs', authenticate, requireRole('TECHNICIAN'), async (req, res) => {
  try {
    const { status, severity, limit = 50, autoRaised, sourcePillar } = req.query;
    const where = { orgId: req.user.orgId };
    if (status) where.status = status;
    if (severity) where.severity = severity;
    if (autoRaised !== undefined) where.autoRaised = autoRaised === 'true';
    if (sourcePillar) where.sourcePillar = sourcePillar;

    const ncrs = await prisma.ncr.findMany({
      where, orderBy: { createdAt: 'desc' }, take: parseInt(limit),
    }).catch(() => []);

    const autoRaisedCount = await prisma.ncr.count({ where: { orgId: req.user.orgId, autoRaised: true, status: { not: 'CLOSED' } } }).catch(() => 0);

    res.json({ data: ncrs, autoRaisedOpenCount: autoRaisedCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/ncrs', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const { number, partNumber, customer, defectType, severity, description, workOrderId, quantityAffected } = req.body;
    if (!number || !partNumber || !severity) return res.status(400).json({ error: 'number, partNumber, severity required' });

    const ncr = await prisma.ncr.create({
      data: {
        number, partNumber, customer, defectType, severity, description,
        workOrderId, quantityAffected: parseInt(quantityAffected) || 0,
        orgId: req.user.orgId, createdBy: req.user.id, status: 'OPEN',
      },
    });

    await prisma.auditLog.create({
      data: { userId: req.user.id, orgId: req.user.orgId ?? null,
              action: 'ncr.created', resource: 'ncr', resourceId: ncr.id, outcome: 'success',
              metadata: { number, severity, partNumber } },
    }).catch(() => {});

    res.status(201).json({ success: true, data: ncr });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SUPPLIERS — Supply Chain ──────────────────────────────────────────────────
// Replaces: hardcoded Bosch, Continental, Magna table
router.get('/suppliers', authenticate, requireRole('TECHNICIAN'), async (req, res) => {
  try {
    const suppliers = await prisma.supplier.findMany({
      where:   { orgId: req.user.orgId },
      orderBy: { score: 'desc' },
      include: { _count: { select: { scars: true, purchaseOrders: true } } },
    }).catch(() => []);

    res.json({ data: suppliers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PRODUCTION LINES — Scheduling ────────────────────────────────────────────
// Replaces: hardcoded Line 1-6 gauges
router.get('/lines', authenticate, requireRole('TECHNICIAN'), async (req, res) => {
  try {
    const lines = await prisma.productionLine.findMany({
      where:   { orgId: req.user.orgId },
      include: {
        workOrders: { where: { status: 'IN_PROGRESS' }, take: 1 },
        _count: { select: { workOrders: true } },
      },
    }).catch(() => []);

    res.json({ data: lines });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── VISION — Session results ──────────────────────────────────────────────────
// Replaces: hardcoded pass/fail counters in Vision
router.get('/vision/sessions', authenticate, requireRole('TECHNICIAN'), async (req, res) => {
  try {
    const sessions = await prisma.visionSession.findMany({
      where: { job: { orgId: req.user.orgId } },
      orderBy: { startedAt: 'desc' }, take: 10,
      include: {
        job: { select: { name: true, partNumber: true, activeModel: { select: { name: true, latestVersion: true, accuracyPct: true } } } },
        results: { orderBy: { timestamp: 'desc' }, take: 20 },
      },
    });

    res.json({
      data: sessions.map(s => ({
        id: s.id, job: s.job?.name, partNumber: s.job?.partNumber,
        activeModel: s.job?.activeModel ? {
          name: s.job.activeModel.name, version: s.job.activeModel.latestVersion, accuracyPct: s.job.activeModel.accuracyPct,
        } : null,
        totalCount: s.totalCount, passCount: s.passCount, failCount: s.failCount,
        passRate: s.totalCount > 0 ? (s.passCount / s.totalCount * 100).toFixed(1) : '0.0',
        avgCycleMs: s.avgCycleMs,
        recentResults: s.results.map(r => ({
          result: r.result, confidence: r.confidence,
          defectCount: r.defectCount, cycleMs: r.cycleMs, timestamp: r.timestamp,
        })),
        startedAt: s.startedAt,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AUDIT LOG ─────────────────────────────────────────────────────────────────
router.get('/audit', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    const logs = await prisma.auditLog.findMany({
      orderBy: { timestamp: 'desc' }, take: 100,
      include: { user: { select: { name: true, email: true, role: true } } },
    });
    res.json({ data: logs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
