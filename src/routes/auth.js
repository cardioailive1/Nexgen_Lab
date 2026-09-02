/**
 * Corverxis Auth Routes
 * ======================
 * GET  /auth/signin          → sign-in page (HTML)
 * GET  /auth/register        → registration page (HTML)
 * GET  /auth/pending         → pending approval page (HTML)
 * GET  /auth/error           → auth error page (HTML)
 * GET  /auth/google          → initiate Google OAuth
 * GET  /auth/github          → initiate GitHub OAuth
 * GET  /auth/microsoft       → initiate Microsoft OAuth
 * GET  /auth/callback/google     → Google callback
 * GET  /auth/callback/github     → GitHub callback
 * GET  /auth/callback/microsoft  → Microsoft callback
 * POST /auth/signout         → clear session
 * GET  /auth/session         → return current user from JWT
 * POST /auth/register        → register new user or org (JSON API)
 */

const express  = require('express');
const router   = express.Router();
const {
  passport, setSessionCookie, clearSessionCookie,
} = require('../auth/oauth');
const { authenticate } = require('../middleware/rbac');
const { prisma }       = require('../prisma');

const APP_URL = process.env.APP_URL || 'http://localhost:3000';

// ── HTML pages ────────────────────────────────────────────────────────────────
// These are inline HTML for simplicity — in production these could be React pages
function page(title, body) {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} | Corverxis</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{background:#0a1628;color:#e2e8f0;font-family:Inter,system-ui,sans-serif;
  min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
.card{background:#0d1f3c;border:1px solid rgba(255,255,255,0.08);border-radius:12px;
  padding:36px;width:100%;max-width:440px;}
.logo{display:flex;align-items:center;gap:10px;margin-bottom:28px;}
.logo-hex{width:36px;height:36px;}
.logo-name{font-weight:800;font-size:17px;}
.logo-sub{font-size:10px;color:#00c2e0;letter-spacing:.12em;text-transform:uppercase;}
h1{font-size:20px;font-weight:700;margin-bottom:6px;}
p{color:#6b7280;font-size:13px;margin-bottom:20px;line-height:1.6;}
.btn{display:flex;align-items:center;gap:10px;width:100%;padding:11px 16px;
  border-radius:8px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.05);
  color:#e2e8f0;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none;
  transition:all .15s;margin-bottom:10px;}
.btn:hover{border-color:#00c2e0;background:rgba(0,194,224,0.08);color:#00c2e0;}
.btn.google{border-color:rgba(255,255,255,0.2);}
.btn.github{background:rgba(255,255,255,0.06);}
.btn.ms{background:rgba(0,120,212,0.12);border-color:rgba(0,120,212,0.3);}
.divider{border-top:1px solid rgba(255,255,255,0.07);margin:20px 0;}
.link{color:#00c2e0;text-decoration:none;font-size:13px;}
.link:hover{text-decoration:underline;}
.info{background:rgba(0,194,224,0.07);border:1px solid rgba(0,194,224,0.18);
  border-radius:8px;padding:12px 16px;font-size:12px;color:#9ca3af;line-height:1.6;margin-bottom:20px;}
.badge{display:inline-block;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700;}
.badge.pending{background:rgba(245,158,11,.15);color:#f59e0b;}
.badge.ok{background:rgba(34,197,94,.15);color:#22c55e;}
.form-row{margin-bottom:14px;}
label{font-size:12px;color:#9ca3af;display:block;margin-bottom:5px;}
input,select{width:100%;padding:9px 12px;background:#112645;border:1px solid rgba(255,255,255,0.1);
  border-radius:7px;color:#e2e8f0;font-size:13px;outline:none;}
input:focus,select:focus{border-color:#00c2e0;}
.submit{width:100%;padding:10px;background:#00c2e0;color:#0a1628;border:none;
  border-radius:7px;font-weight:700;font-size:14px;cursor:pointer;margin-top:6px;}
.submit:hover{background:#00deff;}
.err{color:#ef4444;font-size:13px;margin-bottom:14px;}
footer{text-align:center;margin-top:20px;font-size:11px;color:#374151;}
svg{flex-shrink:0;}
</style></head><body>
<div class="card">
  <div class="logo">
    <svg class="logo-hex" viewBox="0 0 80 80">
      <polygon points="40,8 68,24 68,56 40,72 12,56 12,24" fill="none" stroke="#00c2e0" stroke-width="2"/>
      <circle cx="40" cy="40" r="7" fill="#00c2e0"/>
      <circle cx="40" cy="8" r="3" fill="#00c2e0"/>
      <circle cx="68" cy="24" r="3" fill="#00c2e0"/>
      <circle cx="68" cy="56" r="3" fill="#00c2e0"/>
      <circle cx="40" cy="72" r="3" fill="#00c2e0"/>
      <circle cx="12" cy="56" r="3" fill="#00c2e0"/>
      <circle cx="12" cy="24" r="3" fill="#00c2e0"/>
    </svg>
    <div><div class="logo-name">Corverxis</div>
    <div class="logo-sub">Enterprise AI Platform</div></div>
  </div>
  ${body}
</div>
<footer>SOC 2 Type II &nbsp;·&nbsp; ISO 27001 &nbsp;·&nbsp; GDPR Compliant</footer>
</body></html>`;
}

// ── Sign-in page ──────────────────────────────────────────────────────────────
router.get('/signin', (req, res) => {
  const providers = [];
  if (process.env.GOOGLE_CLIENT_ID)  providers.push({ id: 'google',    label: 'Continue with Google',    icon: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>' },);
  if (process.env.GITHUB_CLIENT_ID)  providers.push({ id: 'github',    label: 'Continue with GitHub',    icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>' });
  if (process.env.AZURE_AD_CLIENT_ID) providers.push({ id: 'microsoft', label: 'Continue with Microsoft', icon: '<svg viewBox="0 0 23 23" width="18" height="18"><path fill="#f3f3f3" d="M0 0h23v23H0z"/><path fill="#f35325" d="M1 1h10v10H1z"/><path fill="#81bc06" d="M12 1h10v10H12z"/><path fill="#05a6f0" d="M1 12h10v10H1z"/><path fill="#ffba08" d="M12 12h10v10H12z"/></svg>' });

  const error = req.query.error ? `<div class="err">${req.query.error === 'pending' ? 'Your account is awaiting approval.' : req.query.error === 'unregistered' ? 'Email not registered. Please register first.' : 'Authentication failed. Please try again.'}</div>` : '';

  res.send(page('Sign In', `
    <h1>Sign in to Corverxis</h1>
    <p>Use your organisation identity provider for secure access.</p>
    ${error}
    ${providers.map(p => `<a href="/auth/${p.id}" class="btn ${p.id}">${p.icon} ${p.label}</a>`).join('')}
    ${providers.length === 0 ? '<div class="info">No OAuth providers configured. Set GOOGLE_CLIENT_ID, GITHUB_CLIENT_ID, or AZURE_AD_CLIENT_ID environment variables.</div>' : ''}
    <div class="divider"></div>
    <p style="text-align:center">Don't have an account? <a href="/auth/register" class="link">Register here</a></p>
  `));
});

// ── Register page ─────────────────────────────────────────────────────────────
router.get('/register', (req, res) => {
  res.send(page('Register', `
    <h1>Create Account</h1>
    <p>Register as a Super Admin (new organisation) or join an existing organisation.</p>
    <div class="info">After registration, sign in with the same email using Google, GitHub, or Microsoft. Super Admins are approved immediately. All other roles require admin approval.</div>
    <form id="regForm">
      <div class="form-row"><label>Full Name</label><input id="name" placeholder="John Smith" required></div>
      <div class="form-row"><label>Work Email</label><input id="email" type="email" placeholder="john@company.com" required></div>
      <div class="form-row"><label>Role</label>
        <select id="role" onchange="toggleOrgFields()">
          <option value="SUPER_ADMIN">Super Admin — Register new organisation</option>
          <option value="ADMIN">Admin — Join existing org</option>
          <option value="MANAGER">Manager — Join existing org</option>
          <option value="ENGINEER">Engineer — Join existing org</option>
          <option value="TECHNICIAN">Technician — Join existing org</option>
        </select>
      </div>
      <div id="newOrgFields">
        <div class="form-row"><label>Organisation Name</label><input id="orgName" placeholder="Acme Engineering Ltd"></div>
        <div class="form-row"><label>Organisation Slug</label><input id="orgSlug" placeholder="acme-engineering"></div>
      </div>
      <div id="joinOrgFields" style="display:none">
        <div class="form-row">
          <label>Organisation Slug</label>
          <div style="display:flex;gap:8px">
            <input id="orgLookup" placeholder="acme-engineering" style="flex:1">
            <button type="button" onclick="lookupOrg()" style="padding:9px 14px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.1);border-radius:7px;color:#e2e8f0;cursor:pointer;font-size:12px;">Look up</button>
          </div>
          <div id="orgStatus" style="font-size:12px;margin-top:5px;color:#6b7280;"></div>
        </div>
      </div>
      <div id="formErr" class="err" style="display:none"></div>
      <div id="formOk" style="display:none;color:#22c55e;font-size:13px;margin-bottom:12px;"></div>
      <button type="button" class="submit" onclick="submitReg()">Create Account</button>
    </form>
    <div class="divider"></div>
    <p style="text-align:center">Already registered? <a href="/auth/signin" class="link">Sign in</a></p>
    <script>
      var foundOrgId = null;
      function toggleOrgFields(){
        var r=document.getElementById('role').value;
        var isNew = r==='SUPER_ADMIN';
        document.getElementById('newOrgFields').style.display=isNew?'block':'none';
        document.getElementById('joinOrgFields').style.display=isNew?'none':'block';
      }
      function slugify(v){return v.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');}
      document.getElementById('orgName').addEventListener('input',function(){
        document.getElementById('orgSlug').value=slugify(this.value);
      });
      async function lookupOrg(){
        var sl=document.getElementById('orgLookup').value.trim();
        if(!sl)return;
        var r=await fetch('/api/register?org='+encodeURIComponent(sl));
        var d=await r.json();
        var st=document.getElementById('orgStatus');
        if(d.exists){foundOrgId=d.id;st.style.color='#22c55e';st.textContent='Found: '+d.name;}
        else{foundOrgId=null;st.style.color='#ef4444';st.textContent='Organisation not found.';}
      }
      async function submitReg(){
        var role=document.getElementById('role').value;
        var body={name:document.getElementById('name').value,email:document.getElementById('email').value,role:role};
        if(role==='SUPER_ADMIN'){body.orgName=document.getElementById('orgName').value;body.orgSlug=document.getElementById('orgSlug').value;}
        else{if(!foundOrgId)return alert('Look up your organisation first.');body.orgId=foundOrgId;}
        document.getElementById('formErr').style.display='none';
        var r=await fetch('/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        var d=await r.json();
        if(!r.ok){document.getElementById('formErr').textContent=d.error||'Registration failed';document.getElementById('formErr').style.display='block';return;}
        document.getElementById('formOk').textContent=d.message;document.getElementById('formOk').style.display='block';
        document.getElementById('regForm').style.display='none';
      }
      toggleOrgFields();
    </script>
  `));
});

// ── Pending approval page ─────────────────────────────────────────────────────
router.get('/pending', (req, res) => {
  res.send(page('Awaiting Approval', `
    <h1>Awaiting Approval</h1>
    <p>Your account registration was received. Your organisation admin needs to approve your access before you can sign in.</p>
    <div class="info">Once approved you can sign in using your OAuth provider with the same email address you registered with. Contact your Super Admin if you need urgent access.</div>
    <a href="/auth/signin" class="btn">Back to Sign In</a>
  `));
});

// ── Error page ────────────────────────────────────────────────────────────────
router.get('/error', (req, res) => {
  res.send(page('Authentication Error', `
    <h1>Authentication Error</h1>
    <p>${req.query.message || 'Something went wrong during sign in. Please try again.'}</p>
    <a href="/auth/signin" class="btn">Back to Sign In</a>
  `));
});

// ── OAuth initiation routes ───────────────────────────────────────────────────
router.get('/google',    passport.authenticate('google',    { scope: ['openid', 'email', 'profile'] }));
router.get('/github',    passport.authenticate('github',    { scope: ['user:email'] }));
router.get('/microsoft', passport.authenticate('microsoft', { scope: ['openid', 'email', 'profile'] }));

// ── OAuth callback routes ─────────────────────────────────────────────────────
function handleCallback(provider) {
  return [
    passport.authenticate(provider, { session: false, failureRedirect: '/auth/signin?error=failed' }),
    async (req, res) => {
      const user = req.user;

      // Unregistered — email not in DB
      if (user?.__unregistered) {
        return res.redirect(`/auth/register?email=${encodeURIComponent(user.email)}&name=${encodeURIComponent(user.name || '')}`);
      }

      if (!user) return res.redirect('/auth/signin?error=failed');

      // Not approved
      if (!user.approved) return res.redirect('/auth/pending');

      // All good — set JWT cookie and go to platform
      setSessionCookie(res, user);
      res.redirect('/');
    }
  ];
}

router.get('/callback/google',    ...handleCallback('google'));
router.get('/callback/github',    ...handleCallback('github'));
router.get('/callback/microsoft', ...handleCallback('microsoft'));

// ── Sign out ──────────────────────────────────────────────────────────────────
router.post('/signout', (req, res) => {
  clearSessionCookie(res);
  res.json({ success: true });
});

router.get('/signout', (req, res) => {
  clearSessionCookie(res);
  res.redirect('/auth/signin');
});

// ── Session API ───────────────────────────────────────────────────────────────
router.get('/session', authenticate, (req, res) => {
  res.json({
    user: {
      id:      req.user.id,
      email:   req.user.email,
      name:    req.user.name,
      role:    req.user.role,
      orgId:   req.user.orgId,
      orgName: req.user.orgName,
    },
  });
});

// ── Register API (also exposed at /api/register in server.js) ─────────────────
router.post('/register', async (req, res) => {
  // Delegate to the shared handler in server.js via the same prisma calls
  // This route is just an alias
  res.redirect(307, '/api/register');
});

module.exports = router;
