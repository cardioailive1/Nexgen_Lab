/**
 * Corverxis Automation Service
 * ==============================
 * Handles all automatic NCR and Work Order creation:
 *
 *   autoNcrFromVisionFail()  → vision inspection FAIL → NCR
 *   autoNcrFromSensorCrit()  → sensor CRITICAL breach → NCR
 *   autoNcrFromSensorWarn()  → sensor WARNING (repeat) → NCR
 *   autoWoFromErp()          → ERP webhook payload → WorkOrder
 *   nextSequence()           → thread-safe incrementing number
 *   sendNotification()       → email via nodemailer or log fallback
 */

const { prisma } = require('./prisma');
const nodemailer  = require('nodemailer').default || require('nodemailer');

// ── Sequence counter (thread-safe per org per key) ────────────
// Returns next formatted number e.g. "NCR-0295", "WO-2852"
async function nextSequence(orgId, key, prefix, padLen = 4) {
  // Upsert + increment atomically using raw SQL
  await prisma.$executeRaw`
    INSERT INTO counters ("id", "orgId", "key", "value", "updatedAt")
    VALUES (gen_random_uuid()::text, ${orgId}, ${key}, 1, NOW())
    ON CONFLICT ("orgId", "key")
    DO UPDATE SET "value" = counters."value" + 1, "updatedAt" = NOW()
  `;
  const counter = await prisma.counter.findUnique({
    where: { orgId_key: { orgId, key } },
  });
  const num = (counter?.value || 1).toString().padStart(padLen, '0');
  return `${prefix}-${num}`;
}

// ── Get or find the default org ───────────────────────────────
async function getDefaultOrg(orgId) {
  if (orgId) return { id: orgId };
  return prisma.org.findFirst({ orderBy: { createdAt: 'asc' } });
}

// ── AUTO NCR FROM VISION FAIL ─────────────────────────────────
// Called by POST /api/vision/result when result === 'FAIL'
async function autoNcrFromVisionFail({ jobId, sessionId, confidence, defectCount, defectTypes, cycleMs, orgId }) {
  try {
    const org = await getDefaultOrg(orgId);
    if (!org) return null;

    const job = jobId
      ? await prisma.visionJob.findUnique({ where: { id: jobId } })
      : await prisma.visionJob.findFirst();

    if (!job) return null;

    // Don't raise NCR for every single fail — only raise if:
    //   confidence > 0.85 (high confidence it's real) OR defectCount > 0
    if (parseFloat(confidence) < 0.75 && defectCount === 0) return null;

    const severity   = parseFloat(confidence) > 0.95 || defectCount > 1 ? 'CRITICAL' : 'MAJOR';
    const ncrNumber  = await nextSequence(org.id, 'ncr', 'NCR');
    const types      = Array.isArray(defectTypes) ? defectTypes.join(', ') : (defectTypes || 'AI Detection');

    const ncr = await prisma.ncr.create({
      data: {
        number:           ncrNumber,
        partNumber:       job.partNumber,
        customer:         null,
        defectType:       types || 'Vision AI Detection',
        severity,
        description:      `Auto-raised by Corverxis Vision. Job: ${job.name} (${job.partNumber}). ` +
                          `Defects detected: ${defectCount}. Types: ${types}. ` +
                          `Confidence: ${(parseFloat(confidence)*100).toFixed(1)}%. Cycle: ${cycleMs}ms.`,
        quantityAffected: 1,
        orgId:            org.id,
        status:           'OPEN',
        autoRaised:       true,
        autoSource:       `vision:${sessionId || 'unknown'}`,
        sourcePillar:     'QUALITY_CONTROL',
      },
    });

    // Also raise an alert
    await prisma.alert.create({
      data: {
        sensorId:  null,
        severity:  severity === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
        type:      'vision_fail_ncr',
        message:   `${ncrNumber} auto-raised — Vision fail on ${job.partNumber}: ${types} (${(parseFloat(confidence)*100).toFixed(0)}% confidence)`,
        value:     parseFloat(confidence),
        threshold: 0.75,
      },
    }).catch(() => {}); // Alert may fail if sensorId required — that's ok

    await sendNotification({
      orgId:   org.id,
      subject: `[AUTO-NCR] ${ncrNumber} — Vision fail on ${job.partNumber}`,
      body:    `A Non-Conformance Report has been automatically raised.\n\n` +
               `NCR Number:  ${ncrNumber}\n` +
               `Part Number: ${job.partNumber}\n` +
               `Job:         ${job.name}\n` +
               `Severity:    ${severity}\n` +
               `Defects:     ${defectCount} (${types})\n` +
               `Confidence:  ${(parseFloat(confidence)*100).toFixed(1)}%\n` +
               `Raised by:   Corverxis Vision AI (automated)\n\n` +
               `Log in to CorverxisONE → QMS to action this NCR.`,
    });

    console.log(`[AUTO] NCR raised from vision fail: ${ncrNumber} (${severity})`);
    return ncr;
  } catch (e) {
    console.error('[AUTO] autoNcrFromVisionFail failed:', e.message);
    return null;
  }
}

