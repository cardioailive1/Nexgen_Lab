/**
 * Corverxis Technologies — Platform Server
 * Full-stack: Express + Prisma + OAuth + RBAC + WebSocket
 *
 * Routes:
 *   GET  /              → CorverxisONE (requires auth)
 *   GET  /vision        → Corverxis Vision (requires auth)
 *   GET  /admin         → Admin panel (ADMIN+)
 *   GET  /auth/*        → OAuth sign-in/register/callbacks
 *   GET  /api/health    → health check (public)
 *   GET  /api/status    → platform status (auth required)
 *   GET  /api/sensors   → sensor readings (TECHNICIAN+)
 *   POST /api/sensors/:id/reading → post reading (TECHNICIAN+)
 *   POST /api/vision/result → save vision result (ENGINEER+)
 *   GET  /api/admin/users   → list users (ADMIN+)
 *   PATCH /api/admin/users  → approve/reject (ADMIN+)
 *   POST /api/register  → public registration
 *   WS   /ws/vision     → live vision stats
 *   WS   /ws/sensors    → live sensor broadcast
 */

const express      = require('express');
const http         = require('http');
const WebSocket    = require('ws');
const cors         = require('cors');
const helmet       = require('helmet');
const compression  = require('compression');
const rateLimit    = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const session      = require('express-session');
const path         = require('path');
const fs           = require('fs');

const { prisma }     = require('./prisma');
const { passport }   = require('./auth/oauth');
const { authenticate, requireRole, requirePermission } = require('./middleware/rbac');
const {
  autoNcrFromVisionFail,
  autoNcrFromSensorCrit,
} = require('./automation');
const authRouter     = require('./routes/auth');
const adminRouter    = require('./routes/admin');
const erpRouter      = require('./routes/erp');
const inventoryRouter  = require('./routes/inventory');
const improvementRouter = require('./routes/improvement');
const apiRouter      = require('./routes/api');
const hrimRouter     = require('./routes/hrim');
const changeRouter   = require('./routes/change');
const labRouter      = require('./routes/lab');
const { router: onboardingRouter, bootstrapOrg } = require('./routes/onboarding');
const catalogRouter  = require('./routes/catalog');

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT   || 3000;
const HOST   = process.env.HOST   || '0.0.0.0';
const PUBLIC = path.join(__dirname, '..', 'public');

// ── Middleware ────────────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(compression());
app.use(cors({ origin: process.env.APP_URL || '*', credentials: true }));
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Session required by passport (even though we use JWT, passport needs it)
app.use(session({
  secret:            process.env.SESSION_SECRET || 'cvx-session-secret-change-in-prod',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    secure:   process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge:   8 * 60 * 60 * 1000,
  },
}));

app.use(passport.initialize());
app.use(passport.session());

// Rate limiting
app.use('/api/', rateLimit({ windowMs: 60000, max: 500,
  skip: (req) => req.path === '/health' }));
app.use('/auth/', rateLimit({ windowMs: 60000, max: 30 }));

// ── Auth & Admin routers ──────────────────────────────────────────────────────
app.use('/auth',  authRouter);
app.use('/admin', adminRouter);
app.use('/api/erp', erpRouter);
app.use('/api', erpRouter);
app.use('/api/v1', inventoryRouter);
app.use('/api/v1', improvementRouter); // automation/ncrs + automation/log sub-routes
app.use('/api/v1', apiRouter);
app.use('/api/v1', hrimRouter);
app.use('/api/v1', changeRouter);
app.use('/api/v1', labRouter);
app.use('/api/v1', onboardingRouter);
app.use('/api/v1', catalogRouter);

// ── Public routes ─────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  let dbOk = false;
  try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch (_) {}
  res.json({
    status:    dbOk ? 'ok' : 'degraded',
    platform:  'Corverxis Technologies',
    version:   '1.0.0',
    uptime:    Math.round(process.uptime()),
    db:        dbOk ? 'connected' : 'error',
    timestamp: new Date().toISOString(),
    files: {
      one:    fs.existsSync(path.join(PUBLIC, 'corverxis-one.html')),
      vision: fs.existsSync(path.join(PUBLIC, 'corverxis-vision.html')),
    },
    ws_clients: { vision: wsVisionClients.size, sensors: wsSensorClients.size },
  });
});

