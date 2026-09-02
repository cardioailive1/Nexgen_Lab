/**
 * Corverxis RBAC Middleware
 * ==========================
 * Roles (highest → lowest):
 *   SUPER_ADMIN  — full platform access, user management, org settings
 *   ADMIN        — approve users, manage assets/sensors, view all
 *   MANAGER      — view all data, create work orders, manage alerts
 *   ENGINEER     — view sensors, predictions, vision data; post readings
 *   TECHNICIAN   — view assigned sensors and alerts only; post readings
 *   PENDING      — no access (awaiting approval)
 *
 * Usage:
 *   router.get('/admin/users', authenticate, requireRole('ADMIN'), handler)
 *   router.get('/sensors',     authenticate, requireRole('TECHNICIAN'), handler)
 *   router.delete('/org',      authenticate, requireRole('SUPER_ADMIN'), handler)
 */

const { verifyJWT, COOKIE_NAME } = require('../auth/oauth');

// Role hierarchy — higher index = more permissions
const ROLE_LEVELS = {
  SUPER_ADMIN: 100,
  ADMIN:        80,
  MANAGER:      60,
  ENGINEER:     40,
  TECHNICIAN:   20,
  PENDING:       0,
  VIEWER:       10,
};

// What each role can do
const ROLE_PERMISSIONS = {
  SUPER_ADMIN: [
    'users:manage',       // approve, reject, delete, change roles
    'org:manage',         // create/edit org settings
    'sensors:manage',     // create/edit/delete sensors and assets
    'sensors:read',       // read all sensor data
    'sensors:write',      // post readings, predictions
    'alerts:manage',      // resolve/dismiss alerts
    'alerts:read',
    'vision:manage',      // create/edit vision jobs
    'vision:read',
    'vision:write',
    'reports:read',
    'audit:read',
    'admin:read',
    'platform:admin',
  ],
  ADMIN: [
    'users:manage',
    'sensors:manage',
    'sensors:read',
    'sensors:write',
    'alerts:manage',
    'alerts:read',
    'vision:manage',
    'vision:read',
    'vision:write',
    'reports:read',
    'audit:read',
    'admin:read',
  ],
  MANAGER: [
    'sensors:read',
    'sensors:write',
    'alerts:manage',
    'alerts:read',
    'vision:read',
    'vision:write',
    'reports:read',
    'admin:read',
  ],
  ENGINEER: [
    'sensors:read',
    'sensors:write',
    'alerts:read',
    'vision:read',
    'vision:write',
    'reports:read',
  ],
  TECHNICIAN: [
    'sensors:read',
    'sensors:write',
    'alerts:read',
    'vision:read',
  ],
  VIEWER: [
    'sensors:read',
    'vision:read',
    'reports:read',
  ],
  PENDING: [],
};

// ── authenticate ──────────────────────────────────────────────────────────────
// Reads JWT from cookie or Authorization header
// Attaches req.user = { id, email, name, role, orgId, orgName, approved }
function authenticate(req, res, next) {
  // 1. Try cookie
  let token = req.cookies?.[COOKIE_NAME];

  // 2. Try Authorization: Bearer <token>
  if (!token) {
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) token = authHeader.slice(7);
  }

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized', message: 'No session. Sign in first.' });
  }

  const payload = verifyJWT(token);
  if (!payload) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Session expired or invalid.' });
  }

  if (!payload.approved) {
    return res.status(403).json({ error: 'Forbidden', message: 'Account pending approval.' });
  }

  req.user = payload;
  next();
}

// ── requireRole ───────────────────────────────────────────────────────────────
// Requires the user's role level >= the minimum role
// requireRole('ENGINEER') — allows ENGINEER, MANAGER, ADMIN, SUPER_ADMIN
// requireRole('SUPER_ADMIN') — only SUPER_ADMIN
function requireRole(minimumRole) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const userLevel = ROLE_LEVELS[req.user.role] ?? 0;
    const minLevel  = ROLE_LEVELS[minimumRole]   ?? 999;
    if (userLevel < minLevel) {
      return res.status(403).json({
        error:    'Forbidden',
        message:  `Requires ${minimumRole} role or higher. Your role: ${req.user.role}`,
        required: minimumRole,
        current:  req.user.role,
      });
    }
    next();
  };
}

// ── requirePermission ─────────────────────────────────────────────────────────
// Requires a specific permission regardless of role
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const perms = ROLE_PERMISSIONS[req.user.role] || [];
    if (!perms.includes(permission)) {
      return res.status(403).json({
        error:      'Forbidden',
        message:    `Missing permission: ${permission}`,
        permission,
        role:       req.user.role,
      });
    }
    next();
  };
}

// ── requireSameOrg ────────────────────────────────────────────────────────────
// Ensures users can only access data from their own org (unless SUPER_ADMIN)
function requireSameOrg(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (req.user.role === 'SUPER_ADMIN') return next(); // SUPER_ADMIN sees all orgs
  const targetOrgId = req.params.orgId || req.query.orgId || req.body?.orgId;
  if (targetOrgId && targetOrgId !== req.user.orgId) {
    return res.status(403).json({ error: 'Forbidden', message: 'Cross-org access denied.' });
  }
  next();
}

// ── optionalAuth ──────────────────────────────────────────────────────────────
// Attaches req.user if a valid token exists, but doesn't fail if missing
function optionalAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME] ||
    (req.headers.authorization || '').replace('Bearer ', '');
  if (token) {
    const payload = verifyJWT(token);
    if (payload?.approved) req.user = payload;
  }
  next();
}

module.exports = {
  authenticate,
  requireRole,
  requirePermission,
  requireSameOrg,
  optionalAuth,
  ROLE_LEVELS,
  ROLE_PERMISSIONS,
};