// ── AUTO NCR FROM SENSOR CRITICAL ────────────────────────────
// Called by POST /api/sensors/:id/reading when status === CRITICAL
async function autoNcrFromSensorCrit({ sensor, value, orgId }) {
  try {
    const org = await getDefaultOrg(orgId);
    if (!org) return null;

    // Check if an open auto-NCR already exists for this sensor in the last 4 hours
    // to avoid flooding with duplicate NCRs
    const recent = await prisma.ncr.findFirst({
      where: {
        orgId,
        autoRaised:  true,
        autoSource:  { startsWith: `sensor:${sensor.id}` },
        status:      { in: ['OPEN', 'IN_PROGRESS'] },
        createdAt:   { gte: new Date(Date.now() - 4 * 3600000) },
      },
    });
    if (recent) {
      console.log(`[AUTO] NCR already open for sensor ${sensor.id} — skipping duplicate`);
      return null;
    }

    const ncrNumber = await nextSequence(org.id, 'ncr', 'NCR');
    const asset     = sensor.asset || {};
    const thr       = sensor.thresholds || {};

    // Which pillar actually owns this sensor — a sensor could belong to
    // Predictive Maintenance OR Process Optimization (both use the same
    // Sensor/SensorReading bridge), so this traces back through the
    // linked data source's project rather than assuming one fixed pillar.
    const linkedSource = await prisma.labDataSource.findFirst({
      where: { linkedAssetId: sensor.assetId },
      include: { project: { select: { pillar: true } } },
    });
    const sourcePillar = linkedSource?.project?.pillar || 'PREDICTIVE_MAINTENANCE';

    const ncr = await prisma.ncr.create({
      data: {
        number:           ncrNumber,
        partNumber:       asset.partNumber || 'PROCESS',
        customer:         null,
        defectType:       'Process Parameter OOT',
        severity:         'CRITICAL',
        description:      `Auto-raised: ${sensor.name} exceeded critical threshold.\n` +
                          `Measured value: ${value} ${sensor.unit}\n` +
                          `Critical limit: ${thr.crit} ${sensor.unit}\n` +
                          `Asset: ${asset.name || 'Unknown'} | Location: ${asset.location || '—'}\n` +
                          `Algorithm: ${sensor.mlAlgorithm || 'Ensemble'}\n` +
                          `Action required: Check ${sensor.name} immediately.`,
        quantityAffected: 0,
        orgId:            org.id,
        status:           'OPEN',
        autoRaised:       true,
        autoSource:       `sensor:${sensor.id}:crit`,
        sourcePillar,
      },
    });

    await sendNotification({
      orgId:   org.id,
      subject: `[CRITICAL AUTO-NCR] ${ncrNumber} — ${sensor.name} OOT`,
      body:    `CRITICAL: A sensor has exceeded its critical threshold.\n\n` +
               `NCR Number:  ${ncrNumber}\n` +
               `Sensor:      ${sensor.name}\n` +
               `Value:       ${value} ${sensor.unit}\n` +
               `Limit:       ${thr.crit} ${sensor.unit}\n` +
               `Asset:       ${asset.name || '—'}\n` +
               `Location:    ${asset.location || '—'}\n` +
               `Severity:    CRITICAL\n` +
               `Raised by:   IIoT Automation (automated)\n\n` +
               `IMMEDIATE ACTION REQUIRED. Log in to CorverxisONE → QMS.`,
    });

    console.log(`[AUTO] NCR raised from sensor critical: ${ncrNumber} — ${sensor.name} = ${value} ${sensor.unit}`);
    return ncr;
  } catch (e) {
    console.error('[AUTO] autoNcrFromSensorCrit failed:', e.message);
    return null;
  }
}

