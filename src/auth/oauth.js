/**
 * Corverxis OAuth — Passport.js strategies
 * Supports: Google, GitHub, Microsoft Entra ID
 *
 * Flow:
 *  1. User visits /auth/signin → chooses provider
 *  2. Redirected to provider → callback to /auth/callback/:provider
 *  3. If email not in DB → redirect /auth/register
 *  4. If not approved     → redirect /auth/pending
 *  5. If approved         → JWT session cookie set → redirect /
 */

const passport       = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const GitHubStrategy = require('passport-github2').Strategy;
const MicrosoftStrategy = require('passport-microsoft').Strategy;
const jwt            = require('jsonwebtoken');
const { prisma }     = require('../prisma');

const JWT_SECRET  = process.env.JWT_SECRET || 'corverxis-dev-secret-change-in-production';
const JWT_EXPIRES = '8h';
const COOKIE_NAME = 'cvx_session';

// ── Passport serialisation (not used for JWT but required by passport) ─────────
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await prisma.user.findUnique({ where: { id }, include: { org: true } });
    done(null, user);
  } catch (e) { done(e); }
});

// ── Shared callback handler ────────────────────────────────────────────────────
async function handleOAuthCallback(profile, provider, done) {
  try {
    const email = (profile.emails?.[0]?.value || '').toLowerCase();
    if (!email) return done(null, false, { message: 'No email from provider' });

    // Find user
    let user = await prisma.user.findUnique({
      where: { email },
      include: { org: true },
    });

    if (!user) {
      // Not registered — create a stub with PENDING role so we can redirect
      return done(null, { __unregistered: true, email, name: profile.displayName, provider });
    }

    if (user.deletedAt) return done(null, false, { message: 'Account deactivated' });

    // Update last login + name/image
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        name:  user.name  || profile.displayName,
        image: user.image || profile.photos?.[0]?.value || null,
      },
      include: { org: true },
    });

    // Log OAuth account link
    await prisma.account.upsert({
      where: { provider_providerAccountId: { provider, providerAccountId: profile.id } },
      update: {},
      create: {
        userId:            user.id,
        type:              'oauth',
        provider,
        providerAccountId: profile.id,
        scope:             'openid email profile',
      },
    }).catch(() => {});

    await prisma.auditLog.create({
      data: {
        userId:   user.id,
        orgId:    user.orgId ?? null,
        action:   'auth.oauth_login',
        resource: 'user',
        resourceId: user.id,
        outcome:  user.approved ? 'success' : 'pending',
        metadata: { provider, email },
      },
    }).catch(() => {});

    return done(null, user);
  } catch (e) {
    return done(e);
  }
}

// ── Google ─────────────────────────────────────────────────────────────────────
if (process.env.GOOGLE_CLIENT_ID) {
  passport.use(new GoogleStrategy(
    {
      clientID:     process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL:  `${process.env.APP_URL}/auth/callback/google`,
      scope:        ['openid', 'email', 'profile'],
    },
    (accessToken, refreshToken, profile, done) => handleOAuthCallback(profile, 'google', done)
  ));
}

// ── GitHub ─────────────────────────────────────────────────────────────────────
if (process.env.GITHUB_CLIENT_ID) {
  passport.use(new GitHubStrategy(
    {
      clientID:     process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      callbackURL:  `${process.env.APP_URL}/auth/callback/github`,
      scope:        ['user:email'],
    },
    (accessToken, refreshToken, profile, done) => handleOAuthCallback(profile, 'github', done)
  ));
}

// ── Microsoft Entra ID ─────────────────────────────────────────────────────────
if (process.env.AZURE_AD_CLIENT_ID) {
  passport.use(new MicrosoftStrategy(
    {
      clientID:     process.env.AZURE_AD_CLIENT_ID,
      clientSecret: process.env.AZURE_AD_CLIENT_SECRET,
      callbackURL:  `${process.env.APP_URL}/auth/callback/microsoft`,
      tenant:       process.env.AZURE_AD_TENANT_ID || 'common',
      scope:        ['openid', 'email', 'profile'],
    },
    (accessToken, refreshToken, profile, done) => handleOAuthCallback(profile, 'microsoft', done)
  ));
}

// ── JWT helpers ────────────────────────────────────────────────────────────────
function signJWT(user) {
  return jwt.sign(
    {
      id:       user.id,
      email:    user.email,
      name:     user.name,
      role:     user.role,
      orgId:    user.orgId,
      orgName:  user.org?.name || null,
      approved: user.approved,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function verifyJWT(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch (_) { return null; }
}

function setSessionCookie(res, user) {
  const token = signJWT(user);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   8 * 60 * 60 * 1000, // 8 hours
    path:     '/',
  });
  return token;
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

module.exports = { passport, signJWT, verifyJWT, setSessionCookie, clearSessionCookie, COOKIE_NAME };
