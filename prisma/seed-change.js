const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const INITIATIVES = [
  {
    title: 'Predictive Maintenance Rollout — CNC & Robotic Cells',
    pillar: 'PREDICTIVE_MAINTENANCE', phase: 'SCALING', ownerName: 'VP Manufacturing',
    targetDept: 'Manufacturing Ops', linkedModule: 'pred',
    description: 'IoT-sensor-driven vibration, temperature, and acoustic monitoring on CNC machines and robotic cells to predict tool wear and machine failure before it happens.',
    adoptionPct: 68, sentimentScore: 82, status: 'ON_TRACK',
  },
  {
    title: 'AI-Powered Optical Inspection — Computer Vision QC',
    pillar: 'QUALITY_CONTROL', phase: 'PILOT', ownerName: 'Quality Director',
    targetDept: 'Quality Engineering', linkedModule: 'vision',
    description: 'AI-powered optical inspection to catch micro-defects in precision parts that traditional gauges or the human eye miss, targeting 100% quality compliance.',
    adoptionPct: 34, sentimentScore: 71, status: 'ON_TRACK',
  },
  {
    title: 'AI-Driven Supply Chain & Inventory Optimization',
    pillar: 'SUPPLY_CHAIN', phase: 'PILOT', ownerName: 'Supply Chain Manager',
    targetDept: 'Supply Chain', linkedModule: 'supply',
    description: 'Demand-pattern and lead-time analysis for raw materials (steel, aluminum) to improve inventory management and reduce carrying costs.',
    adoptionPct: 41, sentimentScore: 76, status: 'ON_TRACK',
  },
  {
    title: '"Golden Batch" Process Optimization',
    pillar: 'PROCESS_OPTIMIZATION', phase: 'DATA_FOUNDATION', ownerName: 'Process Engineering Lead',
    targetDept: 'Manufacturing Ops', linkedModule: 'pia',
    description: 'ML analysis of historical production data to identify the optimal combination of speed, feed rate, and coolant pressure — maximizing output while minimizing energy use and scrap.',
    adoptionPct: 12, sentimentScore: 65, status: 'AT_RISK',
  },
];

const RISKS = [
  { title: 'Data Silos — legacy MES not fully integrated with ERP', category: 'DATA_SILOS', severity: 'HIGH', mitigation: 'Complete ERP↔MES integration via ERP Integration Hub before scaling further pilots.', linkedModule: 'erp' },
  { title: 'Expanded attack surface from shop-floor network connectivity', category: 'CYBERSECURITY', severity: 'HIGH', mitigation: 'Segment OT network from IT network; enforce least-privilege access for sensor gateways.', linkedModule: 'aiops' },
  { title: 'Skill gap — limited in-house ML/data analyst capacity', category: 'SKILL_GAP', severity: 'MEDIUM', mitigation: 'Partner with external AI consultants short-term; hire 2 data analysts with manufacturing OT background.', linkedModule: 'hrim' },
  { title: 'Shop-floor resistance — fear that AI signals future layoffs', category: 'RESISTANCE', severity: 'MEDIUM', mitigation: 'Reframe as upskilling, not replacement; involve operators directly in AI system design.', linkedModule: 'hrim' },
];