// ── AUTO SCAR FROM SUPPLIER ISSUE ─────────────────────────────
// Closes the Supply Chain pillar's Quality loop the same way vision
// and sensor data already do — a real reliability/quality signal
// (late delivery, quality PPM spike) raises a real Supplier
// Corrective Action Report, not just a number sitting in Lab data.
async function autoScarFromSupplierIssue({ supplier, event, severity, details, orgId }) {
  try {
    const org = await getDefaultOrg(orgId);
    if (!org || !supplier) return null;

    // Same dedup principle as the sensor path — don't flood the same
    // supplier with duplicate SCARs within a short window.
    const recent = await prisma.scar.findFirst({
      where: {
        supplierId: supplier.id,
        autoRaised: true,
        autoSource: { startsWith: `supplier:${supplier.id}` },
        status: { in: ['OPEN', 'IN_PROGRESS'] },
        createdAt: { gte: new Date(Date.now() - 24 * 3600000) }, // 24h — supplier issues are lower-frequency than sensor readings
      },
    });
    if (recent) {
      console.log(`[AUTO] SCAR already open for supplier ${supplier.id} — skipping duplicate`);
      return null;
    }

    const scarNumber = await nextSequence(org.id, 'scar', 'SCAR');
    const sevNorm = (severity || 'MAJOR').toUpperCase();

    const scar = await prisma.scar.create({
      data: {
        number:     scarNumber,
        supplierId: supplier.id,
        issue:      `${event}: ${details || 'No additional details provided.'}`,
        severity:   sevNorm === 'CRITICAL' ? 'CRITICAL' : 'MAJOR',
        status:     'OPEN',
        dueAt:      new Date(Date.now() + 14 * 24 * 3600000), // 14-day standard SCAR response window
        autoRaised: true,
        autoSource: `supplier:${supplier.id}:${event}`,
      },
    });

    await sendNotification({
      orgId: org.id,
      subject: `[AUTO-SCAR] ${scarNumber} — ${supplier.name} (${event})`,
      body: `A Supplier Corrective Action Report has been automatically raised.\n\n` +
            `SCAR Number: ${scarNumber}\n` +
            `Supplier:    ${supplier.name}\n` +
            `Event:       ${event}\n` +
            `Severity:    ${scar.severity}\n` +
            `Details:     ${details || '—'}\n` +
            `Due:         ${scar.dueAt.toISOString().slice(0,10)}\n\n` +
            `Log in to CorverxisONE → QMS → SCARs to action this.`,
    });

    console.log(`[AUTO] SCAR raised from supplier issue: ${scarNumber} — ${supplier.name} (${event})`);
    return scar;
  } catch (e) {
    console.error('[AUTO] autoScarFromSupplierIssue failed:', e.message);
    return null;
  }
}

