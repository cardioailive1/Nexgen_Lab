/**
 * Inventory & BOM + Supplier Management API Routes
 * ==================================================
 * GET  /api/v1/inventory              → list all inventory items with stock status
 * GET  /api/v1/inventory/:id          → single item with transactions + lots
 * POST /api/v1/inventory              → create new inventory item
 * PATCH /api/v1/inventory/:id         → update item details
 * POST /api/v1/inventory/:id/receive  → goods receipt (auto stock transaction)
 * POST /api/v1/inventory/:id/issue    → issue to production
 * POST /api/v1/inventory/:id/adjust   → manual adjustment
 * POST /api/v1/inventory/:id/transfer → transfer between locations
 * GET  /api/v1/inventory/:id/transactions → transaction history
 * GET  /api/v1/inventory/:id/lots        → lot list
 * POST /api/v1/inventory/:id/lots        → create lot
 *
 * GET  /api/v1/boms                   → list BOMs
 * GET  /api/v1/boms/:id               → BOM with all lines + item detail
 * POST /api/v1/boms                   → create BOM
 * POST /api/v1/boms/:id/lines         → add BOM line
 * DELETE /api/v1/boms/:id/lines/:lineId → remove BOM line
 * GET  /api/v1/boms/:id/mrp          → MRP explosion — qty required vs on hand
 *
 * GET  /api/v1/supplier-mgmt          → supplier list with audits + certs + contacts
 * GET  /api/v1/supplier-mgmt/:id      → full supplier profile
 * POST /api/v1/supplier-mgmt/:id/audit          → schedule/create audit
 * PATCH /api/v1/supplier-mgmt/:id/audit/:auditId → complete audit
 * POST /api/v1/supplier-mgmt/:id/qualification  → add certification
 * POST /api/v1/supplier-mgmt/:id/contact        → add contact
 * POST /api/v1/supplier-mgmt/:id/devplan        → add development plan
 * PATCH /api/v1/supplier-mgmt/:id/devplan/:planId → update plan progress
 */

const express  = require('express');
const router   = express.Router();
const { prisma } = require('../prisma');
const { authenticate, requireRole } = require('../middleware/rbac');
const { nextSequence } = require('../automation');

// ── Helper: stock status ───────────────────────────────────────
function stockStatus(item) {
  const { onHand, safetyStock, reorderPoint } = item;
  if (onHand <= 0)              return { status: 'STOCK_OUT',    badge: 'crit', days: 0 };
  if (onHand < safetyStock)     return { status: 'BELOW_SAFETY', badge: 'crit', days: null };
  if (onHand < reorderPoint)    return { status: 'REORDER_NOW',  badge: 'warn', days: null };
  return { status: 'ADEQUATE', badge: 'ok', days: null };
}

// ══════════════════════════════════════════════════════════════
// INVENTORY
// ══════════════════════════════════════════════════════════════

