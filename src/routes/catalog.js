/**
 * SensorModel Catalog API
 * ==================================================
 * The real link between the standalone SensorModel product and
 * CorverxisLab. GET routes are global (the catalog is shared across
 * every org, like a product reference library). The org-verticals
 * routes control which of the 18 verticals actually apply to a
 * specific client — so a precision manufacturer only sees/uses
 * "Manufacturing" and "Industrial Automation," not all 18.
 *
 * GET   /api/v1/catalog/verticals              → list of all 18 verticals with entry counts
 * GET   /api/v1/catalog/sensor-models           → catalog entries, optionally ?vertical=Manufacturing
 * GET   /api/v1/org/verticals                   → this org's selected active verticals
 * PATCH /api/v1/org/verticals                   → update which verticals this client operates in
 */

const express = require('express');
const router  = express.Router();
const { prisma } = require('../prisma');
const { authenticate, requireRole } = require('../middleware/rbac');

router.get('/catalog/verticals', authenticate, async (req, res) => {
  try {
    const entries = await prisma.sensorModelCatalogEntry.groupBy({
      by: ['vertical'],
      _count: { _all: true },
    });
    res.json({ data: entries.map(e => ({ vertical: e.vertical, sensorCount: e._count._all })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/catalog/sensor-models', authenticate, async (req, res) => {
  try {
    const { vertical } = req.query;
    const where = vertical ? { vertical } : {};
    const rows = await prisma.sensorModelCatalogEntry.findMany({ where, orderBy: [{ vertical: 'asc' }, { name: 'asc' }] });
    res.json({ data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Live fallback — same resilience pattern as every other module's
// seed-defaults endpoint: if the build-time seed never ran for some
// reason, this populates the catalog immediately without a redeploy.
router.post('/catalog/seed-defaults', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const existing = await prisma.sensorModelCatalogEntry.count();
    if (existing > 0) {
      return res.json({ created: 0, message: `${existing} catalog entries already exist.` });
    }
    const { seedCatalog } = require('../../prisma/seed-catalog');
    await seedCatalog(prisma);
    const total = await prisma.sensorModelCatalogEntry.count();
    res.status(201).json({ created: total, message: `${total} catalog entries seeded.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/org/verticals', authenticate, async (req, res) => {
  try {
    const org = await prisma.org.findUnique({ where: { id: req.user.orgId }, select: { activeVerticals: true } });
    res.json({ data: { activeVerticals: org?.activeVerticals || [] } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/org/verticals', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    const { activeVerticals } = req.body;
    if (!Array.isArray(activeVerticals)) return res.status(400).json({ error: 'activeVerticals must be an array of vertical names' });
    const org = await prisma.org.update({
      where: { id: req.user.orgId },
      data: { activeVerticals },
      select: { activeVerticals: true },
    });
    res.json({ data: org });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/catalog/vision-parts', authenticate, async (req, res) => {
  try {
    const rows = await prisma.visionPartCatalogEntry.findMany({ orderBy: { partName: 'asc' } });
    res.json({ data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/catalog/vision-parts/seed-defaults', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const existing = await prisma.visionPartCatalogEntry.count();
    if (existing > 0) return res.json({ created: 0, message: `${existing} part catalog entries already exist.` });
    const { seedVisionCatalog } = require('../../prisma/seed-vision-catalog');
    await seedVisionCatalog(prisma);
    const total = await prisma.visionPartCatalogEntry.count();
    res.status(201).json({ created: total, message: `${total} part catalog entries seeded.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