// ── AUTO WORK ORDER FROM ERP ──────────────────────────────────
// Accepts ERP webhook payload and maps to CorverxisONE WorkOrder
// Supports: SAP IDOC-style, generic REST, Infor/Oracle format
async function autoWoFromErp({ payload, orgId, source = 'erp' }) {
  try {
    const org = await getDefaultOrg(orgId);
    if (!org) throw new Error('No organisation found');

    // Normalise payload — handle SAP IDOC, Infor, Oracle, generic
    const wo = normaliseErpWo(payload);
    if (!wo.partNumber) throw new Error('partNumber required');

    // Check for duplicate — same WO number already exists
    if (wo.number) {
      const existing = await prisma.workOrder.findFirst({
        where: { number: wo.number, orgId: org.id },
      });
      if (existing) {
        // Update instead of duplicate
        await prisma.workOrder.update({
          where: { id: existing.id },
          data: {
            quantity:  wo.quantity  || existing.quantity,
            dueDate:   wo.dueDate   || existing.dueDate,
            priority:  wo.priority  || existing.priority,
            status:    wo.status    || existing.status,
            customer:  wo.customer  || existing.customer,
          },
        });
        console.log(`[AUTO] WO updated from ERP: ${wo.number}`);
        return { action: 'updated', number: wo.number };
      }
    }

    // Generate WO number if ERP didn't provide one
    const woNumber = wo.number || await nextSequence(org.id, 'wo', 'WO');

    // Resolve line ID from name/code
    let lineId = wo.lineId || null;
    if (!lineId && wo.lineName) {
      const line = await prisma.productionLine.findFirst({
        where: { orgId: org.id, name: { contains: wo.lineName, mode: 'insensitive' } },
      });
      lineId = line?.id || null;
    }

    const created = await prisma.workOrder.create({
      data: {
        number:      woNumber,
        partNumber:  wo.partNumber,
        customer:    wo.customer    || null,
        quantity:    parseInt(wo.quantity)  || 0,
        completed:   parseInt(wo.completed) || 0,
        status:      wo.status      || 'OPEN',
        priority:    parseInt(wo.priority)  || 3,
        dueDate:     wo.dueDate ? new Date(wo.dueDate) : null,
        lineId,
        orgId:       org.id,
        autoRaised:  true,
        autoSource:  source,
        notes:       wo.notes || `Auto-created from ${source}`,
      },
    });

    await prisma.auditLog.create({
      data: {
        orgId:      org.id,
        action:     'work_order.auto_created',
        resource:   'work_order',
        resourceId: created.id,
        outcome:    'success',
        metadata:   { source, woNumber, partNumber: wo.partNumber },
      },
    }).catch(() => {});

    console.log(`[AUTO] WO created from ERP: ${woNumber} (${wo.partNumber})`);
    return { action: 'created', number: woNumber, id: created.id };
  } catch (e) {
    console.error('[AUTO] autoWoFromErp failed:', e.message);
    throw e;
  }
}