// GET /api/v1/inventory — list all items with status
router.get('/inventory', authenticate, requireRole('TECHNICIAN'), async (req, res) => {
  try {
    const { category, status, search, partNumbers, limit = 100 } = req.query;
    const where = { orgId: req.user.orgId, active: true };
    if (category) where.category = category;
    if (search)   where.OR = [
      { partNumber:  { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
    ];
    if (partNumbers) {
      const list = partNumbers.split(',').map(s => s.trim()).filter(Boolean);
      if (list.length) where.partNumber = { in: list };
    }

    const items = await prisma.inventoryItem.findMany({
      where,
      include: {
        supplier: { select: { name: true } },
        _count:   { select: { transactions: true, lots: true } },
      },
      orderBy: { partNumber: 'asc' },
      take: parseInt(limit),
    });

    const data = items.map(item => {
      const st = stockStatus(item);
      const value = item.onHand * item.unitCost;
      return {
        id:           item.id,
        partNumber:   item.partNumber,
        description:  item.description,
        category:     item.category,
        uom:          item.uom,
        onHand:       item.onHand,
        safetyStock:  item.safetyStock,
        reorderPoint: item.reorderPoint,
        reorderQty:   item.reorderQty,
        unitCost:     item.unitCost,
        currency:     item.currency,
        value:        parseFloat(value.toFixed(2)),
        location:     item.location,
        warehouse:    item.warehouse,
        supplier:     item.supplier?.name || null,
        supplierId:   item.supplierId,
        leadTimeDays: item.leadTimeDays,
        lotTracked:   item.lotTracked,
        ...st,
        txnCount:     item._count.transactions,
        lotCount:     item._count.lots,
      };
    });

    // Filter by status after mapping
    const filtered = status ? data.filter(d => d.status === status) : data;

    // Summary
    const summary = {
      total:         data.length,
      stockOut:      data.filter(d => d.status === 'STOCK_OUT').length,
      belowSafety:   data.filter(d => d.status === 'BELOW_SAFETY').length,
      reorderNow:    data.filter(d => d.status === 'REORDER_NOW').length,
      adequate:      data.filter(d => d.status === 'ADEQUATE').length,
      totalValue:    parseFloat(data.reduce((a, d) => a + d.value, 0).toFixed(2)),
    };

    res.json({ data: filtered, summary, timestamp: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/v1/inventory/:id — single item with full detail
router.get('/inventory/:id', authenticate, requireRole('TECHNICIAN'), async (req, res) => {
  try {
    const item = await prisma.inventoryItem.findUnique({
      where: { id: req.params.id },
      include: {
        supplier:     { select: { id: true, name: true, otif: true, rating: true } },
        transactions: { orderBy: { createdAt: 'desc' }, take: 50 },
        lots:         { orderBy: { receivedAt: 'desc' }, take: 20 },
        bomLines:     { include: { bom: { select: { name: true, partNumber: true } } } },
      },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json({ data: { ...item, ...stockStatus(item) } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/v1/inventory — create item
router.post('/inventory', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const {
      partNumber, description, category = 'RAW_MATERIAL', uom = 'EA',
      onHand = 0, safetyStock = 0, reorderPoint = 0, reorderQty = 0,
      unitCost = 0, currency = 'USD', location, warehouse,
      supplierId, leadTimeDays = 7, lotTracked = false, serialTracked = false,
    } = req.body;

    if (!partNumber || !description) return res.status(400).json({ error: 'partNumber and description required' });

    // Check duplicate
    const existing = await prisma.inventoryItem.findUnique({
      where: { orgId_partNumber: { orgId: req.user.orgId, partNumber } },
    });
    if (existing) return res.status(409).json({ error: `Part ${partNumber} already exists` });

    const item = await prisma.inventoryItem.create({
      data: {
        orgId: req.user.orgId, partNumber, description,
        category, uom, onHand: parseFloat(onHand), safetyStock: parseFloat(safetyStock),
        reorderPoint: parseFloat(reorderPoint), reorderQty: parseFloat(reorderQty),
        unitCost: parseFloat(unitCost), currency, location, warehouse,
        supplierId: supplierId || null, leadTimeDays: parseInt(leadTimeDays),
        lotTracked, serialTracked,
      },
    });

    // If initial qty > 0, create opening balance transaction
    if (parseFloat(onHand) > 0) {
      await prisma.stockTransaction.create({
        data: {
          itemId: item.id, type: 'ADJUSTMENT_IN',
          qty: parseFloat(onHand), qtyBefore: 0, qtyAfter: parseFloat(onHand),
          unitCost: parseFloat(unitCost), reason: 'Opening balance',
          createdBy: req.user.id,
        },
      });
    }

    await prisma.auditLog.create({
      data: { userId: req.user.id, orgId: req.user.orgId, action: 'inventory.created',
              resource: 'inventory_item', resourceId: item.id, outcome: 'success',
              metadata: { partNumber, description, onHand } },
    }).catch(() => {});

    res.status(201).json({ success: true, data: { ...item, ...stockStatus(item) } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/v1/inventory/:id — update item
router.patch('/inventory/:id', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const allowed = ['description','category','uom','safetyStock','reorderPoint',
                     'reorderQty','unitCost','currency','location','warehouse',
                     'supplierId','leadTimeDays','lotTracked','active'];
    const data = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) data[k] = req.body[k]; });
    const item = await prisma.inventoryItem.update({ where: { id: req.params.id }, data });
    res.json({ success: true, data: { ...item, ...stockStatus(item) } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Stock transaction helpers ──────────────────────────────────
async function createStockTxn({ itemId, type, qty, unitCost, reference, workOrderId, lotNumber, location, reason, notes, createdBy, orgId }) {
  const item = await prisma.inventoryItem.findUnique({ where: { id: itemId } });
  if (!item) throw new Error('Item not found');

  const qtyBefore = item.onHand;
  const isOut = ['ISSUE','ADJUSTMENT_OUT','SCRAP','TRANSFER'].includes(type);
  const newQty = parseFloat((qtyBefore + (isOut ? -Math.abs(qty) : Math.abs(qty))).toFixed(4));
  if (newQty < 0) throw new Error(`Insufficient stock. On hand: ${qtyBefore} ${item.uom}, requested: ${qty}`);

  const [txn] = await prisma.$transaction([
    prisma.stockTransaction.create({
      data: {
        itemId, type, qty: parseFloat(qty), qtyBefore,
        qtyAfter: newQty, unitCost: unitCost ? parseFloat(unitCost) : item.unitCost,
        reference, workOrderId, lotNumber, location: location || item.location,
        reason, notes, createdBy,
      },
    }),
    prisma.inventoryItem.update({
      where: { id: itemId },
      data:  { onHand: newQty },
    }),
  ]);

  // Auto-trigger reorder alert if below safety stock after issue
  if (isOut && newQty < item.safetyStock) {
    await prisma.alert.create({
      data: {
        sensorId:  null,
        severity:  newQty <= 0 ? 'CRITICAL' : 'WARNING',
        type:      'stock_below_safety',
        message:   `${item.partNumber} — ${item.description}: stock ${newQty} ${item.uom} below safety stock ${item.safetyStock} ${item.uom}`,
        value:     newQty,
        threshold: item.safetyStock,
      },
    }).catch(() => {});
  }

  return { txn, newQty, item };
}

// POST /api/v1/inventory/:id/receive — goods receipt
router.post('/inventory/:id/receive', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const { qty, unitCost, reference, lotNumber, supplierId, notes } = req.body;
    if (!qty || parseFloat(qty) <= 0) return res.status(400).json({ error: 'qty must be > 0' });

    const result = await createStockTxn({
      itemId: req.params.id, type: 'RECEIPT',
      qty, unitCost, reference: reference || 'GRN',
      lotNumber, notes, createdBy: req.user.id,
    });

    // Create lot record if lot-tracked
    if (lotNumber) {
      const item = await prisma.inventoryItem.findUnique({ where: { id: req.params.id } });
      if (item?.lotTracked) {
        await prisma.inventoryLot.create({
          data: {
            itemId: req.params.id, lotNumber, qty: parseFloat(qty),
            supplierId: supplierId || item.supplierId || null,
            certRef: reference,
          },
        }).catch(() => {});
      }
    }

    res.status(201).json({ success: true, newQty: result.newQty, txnId: result.txn.id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /api/v1/inventory/:id/issue — issue to production
router.post('/inventory/:id/issue', authenticate, requireRole('TECHNICIAN'), async (req, res) => {
  try {
    const { qty, workOrderId, lotNumber, reason, notes } = req.body;
    if (!qty || parseFloat(qty) <= 0) return res.status(400).json({ error: 'qty must be > 0' });

    const result = await createStockTxn({
      itemId: req.params.id, type: 'ISSUE',
      qty, workOrderId, lotNumber,
      reason: reason || 'Production issue', notes, createdBy: req.user.id,
    });
    res.status(201).json({ success: true, newQty: result.newQty, txnId: result.txn.id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /api/v1/inventory/:id/adjust — manual adjustment (cycle count, write-off)
router.post('/inventory/:id/adjust', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const { qty, type = 'ADJUSTMENT_IN', reason, notes } = req.body;
    if (qty === undefined) return res.status(400).json({ error: 'qty required' });

    const txnType = parseFloat(qty) >= 0 ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT';
    const result = await createStockTxn({
      itemId: req.params.id, type: txnType,
      qty: Math.abs(parseFloat(qty)),
      reason: reason || 'Manual adjustment', notes, createdBy: req.user.id,
    });

    await prisma.auditLog.create({
      data: { userId: req.user.id, orgId: req.user.orgId, action: 'inventory.adjusted',
              resource: 'inventory_item', resourceId: req.params.id, outcome: 'success',
              metadata: { qty, reason } },
    }).catch(() => {});

    res.status(201).json({ success: true, newQty: result.newQty });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /api/v1/inventory/:id/transfer — between locations/warehouses
router.post('/inventory/:id/transfer', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const { qty, fromLocation, toLocation, notes } = req.body;
    if (!qty || !toLocation) return res.status(400).json({ error: 'qty and toLocation required' });

    const result = await createStockTxn({
      itemId: req.params.id, type: 'TRANSFER', qty,
      location: toLocation, reason: `Transfer from ${fromLocation || 'default'} to ${toLocation}`,
      notes, createdBy: req.user.id,
    });
    // Update location
    await prisma.inventoryItem.update({
      where: { id: req.params.id }, data: { location: toLocation },
    });
    res.status(201).json({ success: true, newQty: result.newQty });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /api/v1/inventory/:id/transactions
router.get('/inventory/:id/transactions', authenticate, requireRole('TECHNICIAN'), async (req, res) => {
  try {
    const { limit = 50, type } = req.query;
    const where = { itemId: req.params.id };
    if (type) where.type = type;
    const txns = await prisma.stockTransaction.findMany({
      where, orderBy: { createdAt: 'desc' }, take: parseInt(limit),
    });
    res.json({ data: txns });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET/POST /api/v1/inventory/:id/lots
router.get('/inventory/:id/lots', authenticate, requireRole('TECHNICIAN'), async (req, res) => {
  try {
    const lots = await prisma.inventoryLot.findMany({
      where: { itemId: req.params.id }, orderBy: { receivedAt: 'desc' },
    });
    res.json({ data: lots });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/inventory/:id/lots', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const { lotNumber, qty, expiresAt, certRef, notes } = req.body;
    if (!lotNumber || !qty) return res.status(400).json({ error: 'lotNumber and qty required' });
    const lot = await prisma.inventoryLot.create({
      data: { itemId: req.params.id, lotNumber, qty: parseFloat(qty),
              expiresAt: expiresAt ? new Date(expiresAt) : null, certRef, notes },
    });
    res.status(201).json({ success: true, data: lot });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ERP auto-receive — called from POST /api/erp/receipt
router.post('/inventory/erp/receive', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const { partNumber, qty, unitCost, reference, lotNumber, supplierId } = req.body;
    if (!partNumber || !qty) return res.status(400).json({ error: 'partNumber and qty required' });

    const item = await prisma.inventoryItem.findUnique({
      where: { orgId_partNumber: { orgId: req.user.orgId, partNumber } },
    });
    if (!item) return res.status(404).json({ error: `Part ${partNumber} not in inventory. Create it first.` });

    const result = await createStockTxn({
      itemId: item.id, type: 'RECEIPT', qty, unitCost,
      reference: reference || 'ERP-GRN', lotNumber,
      notes: 'Auto-received from ERP', createdBy: 'erp-integration',
    });
    res.status(201).json({ success: true, partNumber, newQty: result.newQty });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// BOM
// ══════════════════════════════════════════════════════════════

router.get('/boms', authenticate, requireRole('TECHNICIAN'), async (req, res) => {
  try {
    const boms = await prisma.bOM.findMany({
      where:   { orgId: req.user.orgId, active: true },
      include: { _count: { select: { lines: true } } },
      orderBy: { partNumber: 'asc' },
    });
    res.json({ data: boms });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/boms/:id', authenticate, requireRole('TECHNICIAN'), async (req, res) => {
  try {
    const bom = await prisma.bOM.findUnique({
      where:   { id: req.params.id },
      include: { lines: { include: { item: true }, orderBy: { seq: 'asc' } } },
    });
    if (!bom) return res.status(404).json({ error: 'BOM not found' });
    res.json({ data: bom });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/boms', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const { name, partNumber, revision = 'Rev A', description, qty = 1, uom = 'EA' } = req.body;
    if (!name || !partNumber) return res.status(400).json({ error: 'name and partNumber required' });
    const bom = await prisma.bOM.create({
      data: { orgId: req.user.orgId, name, partNumber, revision, description, qty: parseFloat(qty), uom },
    });
    res.status(201).json({ success: true, data: bom });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/boms/:id/lines', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const { itemId, qty, uom, seq, refDes, critical, notes } = req.body;
    if (!itemId || !qty) return res.status(400).json({ error: 'itemId and qty required' });
    const line = await prisma.bomLine.create({
      data: { bomId: req.params.id, itemId, qty: parseFloat(qty),
              uom: uom || 'EA', seq: parseInt(seq) || 10,
              refDes, critical: !!critical, notes },
      include: { item: true },
    });
    res.status(201).json({ success: true, data: line });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/boms/:id/lines/:lineId', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    await prisma.bomLine.delete({ where: { id: req.params.lineId } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// MRP explosion — for a given BOM and production qty, show required vs available
router.get('/boms/:id/mrp', authenticate, requireRole('TECHNICIAN'), async (req, res) => {
  try {
    const { qty = 1 } = req.query;
    const bom = await prisma.bOM.findUnique({
      where:   { id: req.params.id },
      include: { lines: { include: { item: true }, orderBy: { seq: 'asc' } } },
    });
    if (!bom) return res.status(404).json({ error: 'BOM not found' });

    const productionQty = parseFloat(qty);
    const lines = bom.lines.map(line => {
      const required = line.qty * productionQty;
      const available = line.item.onHand;
      const shortfall = Math.max(0, required - available);
      const status = shortfall > 0 ? (available === 0 ? 'STOCK_OUT' : 'SHORT') : 'AVAILABLE';
      return {
        seq:         line.seq,
        itemId:      line.itemId,
        partNumber:  line.item.partNumber,
        description: line.item.description,
        uomPer:      line.uom,
        qtyPer:      line.qty,
        required,
        available,
        shortfall,
        status,
        leadTimeDays: line.item.leadTimeDays,
        critical:    line.critical,
      };
    });

    const canProduce = lines.every(l => l.status === 'AVAILABLE');
    const maxQty = lines.length ? Math.min(...lines.map(l => Math.floor(l.available / l.qtyPer))) : 0;

    res.json({
      bom:         { id: bom.id, name: bom.name, partNumber: bom.partNumber },
      productionQty,
      canProduce,
      maxQty,
      criticalShortages: lines.filter(l => l.status !== 'AVAILABLE' && l.critical).length,
      lines,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// SUPPLIER MANAGEMENT
// ══════════════════════════════════════════════════════════════

router.get('/supplier-mgmt', authenticate, requireRole('TECHNICIAN'), async (req, res) => {
  try {
    const suppliers = await prisma.supplier.findMany({
      where:   { orgId: req.user.orgId },
      include: {
        scars:          { where: { status: { not: 'CLOSED' } } },
        audits:         { orderBy: { plannedDate: 'desc' }, take: 3 },
        qualifications: { where: { status: 'ACTIVE' } },
        contacts:       { where: { isPrimary: true }, take: 1 },
        devPlans:       { where: { status: { not: 'CLOSED' } } },
        _count:         { select: { scars: true, purchaseOrders: true } },
      },
      orderBy: { score: 'desc' },
    });
    res.json({ data: suppliers });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/supplier-mgmt/:id', authenticate, requireRole('TECHNICIAN'), async (req, res) => {
  try {
    const supplier = await prisma.supplier.findUnique({
      where:   { id: req.params.id },
      include: {
        scars:          { orderBy: { issuedAt: 'desc' } },
        purchaseOrders: { orderBy: { orderedAt: 'desc' }, take: 10 },
        audits:         { orderBy: { plannedDate: 'desc' } },
        qualifications: true,
        contacts:       true,
        devPlans:       { orderBy: { targetDate: 'asc' } },
        inventoryItems: { select: { partNumber: true, description: true, onHand: true, uom: true } },
      },
    });
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    res.json({ data: supplier });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/v1/supplier-mgmt/:id/audit
router.post('/supplier-mgmt/:id/audit', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const { auditType = 'ROUTINE', plannedDate, auditorName, notes } = req.body;
    if (!plannedDate) return res.status(400).json({ error: 'plannedDate required' });
    const audit = await prisma.supplierAudit.create({
      data: { supplierId: req.params.id, auditType, plannedDate: new Date(plannedDate),
              auditorName, notes, status: 'PLANNED' },
    });
    res.status(201).json({ success: true, data: audit });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/v1/supplier-mgmt/:id/audit/:auditId — complete an audit
router.patch('/supplier-mgmt/:id/audit/:auditId', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const { findings = 0, majorFindings = 0, score, reportRef, notes, nextAuditAt } = req.body;
    const audit = await prisma.supplierAudit.update({
      where: { id: req.params.auditId },
      data: { completedAt: new Date(), status: 'COMPLETED', findings: parseInt(findings),
              majorFindings: parseInt(majorFindings), score: score ? parseFloat(score) : null,
              reportRef, notes, nextAuditAt: nextAuditAt ? new Date(nextAuditAt) : null },
    });
    // Update supplier score if audit score provided
    if (score) {
      await prisma.supplier.update({
        where: { id: req.params.id },
        data:  { score: parseFloat(score) },
      });
    }
    res.json({ success: true, data: audit });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/v1/supplier-mgmt/:id/qualification
router.post('/supplier-mgmt/:id/qualification', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    const { standard, certNumber, issuedAt, expiresAt, body, scope } = req.body;
    if (!standard) return res.status(400).json({ error: 'standard required' });
    const qual = await prisma.supplierQualification.create({
      data: { supplierId: req.params.id, standard, certNumber,
              issuedAt: issuedAt ? new Date(issuedAt) : null,
              expiresAt: expiresAt ? new Date(expiresAt) : null,
              body, scope, status: 'ACTIVE' },
    });
    res.status(201).json({ success: true, data: qual });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/v1/supplier-mgmt/:id/contact
router.post('/supplier-mgmt/:id/contact', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const { name, role, email, phone, isPrimary = false } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    if (isPrimary) {
      await prisma.supplierContact.updateMany({
        where: { supplierId: req.params.id },
        data:  { isPrimary: false },
      });
    }
    const contact = await prisma.supplierContact.create({
      data: { supplierId: req.params.id, name, role, email, phone, isPrimary },
    });
    res.status(201).json({ success: true, data: contact });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/v1/supplier-mgmt/:id/devplan
router.post('/supplier-mgmt/:id/devplan', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const { title, target, targetDate, owner, notes } = req.body;
    if (!title || !targetDate) return res.status(400).json({ error: 'title and targetDate required' });
    const plan = await prisma.supplierDevelopmentPlan.create({
      data: { supplierId: req.params.id, title, target: target || title,
              targetDate: new Date(targetDate), owner, notes },
    });
    res.status(201).json({ success: true, data: plan });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/v1/supplier-mgmt/:id/devplan/:planId
router.patch('/supplier-mgmt/:id/devplan/:planId', authenticate, requireRole('MANAGER'), async (req, res) => {
  try {
    const { progress, status, notes } = req.body;
    const plan = await prisma.supplierDevelopmentPlan.update({
      where: { id: req.params.planId },
      data:  { progress: progress !== undefined ? parseInt(progress) : undefined,
               status, notes },
    });
    res.json({ success: true, data: plan });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
