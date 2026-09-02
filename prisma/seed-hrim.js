/**
 * CorverxisHRIM seed — realistic workforce dataset for the demo org.
 * Run standalone: node prisma/seed-hrim.js
 * Or chained from prisma/seed.js
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const DEPARTMENTS = [
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

const FIRST = ['James','Maria','Wei','Priya','Carlos','Sarah','David','Fatima','Alex','Emma','Ryan','Lin','Sofia','Noah','Amara','Lucas','Chen','Olivia','Raj','Grace','Marcus','Elena','Tom','Yuki','Isabella','Kevin','Nadia','Sam','Ava','Diego'];
const LAST  = ['Chen','Garcia','Patel','Nguyen','Johnson','Kim','Rodriguez','Ahmed','Müller','Silva','O\'Brien','Wang','Kowalski','Yamamoto','Santos','Andersson','Kumar','Rossi','Novak','Dubois','Osei','Petrov','Haddad','Torres','Lindqvist'];

const TITLES = {
  'Manufacturing Ops': ['CNC Machinist','Production Supervisor','Line Lead','Plant Manager','Maintenance Technician','Process Engineer'],
  'Quality Engineering': ['Quality Engineer','QA Inspector','Supplier Quality Engineer','Quality Manager','CMM Programmer'],
  'Supply Chain': ['Supply Chain Analyst','Procurement Specialist','Materials Planner','Logistics Coordinator','Supply Chain Manager'],
  'R&D / AI Engineering': ['ML Engineer','Software Engineer','Data Scientist','Applied Scientist','Engineering Manager','DevOps Engineer'],
  'Finance': ['Financial Analyst','Accountant','Controller','FP&A Manager','AP/AR Specialist'],
  'Sales & Customer Success': ['Account Executive','Customer Success Manager','Sales Engineer','VP Sales','SDR'],
  'IT / Platform': ['IT Support Specialist','Systems Administrator','Security Engineer','IT Manager','Network Engineer'],
  'People & Talent': ['HR Business Partner','Talent Acquisition Specialist','People Ops Manager','Compensation Analyst','L&D Specialist'],
  'Executive': ['Chief Executive Officer','Chief Operating Officer','Chief Financial Officer','Chief Technology Officer','VP Manufacturing'],
};

const LOCATIONS = ['Columbus, OH','Detroit, MI','Austin, TX','Remote — US','Monterrey, MX','Chicago, IL'];

function rand(arr) { return arr[Math.floor(Math.random()*arr.length)]; }
function randInt(a,b) { return Math.floor(Math.random()*(b-a+1))+a; }
function randDate(startYear, endYear) {
  const start = new Date(startYear,0,1).getTime();
  const end   = new Date(endYear,11,31).getTime();
  return new Date(start + Math.random()*(end-start));
}

async function seedHrim() {
  const org = await prisma.org.findUnique({ where: { slug: 'corverxis-demo' } });
  if (!org) { console.log('⚠ No demo org found — skipping HRIM seed'); return; }

  // Each section checks and seeds independently — a blanket "employees
  // exist, skip everything" guard here would permanently block
  // departments from ever being (re-)created if an earlier partial run
  // created employees but not departments (exactly what happened).
  const deptMap = {};
  const existingDepts = await prisma.hrDepartment.findMany({ where: { orgId: org.id } });
  if (existingDepts.length === 0) {
    for (const d of DEPARTMENTS) {
      const dept = await prisma.hrDepartment.create({ data: { orgId: org.id, ...d } });
      deptMap[d.name] = dept.id;
    }
    console.log(`✓ HRIM: ${DEPARTMENTS.length} departments seeded`);
  } else {
    existingDepts.forEach(d => { deptMap[d.name] = d.id; });
    console.log(`✓ HRIM: ${existingDepts.length} departments already present — skipping`);
  }

  const existing = await prisma.hrEmployee.count({ where: { orgId: org.id } });
  if (existing > 0) { console.log(`✓ HRIM: ${existing} employees already present — skipping employee seed`); return; }

  // ── Executives first (no manager) ──
  const execTitles = TITLES['Executive'];
  const execs = [];
  for (let i=0;i<execTitles.length;i++) {
    const first = rand(FIRST), last = rand(LAST);
    const emp = await prisma.hrEmployee.create({
      data: {
        orgId: org.id,
        employeeCode: 'EMP-' + String(i+1).padStart(4,'0'),
        firstName: first, lastName: last,
        email: `${first.toLowerCase()}.${last.toLowerCase().replace(/[^a-z]/g,'')}@corverxis.com`,
        jobTitle: execTitles[i],
        departmentId: deptMap['Executive'],
        location: 'Columbus, OH',
        employmentType: 'FULL_TIME',
        status: 'ACTIVE',
        hireDate: randDate(2018, 2021),
        baseSalary: randInt(210000, 380000),
        performanceRating: +(4.0 + Math.random()*1.0).toFixed(1),
        ptoBalanceHours: randInt(20,80),
      }
    });
    execs.push(emp);
  }

  // ── Managers per department ──
  let empCounter = execTitles.length;
  const managerMap = {}; // deptName -> [managerIds]
  for (const dept of DEPARTMENTS) {
    if (dept.name === 'Executive') continue;
    managerMap[dept.name] = [];
    const nManagers = randInt(1,2);
    for (let m=0;m<nManagers;m++) {
      empCounter++;
      const first = rand(FIRST), last = rand(LAST);
      const titles = TITLES[dept.name];
      const mgrTitle = titles[titles.length-1]; // last title treated as most senior
      const emp = await prisma.hrEmployee.create({
        data: {
          orgId: org.id,
          employeeCode: 'EMP-' + String(empCounter).padStart(4,'0'),
          firstName: first, lastName: last,
          email: `${first.toLowerCase()}.${last.toLowerCase().replace(/[^a-z]/g,'')}@corverxis.com`,
          jobTitle: mgrTitle,
          departmentId: deptMap[dept.name],
          managerId: rand(execs).id,
          location: rand(LOCATIONS),
          employmentType: 'FULL_TIME',
          status: 'ACTIVE',
          hireDate: randDate(2019, 2022),
          baseSalary: randInt(120000, 190000),
          performanceRating: +(3.5 + Math.random()*1.5).toFixed(1),
          ptoBalanceHours: randInt(10,120),
        }
      });
      managerMap[dept.name].push(emp);
    }
  }

  // ── Individual contributors ──
  const allEmployees = [...execs];
  for (const dept of DEPARTMENTS) {
    if (dept.name === 'Executive') continue;
    const titles = TITLES[dept.name].slice(0,-1); // exclude manager title already used
    const nICs = randInt(6, 12);
    for (let i=0;i<nICs;i++) {
      empCounter++;
      const first = rand(FIRST), last = rand(LAST);
      const isContract = Math.random() < 0.08;
      const hireDate = randDate(2020, 2026);
      const perf = Math.random() < 0.12 ? +(1.8+Math.random()*1.0).toFixed(1) : +(3.0+Math.random()*2.0).toFixed(1);
      const emp = await prisma.hrEmployee.create({
        data: {
          orgId: org.id,
          employeeCode: 'EMP-' + String(empCounter).padStart(4,'0'),
          firstName: first, lastName: last,
          email: `${first.toLowerCase()}.${last.toLowerCase().replace(/[^a-z]/g,'')}@corverxis.com`,
          jobTitle: rand(titles),
          departmentId: deptMap[dept.name],
          managerId: rand(managerMap[dept.name]).id,
          location: rand(LOCATIONS),
          employmentType: isContract ? 'CONTRACT' : (Math.random()<0.05?'PART_TIME':'FULL_TIME'),
          status: Math.random() < 0.03 ? 'ON_LEAVE' : 'ACTIVE',
          hireDate,
          baseSalary: randInt(58000, 145000),
          performanceRating: perf,
          ptoBalanceHours: randInt(0, 200),
        }
      });
      allEmployees.push(emp);
    }
  }

  // A few terminated this year for attrition rate calc
  for (let i=0;i<4;i++) {
    empCounter++;
    const first = rand(FIRST), last = rand(LAST);
    const dept = rand(DEPARTMENTS.filter(d=>d.name!=='Executive'));
    await prisma.hrEmployee.create({
      data: {
        orgId: org.id,
        employeeCode: 'EMP-' + String(empCounter).padStart(4,'0'),
        firstName: first, lastName: last,
        email: `${first.toLowerCase()}.${last.toLowerCase().replace(/[^a-z]/g,'')}.alum@corverxis.com`,
        jobTitle: rand(TITLES[dept.name]),
        departmentId: deptMap[dept.name],
        location: rand(LOCATIONS),
        status: 'TERMINATED',
        hireDate: randDate(2021,2024),
        terminationDate: randDate(2026,2026),
        baseSalary: randInt(60000,130000),
      }
    });
  }

  console.log(`✓ HRIM: ${allEmployees.length} active employees across ${DEPARTMENTS.length} departments`);

  // ── Requisitions + candidates ──
  const reqTitles = ['Senior ML Engineer','Quality Engineer II','Production Supervisor — 2nd Shift','Supply Chain Analyst','Customer Success Manager','IT Support Specialist'];
  const stages = ['APPLIED','SCREEN','INTERVIEW','OFFER','HIRED','REJECTED'];
  for (const title of reqTitles) {
    const deptName = rand(Object.keys(deptMap));
    const req = await prisma.hrRequisition.create({
      data: {
        orgId: org.id, title, departmentId: deptMap[deptName],
        location: rand(LOCATIONS), status: 'OPEN',
        hiringManager: `${rand(FIRST)} ${rand(LAST)}`,
        targetHireDate: randDate(2026,2026),
      }
    });
    const nCands = randInt(3,9);
    for (let i=0;i<nCands;i++) {
      await prisma.hrCandidate.create({
        data: {
          orgId: org.id, requisitionId: req.id,
          name: `${rand(FIRST)} ${rand(LAST)}`,
          email: `candidate${i}@example.com`,
          stage: rand(stages),
          source: rand(['LinkedIn','Referral','Careers Page','Indeed','Agency']),
        }
      });
    }
  }
  console.log(`✓ HRIM: ${reqTitles.length} requisitions with candidates seeded`);

  // ── Performance reviews (most recent cycle) ──
  let reviewCount = 0;
  for (const emp of allEmployees) {
    if (Math.random() < 0.7) {
      await prisma.hrPerformanceReview.create({
        data: {
          orgId: org.id, employeeId: emp.id, cycle: '2026 H1',
          rating: emp.performanceRating, status: 'COMPLETED',
          reviewerName: 'Manager Review',
          notes: emp.performanceRating < 3.0 ? 'Below expectations — performance improvement plan discussed.' :
                 emp.performanceRating >= 4.5 ? 'Exceptional contributor — recommend for promotion track.' :
                 'Meets expectations, solid contributor this cycle.',
        }
      });
      reviewCount++;
    }
  }
  console.log(`✓ HRIM: ${reviewCount} performance reviews seeded`);

  // ── Compute attrition risk for everyone ──
  const { recomputeAttrition } = require('../src/routes/hrim');
  const n = await recomputeAttrition(org.id);
  console.log(`✓ HRIM: attrition risk computed for ${n} active employees`);
}

module.exports = { seedHrim };

if (require.main === module) {
  seedHrim()
    .catch((e) => { console.error('❌ HRIM seed failed:', e); process.exit(1); })
    .finally(async () => { await prisma.$disconnect(); });
}