// ── Registration (public) ─────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, role = 'ENGINEER', orgName, orgSlug, orgId } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'name and email required' });

    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    let resolvedOrgId = orgId || null;
    const isSuperAdmin = role === 'SUPER_ADMIN';

    if (isSuperAdmin) {
      if (!orgName || !orgSlug) return res.status(400).json({ error: 'orgName and orgSlug required' });
      const existingOrg = await prisma.org.findUnique({ where: { slug: orgSlug } });
      if (existingOrg) return res.status(409).json({ error: 'Organisation slug already taken' });
      const org = await prisma.org.create({ data: { name: orgName, slug: orgSlug } });
      resolvedOrgId = org.id;
      // A brand-new org otherwise starts completely empty — no departments,
      // no change initiatives/risks, no lab projects — leaving a new client's
      // first admin staring at a blank platform. Bootstrap it immediately.
      bootstrapOrg(org.id, { verticals: req.body.verticals }).catch((e) => console.error('⚠ Org bootstrap failed (non-fatal):', e.message));
    }

    const user = await prisma.user.create({
      data: {
        name,
        email:        email.toLowerCase(),
        role:         isSuperAdmin ? 'SUPER_ADMIN' : 'PENDING',
        orgId:        resolvedOrgId,
        approved:     isSuperAdmin,
        approvedAt:   isSuperAdmin ? new Date() : null,
        registeredAt: new Date(),
      },
    });

    await prisma.auditLog.create({
      data: {
        userId:    user.id,
        orgId:     resolvedOrgId ?? null,
        action:    isSuperAdmin ? 'user.register_super_admin' : 'user.register_pending',
        resource:  'user',
        resourceId: user.id,
        outcome:   'success',
        metadata:  { role, email },
      },
    }).catch(() => {});

    res.status(201).json({
      success:  true,
      approved: isSuperAdmin,
      message:  isSuperAdmin
        ? 'Organisation and Super Admin created. Sign in with your OAuth provider.'
        : 'Registration submitted. Awaiting admin approval.',
      userId: user.id,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Internal client provisioning (Corverxis staff only) ────────────────────
// Deliberately separate from /api/register: that endpoint lets ANY visitor
// create their own org via self-service self-registration. This one lets
// Corverxis staff create an org and its first admin ON BEHALF OF a client
// — a genuinely different trust boundary, so it's gated by a shared secret
// rather than any user's session/role. There's no "platform admin" user
// role modeled in this system yet; a shared secret known only to internal
// staff is the honest, pragmatic gate until that's built properly.
app.post('/api/internal/provision-client', async (req, res) => {
  try {
    const providedSecret = req.headers['x-platform-admin-secret'];
    if (!process.env.PLATFORM_ADMIN_SECRET) {
      return res.status(503).json({ error: 'Internal provisioning is not configured on this deployment (PLATFORM_ADMIN_SECRET not set).' });
    }
    if (!providedSecret || providedSecret !== process.env.PLATFORM_ADMIN_SECRET) {
      return res.status(403).json({ error: 'Invalid or missing platform admin secret.' });
    }

    const { orgName, orgSlug, adminName, adminEmail, verticals } = req.body;
    if (!orgName || !orgSlug || !adminName || !adminEmail) {
      return res.status(400).json({ error: 'orgName, orgSlug, adminName, and adminEmail are all required.' });
    }

    const existingOrg = await prisma.org.findUnique({ where: { slug: orgSlug } });
    if (existingOrg) return res.status(409).json({ error: 'Organisation slug already taken.' });

    const existingUser = await prisma.user.findUnique({ where: { email: adminEmail.toLowerCase() } });
    if (existingUser) return res.status(409).json({ error: 'That email is already registered to another account.' });

    const org = await prisma.org.create({ data: { name: orgName, slug: orgSlug } });

    const user = await prisma.user.create({
      data: {
        name: adminName, email: adminEmail.toLowerCase(), role: 'SUPER_ADMIN',
        orgId: org.id, approved: true, approvedAt: new Date(), registeredAt: new Date(),
      },
    });

    const bootstrapResults = await bootstrapOrg(org.id, { verticals: Array.isArray(verticals) ? verticals : undefined });

    await prisma.auditLog.create({
      data: {
        userId: user.id, orgId: org.id, action: 'org.provisioned_by_staff', resource: 'org', resourceId: org.id,
        outcome: 'success', metadata: { orgName, orgSlug, adminEmail, provisionedVia: 'internal-tool' },
      },
    }).catch(() => {});

    res.status(201).json({
      success: true,
      org: { id: org.id, name: org.name, slug: org.slug },
      admin: { id: user.id, name: user.name, email: user.email },
      bootstrap: bootstrapResults,
      message: `${orgName} provisioned. ${adminName} can sign in immediately via OAuth using ${adminEmail} — no separate password to set.`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/register', async (req, res) => {
  const { org } = req.query;
  if (!org) return res.status(400).json({ error: 'org slug required' });
  const found = await prisma.org.findUnique({ where: { slug: org } });
  res.json(found ? { exists: true, name: found.name, id: found.id } : { exists: false });
});

// ── Protected HTML routes ─────────────────────────────────────────────────────
// Middleware that redirects to signin if no session cookie
function requireSession(req, res, next) {
  const cookieParser = require('cookie-parser');
  const { verifyJWT, COOKIE_NAME } = require('./auth/oauth');
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.redirect('/auth/signin');
  const user = verifyJWT(token);
  if (!user) return res.redirect('/auth/signin');
  if (!user.approved) return res.redirect('/auth/pending');
  req.user = user;
  next();
}

app.get('/', requireSession, (req, res) => {
  const f = path.join(PUBLIC, 'corverxis-one.html');
  if (fs.existsSync(f)) { res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate'); res.set('Pragma', 'no-cache'); res.set('Expires', '0'); return res.sendFile(f); }
  res.status(404).send('corverxis-one.html not found in public/');
});

app.get('/sensormodel', requireSession, (req, res) => {
  const f = path.join(PUBLIC, 'sensormodel.html');
  if (fs.existsSync(f)) { res.set('Cache-Control', 'no-store'); return res.sendFile(f); }
  res.status(404).send('sensormodel.html not found in public/');
});

app.get('/vision', requireSession, (req, res) => {
  const f = path.join(PUBLIC, 'corverxis-vision.html');
  if (fs.existsSync(f)) { res.set('Cache-Control', 'no-store'); return res.sendFile(f); }
  res.status(404).send('corverxis-vision.html not found in public/');
});

app.get('/hrim', requireSession, (req, res) => {
  const f = path.join(PUBLIC, 'corverxis-hrim.html');
  if (fs.existsSync(f)) { res.set('Cache-Control', 'no-store'); return res.sendFile(f); }
  res.status(404).send('corverxis-hrim.html not found in public/');
});

app.get('/academy', requireSession, (req, res) => {
  const f = path.join(PUBLIC, 'corverxis-academy.html');
  if (fs.existsSync(f)) { res.set('Cache-Control', 'no-store'); return res.sendFile(f); }
  res.status(404).send('corverxis-academy.html not found in public/');
});

app.get('/lab', requireSession, (req, res) => {
  const f = path.join(PUBLIC, 'corverxis-lab.html');
  if (fs.existsSync(f)) { res.set('Cache-Control', 'no-store'); return res.sendFile(f); }
  res.status(404).send('corverxis-lab.html not found in public/');
});

// Deliberately no requireSession — this has to work before any org or
// user exists yet. Its own security is the PLATFORM_ADMIN_SECRET check
// on the API endpoint it calls, not the session system.
app.get('/internal/provision', (req, res) => {
  const f = path.join(PUBLIC, 'admin-provision.html');
  if (fs.existsSync(f)) { res.set('Cache-Control', 'no-store'); return res.sendFile(f); }
  res.status(404).send('admin-provision.html not found in public/');
});

// ── Protected API routes ──────────────────────────────────────────────────────
app.get('/api/status', authenticate, async (req, res) => {
  try {
    const [userCount, sensorCount, alertCount] = await Promise.all([
      prisma.user.count({ where: { deletedAt: null } }),
      prisma.sensor.count(),
      prisma.alert.count({ where: { resolved: false } }),
    ]);
    res.json({
      platform: 'CorverxisONE', version: '1.0.0',
      user:  { id: req.user.id, name: req.user.name, role: req.user.role, orgId: req.user.orgId },
      db:    { users: userCount, sensors: sensorCount, activeAlerts: alertCount },
      ws_clients: { vision: wsVisionClients.size, sensors: wsSensorClients.size },
      timestamp: new Date().toISOString(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Sensors — TECHNICIAN and above
app.get('/api/sensors', authenticate, requireRole('TECHNICIAN'), async (req, res) => {
  try {
    const sensors = await prisma.sensor.findMany({
      include: {
        readings: { orderBy: { timestamp: 'desc' }, take: 1 },
        alerts:   { where: { resolved: false }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'asc' },
    });
    const data = sensors.map(s => {
      const latest = s.readings[0];
      const val    = latest ? latest.value : simulateSensorValue(s.type);
      const thr    = s.thresholds;
      const status = thr.crit && val >= thr.crit ? 'CRITICAL' :
                     thr.warn && val >= thr.warn ? 'WARNING' : 'OK';
      return { id: s.id, name: s.name, type: s.type, unit: s.unit,
               value: parseFloat(val.toFixed(3)), status, warn: thr.warn, crit: thr.crit };
    });
    res.json({ data, count: data.length, timestamp: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sensors/:id/reading', authenticate, requireRole('TECHNICIAN'), async (req, res) => {
  try {
    const { value, quality = 1.0 } = req.body;
    if (value === undefined) return res.status(400).json({ error: 'value required' });
    const sensor = await prisma.sensor.findUnique({ where: { id: req.params.id } });
    if (!sensor) return res.status(404).json({ error: 'Sensor not found' });
    const thr = sensor.thresholds;
    const status = thr.crit && value >= thr.crit ? 'CRITICAL' :
                   thr.warn && value >= thr.warn ? 'WARNING' : 'OK';
    const reading = await prisma.sensorReading.create({
      data: { sensorId: sensor.id, value: parseFloat(value), quality, status },
    });
    if (status !== 'OK') {
      await prisma.alert.create({
        data: { sensorId: sensor.id, severity: status, type: 'threshold_breach',
                message: `${sensor.name} ${status}: ${value} ${sensor.unit}`,
                value: parseFloat(value),
                threshold: status === 'CRITICAL' ? thr.crit : thr.warn },
      });
    }
    // Auto-raise NCR if sensor crosses CRITICAL threshold
    if (status === 'CRITICAL') {
      const sensorWithAsset = await prisma.sensor.findUnique({
        where: { id: sensor.id },
        include: { asset: true },
      });
      autoNcrFromSensorCrit({
        sensor: sensorWithAsset || sensor,
        value:  parseFloat(value),
        orgId:  sensorWithAsset?.asset?.orgId || req.user?.orgId || null,
      }).catch(e => console.error('[AUTO] NCR from sensor crit failed:', e.message));
    }
    res.status(201).json({ success: true, reading, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Vision — ENGINEER and above can write, TECHNICIAN can read
app.get('/api/vision/jobs', authenticate, requireRole('TECHNICIAN'), async (req, res) => {
  try {
    const jobs = await prisma.visionJob.findMany({ orderBy: { createdAt: 'asc' } });
    res.json({ data: jobs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/vision/stats', authenticate, requireRole('TECHNICIAN'), async (req, res) => {
  try {
    const session = await prisma.visionSession.findFirst({
      orderBy: { startedAt: 'desc' }, include: { job: true },
    });
    if (!session) return res.json({ totalCount: 0, passCount: 0, failCount: 0, passRate: '0.0' });
    const passRate = session.totalCount > 0
      ? (session.passCount / session.totalCount * 100).toFixed(1) : '0.0';
    res.json({ sessionId: session.id, job: session.job.name, totalCount: session.totalCount,
               passCount: session.passCount, failCount: session.failCount, passRate,
               avgCycleMs: session.avgCycleMs, startedAt: session.startedAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/vision/result', authenticate, requireRole('ENGINEER'), async (req, res) => {
  try {
    const { jobId, result, confidence, defectCount = 0, defectTypes = [], cycleMs } = req.body;
    if (!result || !cycleMs) return res.status(400).json({ error: 'result and cycleMs required' });
    let sess = await prisma.visionSession.findFirst({
      where: { jobId: jobId || undefined, endedAt: null },
      orderBy: { startedAt: 'desc' },
    });
    if (!sess) {
      const job = jobId
        ? await prisma.visionJob.findUnique({ where: { id: jobId } })
        : await prisma.visionJob.findFirst();
      if (!job) return res.status(404).json({ error: 'No vision job found. Run seed.' });
      sess = await prisma.visionSession.create({ data: { jobId: job.id } });
    }
    await prisma.visionResult.create({
      data: { sessionId: sess.id, result, confidence: parseFloat(confidence) || 0,
              defectCount, defectTypes, cycleMs: parseFloat(cycleMs) },
    });
    const isPass  = result === 'PASS';
    const newTotal = sess.totalCount + 1;
    const newAvg   = ((sess.avgCycleMs * sess.totalCount) + parseFloat(cycleMs)) / newTotal;
    await prisma.visionSession.update({
      where: { id: sess.id },
      data: { totalCount: { increment: 1 },
              passCount:  isPass  ? { increment: 1 } : undefined,
              failCount:  !isPass ? { increment: 1 } : undefined,
              avgCycleMs: newAvg },
    });
    // Auto-raise NCR if inspection failed
    if (!isPass) {
      autoNcrFromVisionFail({
        jobId,
        sessionId:   sess.id,
        confidence:  parseFloat(confidence) || 0,
        defectCount: parseInt(defectCount)  || 0,
        defectTypes: Array.isArray(defectTypes) ? defectTypes : [],
        cycleMs:     parseFloat(cycleMs),
        orgId:       req.user?.orgId || null,
      }).catch(e => console.error('[AUTO] NCR from vision fail:', e.message));
    }
    res.status(201).json({ success: true, sessionId: sess.id, autoNcr: !isPass });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin — user management (ADMIN+)
app.get('/api/admin/users', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    const { filter = 'pending' } = req.query;
    const users = await prisma.user.findMany({
      where: filter === 'pending'
        ? { approved: false, deletedAt: null }
        : { deletedAt: null },
      select: { id: true, name: true, email: true, role: true, approved: true,
                approvedAt: true, rejectedAt: true, registeredAt: true, lastLoginAt: true,
                orgId: true },
      orderBy: { registeredAt: 'desc' },
    });
    res.json({ data: users });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/users', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    const { userId, action, role = 'ENGINEER', reason } = req.body;
    if (!userId || !action) return res.status(400).json({ error: 'userId and action required' });

    // Only SUPER_ADMIN can promote to ADMIN or SUPER_ADMIN
    if (['ADMIN','SUPER_ADMIN'].includes(role) && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Only SUPER_ADMIN can grant ADMIN or SUPER_ADMIN roles' });
    }

    if (action === 'approve') {
      await prisma.user.update({
        where: { id: userId },
        data: { approved: true, approvedAt: new Date(), approvedBy: req.user.id, role, rejectedAt: null },
      });
      await prisma.auditLog.create({
        data: { userId: req.user.id, action: 'user.approved', resourceId: userId, outcome: 'success', metadata: { role } },
      }).catch(() => {});
      return res.json({ success: true, message: 'User approved.' });
    }
    if (action === 'reject') {
      await prisma.user.update({
        where: { id: userId },
        data: { rejectedAt: new Date(), rejectedReason: reason ?? null },
      });
      await prisma.auditLog.create({
        data: { userId: req.user.id, action: 'user.rejected', resourceId: userId, outcome: 'success', metadata: { reason } },
      }).catch(() => {});
      return res.json({ success: true, message: 'User rejected.' });
    }
    res.status(400).json({ error: 'Invalid action' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Audit log — ADMIN+
app.get('/api/admin/audit', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    const logs = await prisma.auditLog.findMany({
      orderBy: { timestamp: 'desc' }, take: 100,
      include: { user: { select: { name: true, email: true } } },
    });
    res.json({ data: logs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Current user session info
app.get('/api/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

// RBAC info — what the current user can do
app.get('/api/me/permissions', authenticate, (req, res) => {
  const { ROLE_PERMISSIONS } = require('./middleware/rbac');
  res.json({ role: req.user.role, permissions: ROLE_PERMISSIONS[req.user.role] || [] });
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.path }));

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wsVisionClients  = new Set();
const wsSensorClients  = new Set();

const wssVision = new WebSocket.Server({ server, path: '/ws/vision' });
wssVision.on('connection', (ws) => {
  wsVisionClients.add(ws);
  ws.send(JSON.stringify({ type: 'info', camera: 'Corverxis CVX-2448-C', width: 2448, height: 2048, fps: 24 }));
  ws.on('close',  () => wsVisionClients.delete(ws));
  ws.on('error',  () => wsVisionClients.delete(ws));
});

const wssSensors = new WebSocket.Server({ server, path: '/ws/sensors' });
wssSensors.on('connection', (ws) => {
  wsSensorClients.add(ws);
  buildSensorPayload().then(p => { if (ws.readyState === WebSocket.OPEN) ws.send(p); });
  ws.on('close',  () => wsSensorClients.delete(ws));
  ws.on('error',  () => wsSensorClients.delete(ws));
});

function bcast(clients, payload) {
  const msg = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const ws of clients) { if (ws.readyState === WebSocket.OPEN) ws.send(msg); }
}

setInterval(async () => { if (wsSensorClients.size) bcast(wsSensorClients, await buildSensorPayload()); }, 2000);
setInterval(() => {
  if (!wsVisionClients.size) return;
  bcast(wsVisionClients, { type: 'stats', throughput: 820+Math.floor(Math.random()*60),
    passRate: (98+Math.random()*1.5).toFixed(1), rejects: Math.floor(Math.random()*3)+47,
    cycleMs: 130+Math.floor(Math.random()*25), fps: 24, camera: 'Corverxis CVX-2448-C',
    timestamp: new Date().toISOString() });
}, 1500);

// ── HRIM automation: nightly-equivalent attrition recompute ────────────────
// Recomputes attrition risk for every org every 6 hours so scores drift with
// tenure/comp changes even when no employee record is manually touched.
setInterval(async () => {
  try {
    const { recomputeAttrition } = require('./routes/hrim');
    const orgs = await prisma.org.findMany({ select: { id: true } });
    for (const o of orgs) { await recomputeAttrition(o.id).catch(()=>{}); }
  } catch (e) { console.error('HRIM attrition recompute job failed:', e.message); }
}, 6 * 60 * 60 * 1000);

// ── Sensor simulation ─────────────────────────────────────────────────────────
const SENSOR_BASES = { mfg_vib:1.2, mfg_temp:42, mfg_curr:18, mfg_press:120,
  aero_vib:0.8, aero_temp:620, aero_oil:65, aero_hyd:3000,
  ev_temp:28, ev_volt:3.7, ev_curr:45, ev_soc:75,
  min_vib:2.8, min_gas:2, min_dust:0.8, min_str:45,
  pwr_curr:420, pwr_temp:55, pwr_pdis:15, pwr_freq:50,
  auto_force:72, auto_weld:680, auto_torq:42,
  re_vib:3.5, re_power:1850, re_rpm:1450, re_temp:48,
  hth_ecg:72, hth_spo2:98, hth_bp:120, hth_rr:16 };

function simulateSensorValue(type) {
  const base = SENSOR_BASES[type] || 50;
  let val = Math.max(0, base + (Math.random()-.5)*base*.07 + Math.sin(Date.now()/28000)*base*.04);
  if (type === 'mfg_temp') val = 83 + Math.random() * 5;
  return val;
}

async function buildSensorPayload() {
  try {
    const sensors = await prisma.sensor.findMany({
      include: { readings: { orderBy: { timestamp: 'desc' }, take: 1 } },
    });
    const data = sensors.map(s => {
      const val = s.readings[0] ? s.readings[0].value : simulateSensorValue(s.type);
      const thr = s.thresholds;
      const status = thr.crit && val >= thr.crit ? 'CRITICAL' : thr.warn && val >= thr.warn ? 'WARNING' : 'OK';
      return { id: s.id, name: s.name, type: s.type, unit: s.unit,
               value: parseFloat(val.toFixed(3)), status, warn: thr.warn, crit: thr.crit };
    });
    return JSON.stringify({ type: 'readings', data, timestamp: new Date().toISOString() });
  } catch (_) {
    return JSON.stringify({ type: 'readings', data: [], timestamp: new Date().toISOString() });
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, HOST, () => {
  const base = `http://${HOST}:${PORT}`;
  console.log('\n  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║     Corverxis Technologies — Platform Server         ║');
  console.log('  ╠══════════════════════════════════════════════════════╣');
  console.log(`  ║  ${base}/           → CorverxisONE (auth)         ║`);
  console.log(`  ║  ${base}/vision     → Corverxis Vision (auth)     ║`);
  console.log(`  ║  ${base}/admin      → Admin Panel (ADMIN+)        ║`);
  console.log(`  ║  ${base}/auth/signin → Sign In                    ║`);
  console.log(`  ║  ${base}/api/health → Health check (public)       ║`);
  console.log('  ╚══════════════════════════════════════════════════════╝\n');
  const ok = f => fs.existsSync(path.join(PUBLIC, f)) ? '✓' : '✗ MISSING';
  console.log(`  CorverxisONE    : ${ok('corverxis-one.html')}`);
  console.log(`  Corverxis Vision: ${ok('corverxis-vision.html')}\n`);
});