const TRAINING_MODELS = [
  {
    pillar: 'PREDICTIVE_MAINTENANCE', title: 'Predictive Maintenance for Operators',
    description: 'How to read AI-flagged RUL alerts, interpret vibration/temperature trend charts, and escalate before a machine crash — not after.',
    format: 'Hands-On Shadow', durationHours: 3, targetRole: 'Machine Operators, Maintenance Technicians', courseSlug: 'predictive-maintenance',
  },
  {
    pillar: 'QUALITY_CONTROL', title: 'Computer Vision QC Certification',
    description: 'Operating the AI optical inspection stations, understanding pass/fail confidence scores, and handling edge cases the model flags for human review.',
    format: 'Instructor-Led', durationHours: 4, targetRole: 'Quality Inspectors, Line Operators', courseSlug: 'vision-qc',
  },
  {
    pillar: 'SUPPLY_CHAIN', title: 'AI-Assisted Supply & Inventory Planning',
    description: 'Reading AI demand forecasts, adjusting reorder points, and validating model recommendations against supplier lead-time reality.',
    format: 'Self-Paced', durationHours: 2.5, targetRole: 'Supply Chain Analysts, Buyers', courseSlug: 'supply-chain-ai',
  },
  {
    pillar: 'PROCESS_OPTIMIZATION', title: 'Process Data & Golden Batch Analytics',
    description: 'Understanding how the ML model identifies optimal speed/feed/coolant combinations, and how to validate findings on the floor.',
    format: 'Self-Paced', durationHours: 3, targetRole: 'Process Engineers, Line Supervisors', courseSlug: 'golden-batch',
  },
  {
    pillar: 'OTHER', title: 'AI Literacy 101 — Upskilling, Not Replacing',
    description: 'Company-wide foundation course: what AI does and doesn\'t do on the floor, how it makes jobs safer, and how to raise concerns.',
    format: 'Self-Paced', durationHours: 1, targetRole: 'All Employees', courseSlug: 'ai-literacy',
  },
  {
    pillar: 'COMPLIANCE', title: 'IATF 16949 Fundamentals',
    description: 'The automotive quality management standard governing how Corverxis builds precision parts — APQP, PPAP, FMEA, MSA, SPC, and corrective action.',
    format: 'Instructor-Led', durationHours: 4, targetRole: 'All Production & Quality Staff', isRequired: true, courseSlug: 'iatf-16949',
  },
  {
    pillar: 'TECHNICAL', title: 'LLM Fine-Tuning for Manufacturing AI',
    description: 'How Corverxis adapts large language models to manufacturing-specific tasks like NCR drafting and work order summarization.',
    format: 'Self-Paced', durationHours: 5, targetRole: 'Engineering, AI Ops, Quality', courseSlug: 'llm-finetuning',
  },
  {
    pillar: 'OPERATIONS', title: 'Lean Six Sigma Green Belt',
    description: 'Core process-improvement tools — the 8 wastes, DMAIC, basic statistical process control, and running a Kaizen event.',
    format: 'Instructor-Led', durationHours: 6, targetRole: 'Operations, Process Engineering', courseSlug: 'lean-six-sigma',
  },
  {
    pillar: 'LEADERSHIP', title: 'People Management Essentials',
    description: 'Core supervisory skills — setting expectations, giving feedback, difficult conversations, delegation, and psychological safety.',
    format: 'Instructor-Led', durationHours: 5, targetRole: 'Supervisors & Managers', isRequired: true, courseSlug: 'people-management',
  },
  {
    pillar: 'SAFETY', title: 'Workplace Safety & OSHA',
    description: 'OSHA rights and responsibilities, Lockout/Tagout, machine guarding, hazard communication, and incident/near-miss reporting.',
    format: 'Instructor-Led', durationHours: 3, targetRole: 'All Plant Floor Employees', isRequired: true, courseSlug: 'workplace-safety',
  },
  {
    pillar: 'TECHNICAL', title: 'Data-Driven Decision Making',
    description: 'Reading dashboards critically, correlation vs. causation, basic statistical literacy, and making a data-backed proposal.',
    format: 'Self-Paced', durationHours: 3, targetRole: 'Analysts, Supervisors, Engineers', courseSlug: 'data-driven-decisions',
  },
];