// ── ERP PAYLOAD NORMALISER ────────────────────────────────────
// Maps different ERP formats to a standard internal WO object
function normaliseErpWo(raw) {
  // Generic / CorverxisONE native format
  if (raw.partNumber || raw.part_number) {
    return {
      number:      raw.number      || raw.wo_number   || raw.order_number || null,
      partNumber:  raw.partNumber  || raw.part_number || raw.material,
      customer:    raw.customer    || raw.sold_to      || raw.customer_name || null,
      quantity:    raw.quantity    || raw.planned_qty  || raw.qty          || 0,
      completed:   raw.completed   || raw.confirmed_qty || 0,
      dueDate:     raw.dueDate     || raw.due_date     || raw.finish_date  || null,
      priority:    raw.priority    || 3,
      status:      raw.status      || 'OPEN',
      lineName:    raw.line        || raw.work_center  || raw.workcenter   || null,
      lineId:      raw.lineId      || null,
      notes:       raw.notes       || raw.description  || null,
    };
  }

  // SAP IDOC AUFAL / ORDRSP format
  if (raw.AUFNR || raw.MATNR) {
    return {
      number:      raw.AUFNR || null,
      partNumber:  raw.MATNR || raw.KDMAT,
      customer:    raw.KUNNR || null,
      quantity:    raw.GAMNG || raw.LMNGA || 0,
      completed:   raw.WRMNG || 0,
      dueDate:     raw.GLTRP ? new Date(raw.GLTRP) : null,
      priority:    raw.IPRIO || 3,
      status:      'OPEN',
      lineName:    raw.ARBPL || raw.WERKS || null,
      notes:       `SAP Order ${raw.AUFNR}`,
    };
  }

  // Oracle / Infor format
  if (raw.WO_NUM || raw.workOrderNumber) {
    return {
      number:      raw.WO_NUM || raw.workOrderNumber,
      partNumber:  raw.ITEM_NUM || raw.itemNumber,
      customer:    raw.CUST_ID  || raw.customerId || null,
      quantity:    raw.QTY_ORDERED || raw.quantityOrdered || 0,
      completed:   raw.QTY_COMPLETED || 0,
      dueDate:     raw.DUE_DATE || raw.dueDate || null,
      priority:    3,
      status:      'OPEN',
      lineName:    raw.RESOURCE_ID || raw.workCenter || null,
      notes:       `Oracle/Infor WO ${raw.WO_NUM || raw.workOrderNumber}`,
    };
  }

  // Plex Manufacturing Cloud format
  if (raw.PlexWONo || raw.PartNo) {
    return {
      number:      raw.PlexWONo    || raw.WONumber || null,
      partNumber:  raw.PartNo      || raw.PartNumber,
      customer:    raw.CustomerCode|| raw.Customer || null,
      quantity:    raw.Quantity    || raw.PlannedQty || 0,
      completed:   raw.CompletedQty|| 0,
      dueDate:     raw.DueDate     || raw.RequiredDate || null,
      priority:    raw.Priority    || 3,
      status:      'OPEN',
      lineName:    raw.WorkCenter  || raw.PlexWorkcenter || null,
      notes:       'Plex WO ' + (raw.PlexWONo || raw.WONumber),
    };
  }

  // Fallback — pass through whatever we have
  return raw;
}

// ── EMAIL NOTIFICATION ────────────────────────────────────────
// Sends email via SMTP if configured, otherwise logs to DB only
async function sendNotification({ orgId, subject, body, to }) {
  try {
    // Get recipient — use env QUALITY_EMAIL or ADMIN_EMAIL
    const recipient = to ||
      process.env.QUALITY_EMAIL ||
      process.env.ADMIN_EMAIL   ||
      'notifications@corverxis.com';

    // Log to DB always (visible in audit log even without SMTP)
    await prisma.emailLog.create({
      data: { orgId: orgId || null, to: recipient, subject, body, status: 'pending' },
    });

    // Only send email if SMTP is configured
    if (!process.env.SMTP_HOST) {
      await prisma.emailLog.updateMany({
        where: { subject, status: 'pending' },
        data:  { status: 'logged_no_smtp' },
      });
      console.log(`[NOTIFY] Email logged (no SMTP): ${subject}`);
      return;
    }

    const transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    await transporter.sendMail({
      from:    process.env.SMTP_FROM || `"Corverxis Platform" <${process.env.SMTP_USER}>`,
      to:      recipient,
      subject: `${subject}`,
      text:    body,
      html:    `<pre style="font-family:monospace;font-size:13px;line-height:1.6;color:#1a1a1a">${body}</pre>`,
    });

    await prisma.emailLog.updateMany({
      where: { subject, status: 'pending' },
      data:  { status: 'sent', sentAt: new Date() },
    });

    console.log(`[NOTIFY] Email sent → ${recipient}: ${subject}`);
  } catch (e) {
    console.error('[NOTIFY] Email failed:', e.message);
    await prisma.emailLog.updateMany({
      where: { subject, status: 'pending' },
      data:  { status: 'failed', error: e.message },
    }).catch(() => {});
  }
}

module.exports = {
  autoNcrFromVisionFail,
  autoNcrFromSensorCrit,
  autoScarFromSupplierIssue,
  autoWoFromErp,
  sendNotification,
  nextSequence,
  normaliseErpWo,
};
