/**
 * Corverxis Platform — Prisma Seed
 * Seeds demo org, assets, sensors, vision jobs
 * Run: npx prisma db seed
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const SENSOR_GROUPS = [
  {
    vertical: 'Manufacturing',
    asset: 'CNC Production Line',
    location: 'Building A — Line 1',
    sensors: [
      { name: 'Spindle Vibration',    type: 'mfg_vib',   unit: 'mm/s',  algo: 'ensemble',
        thresholds: { warn: 4.2,  crit: 8.5  } },
      { name: 'Spindle Bearing Temp', type: 'mfg_temp',  unit: 'C',     algo: 'ekf',
        thresholds: { warn: 65,   crit: 85   } },
      { name: 'Motor Drive Current',  type: 'mfg_curr',  unit: 'A',     algo: 'lstm',
        thresholds: { warn: 28,   crit: 38   } },
      { name: 'Hydraulic Pressure',   type: 'mfg_press', unit: 'bar',   algo: 'arima',
        thresholds: { warn: 145,  crit: 160  } },
    ],
  },
  {
    vertical: 'Aerospace',
    asset: 'Aerospace Test Cell',
    location: 'Building B — Test Cell 1',
    sensors: [
      { name: 'Engine Fan Vibration', type: 'aero_vib',  unit: 'g RMS', algo: 'fourier',
        thresholds: { warn: 2.5,  crit: 5.0  } },
      { name: 'EGT Exhaust Gas Temp', type: 'aero_temp', unit: 'C',     algo: 'ensemble',
        thresholds: { warn: 720,  crit: 800  } },
      { name: 'Engine Oil Pressure',  type: 'aero_oil',  unit: 'psi',   algo: 'ekf',
        thresholds: { warn: 45,   crit: 35   } },
      { name: 'Hydraulic System',     type: 'aero_hyd',  unit: 'psi',   algo: 'lstm',
        thresholds: { warn: 3200, crit: 3400 } },
    ],
  },
  {
    vertical: 'EV Battery',
    asset: 'EV Battery Pack Assembly',
    location: 'Building C — Line 6',
    sensors: [
      { name: 'Battery Cell Temp',    type: 'ev_temp',   unit: 'C',     algo: 'ensemble',
        thresholds: { warn: 45,   crit: 60   } },
      { name: 'Cell Voltage',         type: 'ev_volt',   unit: 'V',     algo: 'ekf',
        thresholds: { warn: 4.18, crit: 4.25 } },
      { name: 'Pack Charge Current',  type: 'ev_curr',   unit: 'A',     algo: 'lstm',
        thresholds: { warn: 120,  crit: 180  } },
      { name: 'State of Charge',      type: 'ev_soc',    unit: '%',     algo: 'arima',
        thresholds: { warn: 15,   crit: 8    } },
    ],
  },
  {
    vertical: 'Mining',
    asset: 'Underground Mining Level 3',
    location: 'Level 3 — West Drift',
    sensors: [
      { name: 'Crusher Bearing Vib.', type: 'min_vib',   unit: 'mm/s',  algo: 'ensemble',
        thresholds: { warn: 8.5,  crit: 18   } },
      { name: 'Methane Concentration',type: 'min_gas',   unit: '% LEL', algo: 'fourier',
        thresholds: { warn: 20,   crit: 40   } },
      { name: 'Respirable Dust',      type: 'min_dust',  unit: 'mg/m3', algo: 'lstm',
        thresholds: { warn: 2.0,  crit: 3.5  } },
      { name: 'Roof Support Load',    type: 'min_str',   unit: 't',     algo: 'arima',
        thresholds: { warn: 72,   crit: 90   } },
    ],
  },
  {
    vertical: 'Power Systems',
    asset: 'Grid Transformer Station',
    location: 'Substation Alpha',
    sensors: [
      { name: 'Transformer Current',  type: 'pwr_curr',  unit: 'A',     algo: 'ekf',
        thresholds: { warn: 520,  crit: 600  } },
      { name: 'Transformer Oil Temp', type: 'pwr_temp',  unit: 'C',     algo: 'lstm',
        thresholds: { warn: 80,   crit: 95   } },
      { name: 'Partial Discharge',    type: 'pwr_pdis',  unit: 'pC',    algo: 'fourier',
        thresholds: { warn: 100,  crit: 500  } },
      { name: 'Grid Frequency',       type: 'pwr_freq',  unit: 'Hz',    algo: 'arima',
        thresholds: { warn: 49.8, crit: 49.5 } },
    ],
  },
  {
    vertical: 'Automotive',
    asset: 'Brake Caliper Assembly Line',
    location: 'Building A — Line 2',
    sensors: [
      { name: 'Press Force',          type: 'auto_force',unit: 'kN',    algo: 'ensemble',
        thresholds: { warn: 85,   crit: 95   } },
      { name: 'Weld Temperature',     type: 'auto_weld', unit: 'C',     algo: 'lstm',
        thresholds: { warn: 720,  crit: 780  } },
      { name: 'Torque Verify',        type: 'auto_torq', unit: 'Nm',    algo: 'ekf',
        thresholds: { warn: 48,   crit: 52   } },
      { name: 'Part Present Sensor',  type: 'auto_pres', unit: 'bool',  algo: 'fourier',
        thresholds: { warn: 0.5,  crit: 0    } },
    ],
  },
  {
    vertical: 'Renewable Energy',
    asset: 'Wind Turbine Farm',
    location: 'Site West — Turbines 1-8',
    sensors: [
      { name: 'Gearbox Vibration',    type: 're_vib',    unit: 'mm/s',  algo: 'ensemble',
        thresholds: { warn: 9.0,  crit: 18   } },
      { name: 'Wind Active Power',    type: 're_power',  unit: 'kW',    algo: 'lstm',
        thresholds: { warn: 600,  crit: 200  } },
      { name: 'Rotor Speed',          type: 're_rpm',    unit: 'RPM',   algo: 'fourier',
        thresholds: { warn: 1700, crit: 1850 } },
      { name: 'Nacelle Temperature',  type: 're_temp',   unit: 'C',     algo: 'arima',
        thresholds: { warn: 75,   crit: 90   } },
    ],
  },
  {
    vertical: 'Healthcare',
    asset: 'Patient Monitoring Station',
    location: 'ICU Ward B',
    sensors: [
      { name: 'ECG Heart Rate',       type: 'hth_ecg',   unit: 'bpm',   algo: 'ekf',
        thresholds: { warn: 100,  crit: 130  } },
      { name: 'SpO2 Saturation',      type: 'hth_spo2',  unit: '%',     algo: 'lstm',
        thresholds: { warn: 94,   crit: 90   } },
      { name: 'Blood Pressure Sys',   type: 'hth_bp',    unit: 'mmHg',  algo: 'arima',
        thresholds: { warn: 140,  crit: 180  } },
      { name: 'Respiratory Rate',     type: 'hth_rr',    unit: 'br/min',algo: 'fourier',
        thresholds: { warn: 22,   crit: 28   } },
    ],
  },
];

const VISION_JOBS = [
  { name: 'BRK_CAL_LINE2',  partNumber: '48210-06290', revision: 'Rev G', tool: 'defect'   },
  { name: 'BRG_RACE_LINE3', partNumber: 'BRG-6205-C3', revision: 'Rev B', tool: 'measure'  },
  { name: 'PCB_ASSY_SMT',   partNumber: 'PCB-ECU-V3',  revision: 'Rev A', tool: 'pattern'  },
  { name: 'WELD_INSP_B2',   partNumber: 'WLD-4410',    revision: 'Rev C', tool: 'defect'   },
  { name: 'AERO_STRUT_L5',  partNumber: 'AS9-4410',    revision: 'Rev F', tool: 'measure'  },
];

async function main() {
  console.log('🌱 Seeding Corverxis Platform...');

  // ── Org ─────────────────────────────────────────────────────────────────────
  const org = await prisma.org.upsert({
    where:  { slug: 'corverxis-demo' },
    update: {},
    create: { name: 'Corverxis Demo Organisation', slug: 'corverxis-demo', plan: 'ENTERPRISE' },
  });
  console.log(`✓ Org: ${org.name}`);

  // ── Super Admin user ─────────────────────────────────────────────────────────
  const admin = await prisma.user.upsert({
    where:  { email: process.env.ADMIN_EMAIL || 'admin@corverxis.com' },
    update: {},
    create: {
      email:       process.env.ADMIN_EMAIL || 'admin@corverxis.com',
      name:        'Corverxis Admin',
      role:        'SUPER_ADMIN',
      orgId:       org.id,
      approved:    true,
      approvedAt:  new Date(),
      registeredAt: new Date(),
    },
  });
  console.log(`✓ Admin user: ${admin.email}`);

  // ── Assets + Sensors ─────────────────────────────────────────────────────────
  let totalSensors = 0;
  for (const group of SENSOR_GROUPS) {
    const asset = await prisma.asset.upsert({
      where:  { id: `asset-${group.vertical.toLowerCase().replace(/\s/g,'-')}` },
      update: {},
      create: {
        id:          `asset-${group.vertical.toLowerCase().replace(/\s/g,'-')}`,
        name:        group.asset,
        description: `${group.vertical} monitoring asset`,
        orgId:       org.id,
        vertical:    group.vertical,
        location:    group.location,
      },
    });

    for (const s of group.sensors) {
      await prisma.sensor.upsert({
        where:  { id: `sensor-${s.type}` },
        update: {},
        create: {
          id:          `sensor-${s.type}`,
          name:        s.name,
          type:        s.type,
          unit:        s.unit,
          assetId:     asset.id,
          mlAlgorithm: s.algo,
          thresholds:  s.thresholds,
        },
      });
      totalSensors++;
    }
  }
  console.log(`✓ Assets: ${SENSOR_GROUPS.length} | Sensors: ${totalSensors}`);

  // ── Vision Jobs ──────────────────────────────────────────────────────────────
  for (const job of VISION_JOBS) {
    await prisma.visionJob.upsert({
      where:  { id: `vjob-${job.name.toLowerCase()}` },
      update: {},
      create: {
        id:         `vjob-${job.name.toLowerCase()}`,
        orgId:      org.id,
        name:       job.name,
        partNumber: job.partNumber,
        revision:   job.revision,
        tool:       job.tool,
      },
    });
  }
  console.log(`✓ Vision jobs: ${VISION_JOBS.length}`);

  console.log('\n✅ Seed complete!');
  console.log(`   Org: ${org.name} (${org.slug})`);
  console.log(`   Admin: ${admin.email}`);
  console.log(`   Sensors: ${totalSensors} across ${SENSOR_GROUPS.length} verticals`);
  console.log(`   Vision jobs: ${VISION_JOBS.length}`);
}

main()
  .catch((e) => { console.error('❌ Seed failed:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });

// ── Additional seed for dynamic data ─────────────────────────────────────────
async function seedDynamicData() {
  console.log('🌱 Seeding dynamic data...');

  // Find the demo org
  const org = await prisma.org.findUnique({ where: { slug: 'corverxis-demo' } });
  if (!org) { console.log('Run main seed first'); return; }

  // ── Production Lines ────────────────────────────────────────────────────────
  const lineData = [
    { id:'line-1', name:'Line 1 — Engine Mounts',    location:'Building A', description:'Engine mount assembly' },
    { id:'line-2', name:'Line 2 — Brake Calipers',   location:'Building A', description:'Brake caliper machining and assembly' },
    { id:'line-3', name:'Line 3 — Turbochargers',    location:'Building B', description:'Turbocharger assembly and test' },
    { id:'line-4', name:'Line 4 — Fuel Systems',     location:'Building B', description:'Fuel injector and pump assembly' },
    { id:'line-5', name:'Line 5 — Aerospace Struts', location:'Building C', description:'Aerospace structural components' },
    { id:'line-6', name:'Line 6 — EV Battery Trays', location:'Building C', description:'EV battery tray assembly' },
  ];

  for (const l of lineData) {
    await prisma.productionLine.upsert({
      where: { id: l.id }, update: {},
      create: { ...l, orgId: org.id },
    });
  }
  console.log(`✓ Production lines: ${lineData.length}`);

  // ── Work Orders ─────────────────────────────────────────────────────────────
  const woData = [
    { id:'wo-2851', number:'WO-2851', partNumber:'48210-06290', customer:'Toyota',   quantity:1200, completed:984,  status:'IN_PROGRESS', lineId:'line-2', priority:1, dueDate: new Date(Date.now()+3*3600000) },
    { id:'wo-2849', number:'WO-2849', partNumber:'EM-4471',     customer:'BMW',      quantity:600,  completed:570,  status:'IN_PROGRESS', lineId:'line-1', priority:2, dueDate: new Date(Date.now()+2*3600000) },
    { id:'wo-2847', number:'WO-2847', partNumber:'ABS-881',     customer:'Ford',     quantity:2400, completed:984,  status:'ON_HOLD',     lineId:'line-4', priority:2, dueDate: new Date(Date.now()+18*3600000) },
    { id:'wo-2845', number:'WO-2845', partNumber:'TC-2291',     customer:'Mercedes', quantity:150,  completed:150,  status:'COMPLETED',   lineId:'line-3', priority:3, dueDate: new Date(Date.now()-2*3600000) },
    { id:'wo-2844', number:'WO-2844', partNumber:'AS9-4410',    customer:'Airbus',   quantity:24,   completed:16,   status:'IN_PROGRESS', lineId:'line-5', priority:1, dueDate: new Date(Date.now()+48*3600000) },
    { id:'wo-2843', number:'WO-2843', partNumber:'BT-EV220',    customer:'Tesla',    quantity:400,  completed:220,  status:'IN_PROGRESS', lineId:'line-6', priority:2, dueDate: new Date(Date.now()+30*3600000) },
    { id:'wo-2840', number:'WO-2840', partNumber:'FI-7821',     customer:'GM',       quantity:3600, completed:1008, status:'IN_PROGRESS', lineId:'line-4', priority:1, dueDate: new Date(Date.now()+8*3600000) },
  ];

  for (const wo of woData) {
    await prisma.workOrder.upsert({ where: { id: wo.id }, update: {}, create: { ...wo, orgId: org.id } });
  }
  console.log(`✓ Work orders: ${woData.length}`);

  // ── Suppliers ───────────────────────────────────────────────────────────────
  const supplierData = [
    { id:'sup-continental', name:'Continental AG',      category:'Electronics',  otif:97, qualityPpm:8,  score:94, rating:'PREFERRED',    country:'DE' },
    { id:'sup-magna',       name:'Magna International', category:'Structures',   otif:95, qualityPpm:15, score:91, rating:'APPROVED',     country:'CA' },
    { id:'sup-parker',      name:'Parker Hannifin',     category:'Hydraulics',   otif:91, qualityPpm:22, score:84, rating:'CONDITIONAL',  country:'US' },
    { id:'sup-bosch',       name:'Bosch GmbH',          category:'Sensors',      otif:88, qualityPpm:31, score:78, rating:'WATCH',        country:'DE' },
    { id:'sup-precision',   name:'Precision Castparts', category:'Aerospace',    otif:99, qualityPpm:2,  score:98, rating:'PREFERRED',    country:'US' },
    { id:'sup-henkel',      name:'Henkel AG',           category:'Chemicals',    otif:93, qualityPpm:0,  score:89, rating:'APPROVED',     country:'DE' },
  ];

  for (const s of supplierData) {
    await prisma.supplier.upsert({ where: { id: s.id }, update: {}, create: { ...s, orgId: org.id } });
  }
  console.log(`✓ Suppliers: ${supplierData.length}`);

  // ── NCRs ────────────────────────────────────────────────────────────────────
  const ncrData = [
    { id:'ncr-0291', number:'NCR-0291', partNumber:'48210-06290', customer:'Toyota',   defectType:'Dimensional',    severity:'CRITICAL', description:'OD +0.12mm over tolerance', status:'OPEN', quantityAffected:24, workOrderId:'wo-2851' },
    { id:'ncr-0290', number:'NCR-0290', partNumber:'FI-7821',     customer:'GM',       defectType:'Surface Finish', severity:'CRITICAL', description:'Surface finish Ra 1.8um vs 1.6um spec', status:'OPEN', quantityAffected:120 },
    { id:'ncr-0289', number:'NCR-0289', partNumber:'EM-4471',     customer:'BMW',      defectType:'Hardness',       severity:'MAJOR',    description:'Hardness 58 HRC (min 60 HRC)', status:'IN_PROGRESS', quantityAffected:6 },
    { id:'ncr-0288', number:'NCR-0288', partNumber:'AS9-4410',    customer:'Airbus',   defectType:'Visual',         severity:'MINOR',    description:'Cosmetic scratch on non-critical surface', status:'CLOSED', quantityAffected:1 },
    { id:'ncr-0287', number:'NCR-0287', partNumber:'TC-2291',     customer:'Mercedes', defectType:'Functional',     severity:'MAJOR',    description:'Imbalance 0.4g.mm (max 0.3g.mm)', status:'IN_PROGRESS', quantityAffected:3 },
  ];

  for (const n of ncrData) {
    await prisma.ncr.upsert({ where: { id: n.id }, update: {}, create: { ...n, orgId: org.id } });
  }
  console.log(`✓ NCRs: ${ncrData.length}`);

  // ── SCARs ───────────────────────────────────────────────────────────────────
  await prisma.scar.upsert({
    where: { id: 'scar-0041' }, update: {},
    create: { id:'scar-0041', number:'SCAR-0041', supplierId:'sup-bosch',
              issue:'ABS sensor intermittent failure — field return', severity:'CRITICAL',
              status:'OPEN', d8Status:'D4 - Root Cause', ncrId:'ncr-0291',
              dueAt: new Date(Date.now()+5*24*3600000) },
  });
  await prisma.scar.upsert({
    where: { id: 'scar-0040' }, update: {},
    create: { id:'scar-0040', number:'SCAR-0040', supplierId:'sup-parker',
              issue:'Hydraulic seal dimensional OOT', severity:'MAJOR',
              status:'ESCALATED', d8Status:'D3 - Containment',
              dueAt: new Date(Date.now()-2*24*3600000) },
  });
  console.log('✓ SCARs: 2');

  // ── Seed initial sensor readings ────────────────────────────────────────────
  const sensors = await prisma.sensor.findMany();
  const BASES = { mfg_vib:1.2,mfg_temp:85.2,mfg_curr:18,mfg_press:120,
    aero_vib:0.8,aero_temp:620,aero_oil:65,aero_hyd:3000,
    ev_temp:28,ev_volt:3.7,ev_curr:45,ev_soc:75,
    min_vib:2.8,min_gas:2,min_dust:0.8,min_str:45,
    pwr_curr:420,pwr_temp:55,pwr_pdis:15,pwr_freq:50,
    auto_force:72,auto_weld:680,auto_torq:42,auto_pres:1,
    re_vib:3.5,re_power:1850,re_rpm:1450,re_temp:48,
    hth_ecg:72,hth_spo2:98,hth_bp:120,hth_rr:16 };

  for (const s of sensors) {
    const base = BASES[s.type] || 50;
    const thr  = s.thresholds;
    // Seed 10 historical readings per sensor
    for (let i = 0; i < 10; i++) {
      const val = Math.max(0, base + (Math.random()-0.5)*base*0.1);
      const ts  = new Date(Date.now() - (10-i)*2*60000);
      const status = thr.crit && val >= thr.crit ? 'CRITICAL' :
                     thr.warn && val >= thr.warn ? 'WARNING' : 'OK';
      await prisma.sensorReading.create({
        data: { sensorId: s.id, value: parseFloat(val.toFixed(3)), quality: 1.0, status, timestamp: ts },
      }).catch(() => {});
    }
    // Seed a prediction for each sensor
    await prisma.prediction.create({
      data: { sensorId: s.id, algorithm: s.mlAlgorithm || 'ensemble',
              predicted: parseFloat((base * (0.95 + Math.random()*0.1)).toFixed(3)),
              confidence: parseFloat((85 + Math.random()*14).toFixed(1)),
              rulHours: s.type === 'mfg_temp' ? 48 : (200 + Math.random()*1000),
              features: {} },
    }).catch(() => {});
  }
  console.log(`✓ Sensor readings + predictions seeded`);

  // ── Seed active vision session ───────────────────────────────────────────────
  const vJob = await prisma.visionJob.findFirst({ where: { orgId: org.id } });
  if (vJob) {
    const vsess = await prisma.visionSession.upsert({
      where: { id: 'vsess-demo' }, update: {},
      create: { id:'vsess-demo', jobId: vJob.id,
                totalCount:3114, passCount:3061, failCount:53, avgCycleMs:142 },
    });
    console.log('✓ Vision session seeded');
  }

  // ── Seed critical alert for mfg_temp ────────────────────────────────────────
  const tempSensor = await prisma.sensor.findUnique({ where: { id: 'sensor-mfg_temp' } });
  if (tempSensor) {
    await prisma.alert.upsert({
      where: { id: 'alert-bearing-crit' }, update: {},
      create: { id:'alert-bearing-crit', sensorId: tempSensor.id,
                severity:'CRITICAL', type:'threshold_breach',
                message:'CNC Spindle Bearing Temp CRITICAL: 87.2°C (threshold 85°C) — RUL est. 48h',
                value: 87.2, threshold: 85, resolved: false },
    });
    console.log('✓ Critical alert seeded');
  }

  console.log('\n✅ Dynamic data seed complete!');
}

// Run both

// ── Inventory & BOM seed ──────────────────────────────────────
async function seedInventory() {
  console.log('🌱 Seeding inventory...');
  const org = await prisma.org.findUnique({ where: { slug: 'corverxis-demo' } });
  if (!org) return;

  const suppliers = await prisma.supplier.findMany({ where: { orgId: org.id } });
  const supMap = {};
  suppliers.forEach(s => { supMap[s.name] = s.id; });

  const ITEMS = [
    // Raw Materials
    { id:'inv-abs881',     partNumber:'ABS-881',        description:'ABS Sensor Module',         category:'RAW_MATERIAL', uom:'EA',  onHand:4200,   safetyStock:5000,  reorderPoint:7000,  reorderQty:10000, unitCost:12.50, supplierId: supMap['Bosch GmbH'],         leadTimeDays:14, lotTracked:true  },
    { id:'inv-sl7821',     partNumber:'SL-7821-S',      description:'Fuel Injector Seal Kit',    category:'RAW_MATERIAL', uom:'EA',  onHand:12000,  safetyStock:10000, reorderPoint:15000, reorderQty:20000, unitCost:1.95,  supplierId: supMap['Parker Hannifin'],    leadTimeDays:8  },
    { id:'inv-em4471',     partNumber:'EM-4471',        description:'Engine Mount Rubber',        category:'RAW_MATERIAL', uom:'EA',  onHand:28400,  safetyStock:10000, reorderPoint:20000, reorderQty:30000, unitCost:4.80,  supplierId: supMap['Magna International'],leadTimeDays:6  },
    { id:'inv-tc2291',     partNumber:'TC-2291-HX',     description:'Turbocharger Bearing',      category:'RAW_MATERIAL', uom:'EA',  onHand:840,    safetyStock:500,   reorderPoint:1200,  reorderQty:2000,  unitCost:48.00, supplierId: supMap['Magna International'],leadTimeDays:21, lotTracked:true  },
    { id:'inv-ti6al4v',    partNumber:'TI-6AL4V-BAR',   description:'Titanium Alloy Billet',     category:'RAW_MATERIAL', uom:'KG',  onHand:120,    safetyStock:80,    reorderPoint:150,   reorderQty:500,   unitCost:85.00, supplierId: supMap['Precision Castparts'],leadTimeDays:30, lotTracked:true  },
    { id:'inv-brk-cast',   partNumber:'BRK-CAST-48210', description:'Brake Caliper Casting',     category:'RAW_MATERIAL', uom:'EA',  onHand:8400,   safetyStock:3000,  reorderPoint:5000,  reorderQty:10000, unitCost:24.00, leadTimeDays:10 },
    { id:'inv-brk-fluid',  partNumber:'BF-DOT4',        description:'DOT 4 Brake Fluid',         category:'CONSUMABLE',   uom:'LTR', onHand:850,    safetyStock:200,   reorderPoint:500,   reorderQty:1000,  unitCost:3.80,  supplierId: supMap['Henkel AG'],          leadTimeDays:4  },
    { id:'inv-evcel',      partNumber:'EV-CELL-NMC',    description:'EV Li-NMC Cell Module',     category:'RAW_MATERIAL', uom:'EA',  onHand:420,    safetyStock:200,   reorderPoint:400,   reorderQty:800,   unitCost:185.00,leadTimeDays:21, lotTracked:true  },
    { id:'inv-brg6205',    partNumber:'BRG-6205-C3',    description:'Deep Groove Ball Bearing',  category:'RAW_MATERIAL', uom:'EA',  onHand:3100,   safetyStock:1000,  reorderPoint:2000,  reorderQty:5000,  unitCost:4.20,  supplierId: supMap['Magna International'],leadTimeDays:5  },
    { id:'inv-pcb-ecu',    partNumber:'PCB-ECU-V3',     description:'ECU Printed Circuit Board', category:'RAW_MATERIAL', uom:'EA',  onHand:680,    safetyStock:300,   reorderPoint:500,   reorderQty:1000,  unitCost:42.00, supplierId: supMap['Continental AG'],     leadTimeDays:14, lotTracked:true  },
    // WIP
    { id:'inv-brk-asm',    partNumber:'BRK-ASM-SEMI',   description:'Brake Caliper Sub-Assembly', category:'WIP',         uom:'EA',  onHand:240,    safetyStock:100,   reorderPoint:200,   reorderQty:0,     unitCost:68.00, leadTimeDays:0  },
    { id:'inv-ev-tray',    partNumber:'BT-TRAY-SEMI',   description:'EV Battery Tray WIP',       category:'WIP',          uom:'EA',  onHand:48,     safetyStock:20,    reorderPoint:40,    reorderQty:0,     unitCost:320.00,leadTimeDays:0  },
    // Finished Goods
    { id:'inv-brk-fg',     partNumber:'BRK-48210-06290',description:'Brake Caliper Assy - Toyota',category:'FINISHED_GOOD',uom:'EA', onHand:984,    safetyStock:500,   reorderPoint:800,   reorderQty:0,     unitCost:124.00,leadTimeDays:0  },
    { id:'inv-as9-fg',     partNumber:'AS9-4410-ASSY',  description:'Aerospace Strut Assembly',  category:'FINISHED_GOOD',uom:'EA',  onHand:16,     safetyStock:5,     reorderPoint:10,    reorderQty:0,     unitCost:2840.00,leadTimeDays:0 },
    // Tooling & Consumables
    { id:'inv-tool-insert',partNumber:'CNCINSERT-TNMG', description:'CNC Carbide Insert TNMG',   category:'TOOLING',      uom:'EA',  onHand:840,    safetyStock:200,   reorderPoint:400,   reorderQty:1000,  unitCost:8.40,  leadTimeDays:3  },
    { id:'inv-coolant',    partNumber:'COOLANT-HOCUT',  description:'CNC Cutting Fluid Hocut',   category:'CONSUMABLE',   uom:'LTR', onHand:320,    safetyStock:100,   reorderPoint:200,   reorderQty:500,   unitCost:4.20,  leadTimeDays:2  },
  ];

  for (const item of ITEMS) {
    await prisma.inventoryItem.upsert({
      where:  { id: item.id },
      update: {},
      create: { ...item, orgId: org.id },
    });
  }

  // Seed stock transactions for ABS-881 to show history
  const absItem = await prisma.inventoryItem.findUnique({ where: { id: 'inv-abs881' } });
  if (absItem) {
    const TXN_HISTORY = [
      { type:'RECEIPT',       qty:10000, qtyBefore:0,     qtyAfter:10000, reference:'PO-8810', reason:'Initial receipt from Bosch', daysAgo:30 },
      { type:'ISSUE',         qty:2400,  qtyBefore:10000, qtyAfter:7600,  workOrderId:'wo-2847', reason:'Issue to WO-2847 Ford ABS', daysAgo:22 },
      { type:'ISSUE',         qty:1800,  qtyBefore:7600,  qtyAfter:5800,  workOrderId:'wo-2840', reason:'Issue to WO-2840 GM production', daysAgo:15 },
      { type:'ADJUSTMENT_OUT',qty:200,   qtyBefore:5800,  qtyAfter:5600,  reason:'Scrap — ESD damage found during inspection', daysAgo:10 },
      { type:'RECEIPT',       qty:500,   qtyBefore:5600,  qtyAfter:6100,  reference:'PO-8815-PARTIAL', reason:'Partial receipt from Bosch', daysAgo:7 },
      { type:'ISSUE',         qty:1900,  qtyBefore:6100,  qtyAfter:4200,  workOrderId:'wo-2851', reason:'Issue to WO-2851 Toyota brake caliper', daysAgo:3 },
    ];
    for (const t of TXN_HISTORY) {
      await prisma.stockTransaction.create({
        data: {
          itemId: absItem.id, type: t.type, qty: t.qty,
          qtyBefore: t.qtyBefore, qtyAfter: t.qtyAfter,
          unitCost: 12.50, reference: t.reference || null,
          workOrderId: t.workOrderId || null, reason: t.reason,
          createdAt: new Date(Date.now() - t.daysAgo * 86400000),
        },
      }).catch(() => {});
    }
  }

  // Seed a BOM for brake caliper
  const bom = await prisma.bOM.upsert({
    where: { id: 'bom-brk-48210' }, update: {},
    create: { id:'bom-brk-48210', orgId:org.id, name:'Brake Caliper BOM', partNumber:'48210-06290', revision:'Rev G', description:'Toyota Brake Caliper Assembly', qty:1 },
  });

  const BOM_LINES = [
    { itemId:'inv-brk-cast', seq:10, qty:1,  uom:'EA', refDes:'BODY',     critical:true,  notes:'Main caliper body casting' },
    { itemId:'inv-abs881',   seq:20, qty:1,  uom:'EA', refDes:'SENSOR',   critical:true,  notes:'ABS wheel speed sensor' },
    { itemId:'inv-sl7821',   seq:30, qty:2,  uom:'EA', refDes:'SEAL1,2',  critical:true,  notes:'Piston seals x2' },
    { itemId:'inv-brg6205',  seq:40, qty:2,  uom:'EA', refDes:'BRG1,2',   critical:false, notes:'Guide pin bearings' },
    { itemId:'inv-brk-fluid',seq:50, qty:0.1,uom:'LTR',refDes:'FLUID',    critical:false, notes:'Brake fluid fill' },
    { itemId:'inv-tool-insert',seq:60,qty:0.05,uom:'EA',refDes:'TOOLING', critical:false, notes:'Tooling amortisation' },
  ];
  for (const line of BOM_LINES) {
    await prisma.bomLine.upsert({
      where: { id: `bomline-brk-${line.seq}` },
      update: {},
      create: { id:`bomline-brk-${line.seq}`, bomId: bom.id, ...line },
    }).catch(() => {});
  }

  // Seed lots for lot-tracked items
  await prisma.inventoryLot.upsert({
    where: { id:'lot-abs-2024-001' }, update: {},
    create: { id:'lot-abs-2024-001', itemId:'inv-abs881', lotNumber:'LOT-2024-001', qty:4200, qtyUsed:5800, supplierId: supMap['Bosch GmbH']||null, certRef:'PO-8810', status:'ACTIVE' },
  }).catch(() => {});

  await prisma.inventoryLot.upsert({
    where: { id:'lot-ti-2024-001' }, update: {},
    create: { id:'lot-ti-2024-001', itemId:'inv-ti6al4v', lotNumber:'TI-2024-CERT-004', qty:120, supplierId: supMap['Precision Castparts']||null, certRef:'CERT-AS9100-0441', status:'ACTIVE', notes:'DFARS compliant titanium alloy' },
  }).catch(() => {});

  // Seed supplier audits
  for (const sup of suppliers) {
    await prisma.supplierAudit.upsert({
      where: { id:`audit-${sup.id}` }, update: {},
      create: {
        id:`audit-${sup.id}`, supplierId: sup.id,
        auditType: 'IATF_16949', plannedDate: new Date(Date.now() + 14*86400000),
        auditorName: 'Quality Assurance Team', status: 'PLANNED',
        notes: 'Annual IATF 16949 supplier audit',
      },
    }).catch(() => {});
  }

  // Seed supplier qualifications
  const qualData = [
    { sup:'Continental AG',      std:'IATF 16949:2016', cert:'IATF-2024-0441', exp:'2026-12-31', body:'Bureau Veritas' },
    { sup:'Magna International', std:'IATF 16949:2016', cert:'IATF-2023-1882', exp:'2026-08-15', body:'TÜV Rheinland' },
    { sup:'Precision Castparts', std:'AS9100D',          cert:'AS9-2024-0088',  exp:'2027-01-01', body:'DNV GL' },
    { sup:'Bosch GmbH',          std:'IATF 16949:2016', cert:'IATF-2023-0211', exp:'2025-06-30', body:'TÜV SÜD' },
    { sup:'Parker Hannifin',     std:'ISO 9001:2015',   cert:'ISO-2022-4421',  exp:'2025-09-30', body:'SGS' },
    { sup:'Henkel AG',           std:'ISO 9001:2015',   cert:'ISO-2023-8811',  exp:'2026-03-31', body:'Bureau Veritas' },
  ];
  for (const q of qualData) {
    const sup = suppliers.find(s => s.name === q.sup);
    if (!sup) continue;
    await prisma.supplierQualification.create({
      data: {
        supplierId: sup.id, standard: q.std, certNumber: q.cert,
        expiresAt: new Date(q.exp), body: q.body, status: 'ACTIVE',
        scope: 'Design and manufacture of automotive components',
      },
    }).catch(() => {});
  }

  // Seed supplier contacts
  const contactData = [
    { sup:'Bosch GmbH',      name:'Klaus Weber',     role:'Quality Manager',       email:'k.weber@bosch.com',      phone:'+49 711 811 0', isPrimary:true },
    { sup:'Continental AG',  name:'Anna Müller',     role:'Account Manager',       email:'a.muller@conti.com',     phone:'+49 69 7603 0', isPrimary:true },
    { sup:'Parker Hannifin', name:'James Morrison',  role:'Supply Chain Manager',  email:'j.morrison@parker.com',  phone:'+1 216 896 3000', isPrimary:true },
    { sup:'Magna International',name:'Pierre Dubois',role:'SQE - Supplier Quality',email:'p.dubois@magna.com',    phone:'+1 905 726 7100', isPrimary:true },
  ];
  for (const c of contactData) {
    const sup = suppliers.find(s => s.name === c.sup);
    if (!sup) continue;
    await prisma.supplierContact.create({
      data: { supplierId: sup.id, name: c.name, role: c.role, email: c.email, phone: c.phone, isPrimary: c.isPrimary },
    }).catch(() => {});
  }

  // Seed development plans for watch-listed suppliers
  await prisma.supplierDevelopmentPlan.create({
    data: { supplierId: supMap['Bosch GmbH']||'', title:'OTIF Improvement to 95%', target:'OTIF ≥ 95% sustained for 3 months',
            targetDate: new Date(Date.now() + 90*86400000), owner:'Supply Chain Manager', status:'OPEN', progress:35,
            notes:'Bosch committed to root cause analysis and delivery schedule review' },
  }).catch(() => {});

  await prisma.supplierDevelopmentPlan.create({
    data: { supplierId: supMap['Parker Hannifin']||'', title:'PPM Reduction to <10', target:'Incoming PPM below 10 by Q3',
            targetDate: new Date(Date.now() + 120*86400000), owner:'SQE Team', status:'OPEN', progress:20,
            notes:'Parker to implement SPC on critical dimensions' },
  }).catch(() => {});

  console.log(`✓ Inventory: ${ITEMS.length} items, 1 BOM, ${BOM_LINES.length} BOM lines`);
  console.log(`✓ Supplier: audits, qualifications, contacts, dev plans seeded`);
}


async function seedProcessImprovement() {
  console.log('🌱 Seeding process improvement...');
  const org   = await prisma.org.findUnique({ where: { slug: 'corverxis-demo' } });
  if (!org) return;
  const lines = await prisma.productionLine.findMany({ where: { orgId: org.id } });
  const lineMap = {};
  lines.forEach(l => { lineMap[l.name] = l.id; });

  const PROJECTS = [
    { id:'pi-0001', number:'PI-0001', title:'Brake Caliper Bore Diameter DMAIC', type:'DMAIC', status:'IN_PROGRESS', dmaicPhase:'Control', sigmaLevel:4.2, sigmaTarget:5.0, department:'Quality', champion:'Quality Manager', teamSize:5, description:'Six Sigma DMAIC project to improve bore diameter process capability on Line 2.', problem:'Bore OD variability causing 0.12mm exceedance. PPM: 48.', currentState:'Sigma level 4.2 — 48 PPM defect rate', targetState:'Sigma level 5.0 — <6 PPM', savingPerMonth:8400, priority:1, lineKey:'Line 2 - Brake Calipers', oeeBeforeStr:'82%', cycleTimeBefore:8.4, scrapBefore:1.8 },
    { id:'pi-0002', number:'PI-0002', title:'Line 4 Changeover SMED Reduction', type:'SMED', status:'IN_PROGRESS', dmaicPhase:null, department:'Manufacturing', champion:'Plant Manager', teamSize:6, description:'Single Minute Exchange of Die — reduce changeover from 42 min to under 28 min.', problem:'42-minute average changeover on Line 4 limiting production flexibility.', currentState:'42 min avg changeover', targetState:'28 min (33% reduction)', savingPerMonth:12000, priority:1, lineKey:'Line 4 - Fuel Systems', cycleTimeBefore:42 },
    { id:'pi-0003', number:'PI-0003', title:'NCR 8D Root Cause AI Automation', type:'AUTOMATION', status:'IN_PROGRESS', department:'Quality', champion:'Quality Director', teamSize:3, description:'LLM-assisted 8D root cause analysis reduces manual analysis from 4h to 45 min.', currentState:'4h manual avg per NCR', targetState:'45 min AI-assisted', savingPerMonth:9600, actualSaving:8800, priority:2 },
    { id:'pi-0004', number:'PI-0004', title:'Aerospace Line 5 First-Off Inspection', type:'KAIZEN', status:'IN_PROGRESS', department:'Quality', champion:'Process Engineer', teamSize:4, description:'Digitise first-off inspection using AI-assisted CMM result review.', currentState:'90 min manual first-off', targetState:'25 min AI-assisted', savingPerMonth:5200, priority:2, lineKey:'Line 5 - Aerospace', cycleTimeBefore:90, cycleTimeAfter:25 },
    { id:'pi-0005', number:'PI-0005', title:'Supplier OTIF Improvement Programme', type:'DMAIC', status:'IN_PROGRESS', dmaicPhase:'Analyze', sigmaLevel:3.1, sigmaTarget:4.0, department:'Supply Chain', champion:'Supply Chain Director', teamSize:4, description:'DMAIC to improve Bosch and Parker OTIF from 88-91% to 95%+.', problem:'Two key suppliers below 95% OTIF target. Impacting WO delivery.', currentState:'Bosch 88% / Parker 91% OTIF', targetState:'All Tier 1 suppliers ≥ 95%', savingPerMonth:6800, priority:2 },
    { id:'pi-0006', number:'PI-0006', title:'EV Battery Tray Scrap Reduction', type:'DMAIC', status:'IN_PROGRESS', dmaicPhase:'Measure', sigmaLevel:3.4, sigmaTarget:4.2, department:'Manufacturing', champion:'Process Engineer', teamSize:5, description:'EV battery tray scrap currently at 4.2%. Target <1.5%.', currentState:'4.2% scrap rate — Line 6', targetState:'<1.5% scrap rate', savingPerMonth:14000, priority:1, lineKey:'Line 6 - EV Battery Trays', scrapBefore:4.2 },
    { id:'pi-0007', number:'PI-0007', title:'Warehouse Pick Path Optimisation', type:'LEAN', status:'IN_PROGRESS', department:'Warehouse', champion:'Operations Manager', teamSize:3, description:'AI routing for warehouse picks. Current 8.4 min avg pick time. Target 5.2 min.', currentState:'8.4 min avg pick', targetState:'5.2 min avg pick', savingPerMonth:3200, priority:3 },
    { id:'pi-0008', number:'PI-0008', title:'PPAP Document Assembly Automation', type:'AUTOMATION', status:'OPEN', department:'Quality / Engineering', champion:'Quality Manager', teamSize:3, description:'Doc AI assembles 14/18 PPAP elements automatically from DMS. Reduces 12h to 2h.', currentState:'12h manual per PPAP', targetState:'AI assembles 14/18 elements — 2h total', savingPerMonth:4480, priority:2 },
  ];

  for (const p of PROJECTS) {
    const { lineKey, ...data } = p;
    await prisma.improvementProject.upsert({
      where:  { id: p.id },
      update: {},
      create: { ...data, orgId: org.id, startDate: new Date(Date.now() - 30*86400000), lineId: lineKey ? lineMap[lineKey] : null },
    }).catch(() => {});
  }

  // Kaizen events
  const KAIZEN = [
    { id:'ke-001', projectId:'pi-0002', lineKey:'Line 4 - Fuel Systems', title:'Video Analysis — Identify NVA Steps', description:'AI analyses changeover video footage to classify value-add vs non-value-add activities.', week:2, totalWeeks:4, teamSize:6, currentMetric:42, targetMetric:28, metricUnit:'min', status:'ACTIVE', actions:'External changeover elements identified: 8 tasks converted to pre-stage.' },
    { id:'ke-002', projectId:'pi-0004', lineKey:'Line 5 - Aerospace', title:'Digitise First-Off Checklist', description:'Replace paper checklist with tablet-based CMM integration.', week:1, totalWeeks:3, teamSize:4, currentMetric:90, targetMetric:25, metricUnit:'min', status:'ACTIVE' },
    { id:'ke-003', projectId:'pi-0006', lineKey:'Line 6 - EV Battery Trays', title:'Measure Phase — Baseline Scrap Data', description:'8-week data collection on scrap causes. Pareto analysis of defect types.', week:3, totalWeeks:4, teamSize:5, currentMetric:4.2, targetMetric:1.5, metricUnit:'% scrap', status:'ACTIVE', findings:'Top 3 causes: weld spatter (38%), dimensional OOT (29%), surface contamination (18%).' },
    { id:'ke-004', projectId:'pi-0001', lineKey:'Line 2 - Brake Calipers', title:'Control Plan Update — SPC on Bore Diameter', description:'Implement real-time SPC on CNC bore operation. X-bar/R charts with AI alerting.', week:4, totalWeeks:4, teamSize:5, currentMetric:4.2, targetMetric:5.0, metricUnit:'σ', status:'ACTIVE', findings:'Control charts implemented. 3 out-of-control signals detected and corrected in 2 weeks.', actions:'SPC integrated with CorverxisONE dashboard. Operators alerted in real-time.' },
  ];

  for (const k of KAIZEN) {
    const { lineKey, ...data } = k;
    await prisma.kaizenEvent.upsert({
      where:  { id: k.id },
      update: {},
      create: { ...data, lineId: lineKey ? lineMap[lineKey] : null, dueAt: new Date(Date.now() + 14*86400000) },
    }).catch(() => {});
  }

  // Waste reductions for main KAIZEN projects
  const WASTES = [
    { id:'wr-001', projectId:'pi-0001', wasteType:'DEFECTS',          baselinePct:100, currentPct:25, targetPct:90 },
    { id:'wr-002', projectId:'pi-0001', wasteType:'EXTRA_PROCESSING',  baselinePct:100, currentPct:40, targetPct:60 },
    { id:'wr-003', projectId:'pi-0002', wasteType:'WAITING',           baselinePct:100, currentPct:41, targetPct:67 },
    { id:'wr-004', projectId:'pi-0002', wasteType:'MOTION',            baselinePct:100, currentPct:30, targetPct:50 },
    { id:'wr-005', projectId:'pi-0006', wasteType:'DEFECTS',           baselinePct:100, currentPct:30, targetPct:75 },
    { id:'wr-006', projectId:'pi-0006', wasteType:'OVERPRODUCTION',    baselinePct:100, currentPct:20, targetPct:40 },
    { id:'wr-007', projectId:'pi-0007', wasteType:'TRANSPORTATION',    baselinePct:100, currentPct:28, targetPct:38 },
    { id:'wr-008', projectId:'pi-0007', wasteType:'MOTION',            baselinePct:100, currentPct:38, targetPct:50 },
  ];

  for (const w of WASTES) {
    await prisma.wasteReduction.upsert({
      where:  { id: w.id },
      update: {},
      create: w,
    }).catch(() => {});
  }

  console.log(`✓ Process improvement: ${PROJECTS.length} projects, ${KAIZEN.length} kaizen events, ${WASTES.length} waste records`);
}

main()
  .then(() => seedDynamicData())
  .then(() => seedInventory())
  .then(() => seedProcessImprovement())
  .then(async () => {
    // Newer, additive modules (HRIM, Change Management) are wrapped so a
    // failure in either NEVER fails the whole build. Render's build command
    // is `... && npx prisma db seed` — if this script exits non-zero, the
    // ENTIRE deploy fails and Render silently keeps serving the previous
    // version. That's a much worse outcome than one section skipping.
    try {
      await require('./seed-hrim').seedHrim();
    } catch (e) {
      console.error('⚠ HRIM seed error (non-fatal, deploy continues):', e.message);
    }
    try {
      await require('./seed-change').seedChange();
    } catch (e) {
      console.error('⚠ Change Management seed error (non-fatal, deploy continues):', e.message);
    }
    try {
      await require('./seed-catalog').seedCatalog();
    } catch (e) {
      console.error('⚠ SensorModel catalog seed error (non-fatal, deploy continues):', e.message);
    }
    try {
      await require('./seed-vision-catalog').seedVisionCatalog();
    } catch (e) {
      console.error('⚠ CorverxisVision catalog seed error (non-fatal, deploy continues):', e.message);
    }
    try {
      await require('./seed-lab').seedLab();
    } catch (e) {
      console.error('⚠ CorverxisLab seed error (non-fatal, deploy continues):', e.message);
    }
  })
  .catch((e) => { console.error('❌ Seed failed:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
