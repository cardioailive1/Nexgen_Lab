/**
 * Corverxis Admin Routes — RBAC protected
 * =========================================
 * GET  /admin                 → admin dashboard page
 * GET  /admin/users           → user management page
 * GET  /api/admin/users       → list users (ADMIN+)
 * PATCH /api/admin/users      → approve/reject/change role (ADMIN+)
 * DELETE /api/admin/users/:id → delete user (SUPER_ADMIN only)
 * GET  /api/admin/roles       → list available roles
 * PATCH /api/admin/users/:id/role → change role (SUPER_ADMIN only)
 */

const express  = require('express');
const router   = express.Router();
const { prisma } = require('../prisma');
const { authenticate, requireRole, ROLE_PERMISSIONS } = require('../middleware/rbac');

// ── Admin dashboard page ──────────────────────────────────────────────────────
router.get('/', authenticate, requireRole('ADMIN'), (req, res) => {
  const { user } = req;
  res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin | Corverxis</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{background:#0a1628;color:#e2e8f0;font-family:Inter,system-ui,sans-serif;padding:32px;}
.hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:28px;}
h1{font-size:22px;font-weight:700;}
.sub{color:#6b7280;font-size:13px;margin-top:4px;}
.back{padding:8px 16px;border-radius:8px;border:1px solid rgba(255,255,255,.1);
  background:transparent;color:#9ca3af;cursor:pointer;font-size:13px;text-decoration:none;}
.back:hover{color:#fff;}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;margin-bottom:28px;}
.card{background:#0d1f3c;border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:20px;}
.card-label{font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;}
.card-val{font-size:28px;font-weight:800;}
.badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;}
.sa{background:rgba(139,92,246,.15);color:#8b5cf6;}
.ad{background:rgba(0,194,224,.12);color:#00c2e0;}
.mg{background:rgba(34,197,94,.12);color:#22c55e;}
.en{background:rgba(245,158,11,.12);color:#f59e0b;}
.tc{background:rgba(107,114,128,.15);color:#9ca3af;}
.pd{background:rgba(239,68,68,.12);color:#ef4444;}
.btn{padding:7px 16px;border-radius:7px;border:none;cursor:pointer;font-size:12px;font-weight:600;}
.btn.pr{background:#00c2e0;color:#0a1628;}
.btn.rej{background:transparent;border:1px solid rgba(239,68,68,.3);color:#ef4444;}
.btn.role{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:#e2e8f0;}
table{width:100%;border-collapse:collapse;font-size:13px;background:#0d1f3c;border-radius:10px;overflow:hidden;}
th{padding:10px 14px;text-align:left;color:#6b7280;font-size:11px;font-weight:600;
  text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid rgba(255,255,255,.07);}
td{padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.04);}
.tabs{display:flex;gap:6px;margin-bottom:16px;}
.tab{padding:7px 18px;border-radius:8px;border:none;cursor:pointer;font-size:13px;
  background:rgba(255,255,255,.05);color:#9ca3af;}
.tab.active{background:rgba(0,194,224,.15);color:#00c2e0;font-weight:600;}
.msg{padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:14px;display:none;}
.msg.ok{background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);color:#22c55e;}
.msg.err{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:#ef4444;}
select.role-sel{background:#112645;border:1px solid rgba(255,255,255,.1);border-radius:6px;
  padding:4px 8px;color:#e2e8f0;font-size:12px;cursor:pointer;}
</style></head><body>
<div class="hdr">
  <div>
    <h1>Admin Panel</h1>
    <div class="sub">Signed in as <strong>${user.name || user.email}</strong>
      <span class="badge ${user.role === 'SUPER_ADMIN' ? 'sa' : user.role === 'ADMIN' ? 'ad' : 'mg'}" style="margin-left:8px">${user.role}</span>
    </div>
  </div>
  <a href="/" class="back">← Back to Platform</a>
</div>

<div class="cards" id="stats-cards">
  <div class="card"><div class="card-label">Total Users</div><div class="card-val" id="cnt-total">—</div></div>
  <div class="card"><div class="card-label">Pending Approval</div><div class="card-val" id="cnt-pending" style="color:#f59e0b">—</div></div>
  <div class="card"><div class="card-label">Active Users</div><div class="card-val" id="cnt-active" style="color:#22c55e">—</div></div>
  <div class="card"><div class="card-label">Organisations</div><div class="card-val" id="cnt-orgs">—</div></div>
</div>

<div id="msg" class="msg"></div>
<div class="tabs">
  <button class="tab active" onclick="loadUsers('pending')">Pending Approval</button>
  <button class="tab" onclick="loadUsers('all')">All Members</button>
</div>

<table>
  <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Org</th><th>Registered</th><th>Status</th><th>Actions</th></tr></thead>
  <tbody id="user-table"></tbody>
</table>

<script>
var ROLE_CLASSES = {SUPER_ADMIN:'sa',ADMIN:'ad',MANAGER:'mg',ENGINEER:'en',TECHNICIAN:'tc',PENDING:'pd',VIEWER:'tc'};
var currentFilter = 'pending';

async function loadStats() {
  var r = await fetch('/api/status');
  var d = await r.json();
  document.getElementById('cnt-total').textContent = d.db?.users ?? '—';
  var rPending = await fetch('/api/admin/users?filter=pending');
  var dPending = await rPending.json();
  document.getElementById('cnt-pending').textContent = dPending.data?.length ?? '—';
  document.getElementById('cnt-active').textContent = (d.db?.users ?? 0) - (dPending.data?.length ?? 0);
  document.getElementById('cnt-orgs').textContent = '1';
}

async function loadUsers(filter) {
  currentFilter = filter;
  document.querySelectorAll('.tab').forEach(function(t,i){t.classList.toggle('active',i===(filter==='pending'?0:1));});
  var r = await fetch('/api/admin/users?filter=' + filter);
  var d = await r.json();
  var rows = (d.data || []);
  var tbody = document.getElementById('user-table');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#6b7280;padding:32px">' + (filter==='pending' ? 'No pending approvals 🎉' : 'No members found') + '</td></tr>'; return; }
  tbody.innerHTML = rows.map(function(u){
    var bc = ROLE_CLASSES[u.role] || 'tc';
    var status = u.rejectedAt ? 'Rejected' : u.approved ? 'Active' : 'Pending';
    var sc = u.rejectedAt ? 'pd' : u.approved ? 'mg' : 'en';
    var actions = '';
    if (!u.approved && !u.rejectedAt) {
      actions = '<select class="role-sel" id="role-'+u.id+'">' +
        ['ENGINEER','TECHNICIAN','MANAGER','ADMIN'].map(function(r){return '<option value="'+r+'">'+r+'</option>';}).join('') +
        '</select> ' +
        '<button class="btn pr" onclick="approve(\\''+u.id+'\\')">✓ Approve</button> ' +
        '<button class="btn rej" onclick="reject(\\''+u.id+'\\')">✗ Reject</button>';
    } else if (u.approved && ${user.role === 'SUPER_ADMIN' ? 'true' : 'false'}) {
      actions = '<select class="role-sel" onchange="changeRole(\\''+u.id+'\\',this.value)">' +
        ['TECHNICIAN','ENGINEER','MANAGER','ADMIN','SUPER_ADMIN'].map(function(r){return '<option value="'+r+'"'+(r===u.role?' selected':'')+'>'+r+'</option>';}).join('') +
        '</select>';
    }
    return '<tr><td>'+(u.name||'—')+'</td><td style="color:#9ca3af">'+u.email+'</td>' +
      '<td><span class="badge '+bc+'">'+u.role+'</span></td>' +
      '<td style="color:#9ca3af">'+u.orgId?.slice(0,8)+'…</td>' +
      '<td style="color:#6b7280;font-size:11px">'+new Date(u.registeredAt).toLocaleDateString()+'</td>' +
      '<td><span class="badge '+sc+'">'+status+'</span></td>' +
      '<td>'+actions+'</td></tr>';
  }).join('');
}

async function approve(userId) {
  var role = document.getElementById('role-'+userId)?.value || 'ENGINEER';
  var r = await fetch('/api/admin/users',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId,action:'approve',role})});
  var d = await r.json();
  showMsg(d.message, r.ok);
  loadUsers(currentFilter);
}

async function reject(userId) {
  var r = await fetch('/api/admin/users',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId,action:'reject'})});
  var d = await r.json();
  showMsg(d.message, r.ok);
  loadUsers(currentFilter);
}

async function changeRole(userId, newRole) {
  var r = await fetch('/api/admin/users',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId,action:'approve',role:newRole})});
  var d = await r.json();
  showMsg('Role updated to '+newRole, r.ok);
}

function showMsg(text, ok) {
  var el = document.getElementById('msg');
  el.textContent = (ok?'✓ ':'✗ ') + text;
  el.className = 'msg ' + (ok?'ok':'err');
  el.style.display = 'block';
  setTimeout(function(){ el.style.display='none'; }, 4000);
}

loadStats();
loadUsers('pending');
</script>
</body></html>`);
});

module.exports = router;