async function seedChange() {
  const org = await prisma.org.findUnique({ where: { slug: 'corverxis-demo' } });
  if (!org) { console.log('⚠ No demo org found — skipping Change Management seed'); return; }

  // Each section is wrapped independently: a failure creating one
  // initiative/risk/model must never prevent the others from seeding,
  // and must never bubble up and fail the whole Render build.

  let created = [];
  try {
    const initiativeCount = await prisma.changeInitiative.count({ where: { orgId: org.id } });
    if (initiativeCount === 0) {
      for (const i of INITIATIVES) {
        created.push(await prisma.changeInitiative.create({ data: { orgId: org.id, ...i } }));
      }
      console.log(`✓ Change Management: ${created.length} initiatives seeded across 4 pillars`);
    } else {
      created = await prisma.changeInitiative.findMany({ where: { orgId: org.id } });
      console.log(`✓ Change Management: ${initiativeCount} initiatives already present — skipping`);
    }
  } catch (e) { console.error('⚠ Initiative seeding failed (non-fatal):', e.message); }

  try {
    const riskCount = await prisma.changeRisk.count({ where: { orgId: org.id } });
    if (riskCount === 0) {
      for (const r of RISKS) {
        await prisma.changeRisk.create({ data: { orgId: org.id, ...r } });
      }
      console.log(`✓ Change Management: ${RISKS.length} risks seeded`);
    } else {
      console.log(`✓ Change Management: ${riskCount} risks already present — skipping`);
    }
  } catch (e) { console.error('⚠ Risk seeding failed (non-fatal):', e.message); }

  try {
    const commCount = await prisma.changeCommunication.count({ where: { orgId: org.id } });
    if (commCount === 0) {
      const predInit = created.find(i => i.pillar === 'PREDICTIVE_MAINTENANCE');
      const visionInit = created.find(i => i.pillar === 'QUALITY_CONTROL');
      const COMMS = [
        { title: 'Town Hall: Why We\'re Piloting Predictive Maintenance', audience: 'All Plant Floor', channel: 'Town Hall', summary: 'Leadership explained the predictive maintenance pilot goal — reducing unplanned downtime, not headcount — and invited operator feedback.', initiativeId: predInit?.id || null },
        { title: 'Computer Vision QC Pilot — Line 3 Kickoff Notice', audience: 'Line 3 Operators & QA', channel: 'Posted Notice', summary: 'Announced the optical inspection pilot on Line 3, with a two-week shadow period before the system goes live.', initiativeId: visionInit?.id || null },
        { title: 'AI Adoption FAQ — Upskilling Not Replacing', audience: 'All Employees', channel: 'Email', summary: 'Company-wide email addressing common concerns about AI and automation, reinforcing the upskilling commitment.', initiativeId: null },
      ];
      for (const c of COMMS) {
        await prisma.changeCommunication.create({ data: { orgId: org.id, ...c } });
      }
      console.log(`✓ Change Management: ${COMMS.length} communications seeded`);
    } else {
      console.log(`✓ Change Management: ${commCount} communications already present — skipping`);
    }
  } catch (e) { console.error('⚠ Communication seeding failed (non-fatal):', e.message); }

  let modelRows = [];
  try {
    const modelCount = await prisma.changeTrainingModel.count({ where: { orgId: org.id } });
    if (modelCount === 0) {
      for (const t of TRAINING_MODELS) {
        modelRows.push(await prisma.changeTrainingModel.create({ data: { orgId: org.id, ...t } }));
      }
      console.log(`✓ Change Management: ${modelRows.length} training models seeded across all pillars`);
    } else {
      modelRows = await prisma.changeTrainingModel.findMany({ where: { orgId: org.id } });
      console.log(`✓ Change Management: ${modelCount} training models already present — skipping`);
    }
  } catch (e) { console.error('⚠ Training model seeding failed (non-fatal):', e.message); }

  // Enroll a sample of existing employees so completion tracking has real
  // data to show — only if this training model has zero enrollments yet.
  try {
    const sampleEmployees = await prisma.hrEmployee.findMany({ where: { orgId: org.id, status: 'ACTIVE' }, take: 20 });
    if (sampleEmployees.length && modelRows.length) {
      let enrolled = 0;
      for (const model of modelRows) {
        const existingEnrollments = await prisma.hrTraining.count({ where: { changeTrainingModelId: model.id } });
        if (existingEnrollments > 0) continue;
        const shuffled = [...sampleEmployees].sort(() => Math.random() - 0.5).slice(0, Math.min(6, sampleEmployees.length));
        for (const emp of shuffled) {
          const roll = Math.random();
          const status = roll < 0.4 ? 'COMPLETED' : roll < 0.75 ? 'IN_PROGRESS' : 'NOT_STARTED';
          await prisma.hrTraining.create({
            data: {
              orgId: org.id, employeeId: emp.id, courseName: model.title, provider: 'Corverxis Change Academy',
              changeTrainingModelId: model.id, status,
              completedAt: status === 'COMPLETED' ? new Date() : null,
            }
          }).catch(() => {});
          enrolled++;
        }
      }
      if (enrolled) console.log(`✓ Change Management: ${enrolled} training enrollments seeded`);
    }
  } catch (e) { console.error('⚠ Training enrollment seeding failed (non-fatal):', e.message); }
}

module.exports = { seedChange };

if (require.main === module) {
  seedChange()
    .catch((e) => { console.error('❌ Change Management seed failed:', e); process.exit(1); })
    .finally(async () => { await prisma.$disconnect(); });
}
