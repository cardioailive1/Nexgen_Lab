const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Extracted directly from the standalone CorverxisVision product's real
// PARTS and DEFECT_TYPES definitions (public/corverxis-vision.html).
// Deliberately small — 6 parts, 5 defect types — reflecting that Vision's
// built-in catalog is genuinely thinner than SensorModel's 71 sensor
// definitions, not an equivalent depth padded to look consistent.
const DEFECT_TYPES = ['Surface Scratch', 'Dimensional OOT', 'Porosity/Void', 'Missing Feature', 'Contamination'];

const PARTS = [
  { partKey: 'caliper', partName: 'Brake Caliper', shape: 'caliper', colorHex: '#8a9bb0', applicableDefectTypes: ['Surface Scratch', 'Dimensional OOT', 'Porosity/Void', 'Missing Feature'] },
  { partKey: 'bearing', partName: 'Bearing Race', shape: 'circle', colorHex: '#9a8a70', applicableDefectTypes: ['Surface Scratch', 'Dimensional OOT', 'Porosity/Void'] },
  { partKey: 'pcb', partName: 'PCB Assembly', shape: 'rect', colorHex: '#2d5a27', applicableDefectTypes: ['Missing Feature', 'Contamination', 'Surface Scratch'] },
  { partKey: 'weld', partName: 'Weld Seam', shape: 'weld', colorHex: '#6b7280', applicableDefectTypes: ['Porosity/Void', 'Surface Scratch', 'Dimensional OOT'] },
  { partKey: 'surface', partName: 'Surface Finish', shape: 'flat', colorHex: '#7a8a9a', applicableDefectTypes: ['Surface Scratch', 'Contamination'] },
  { partKey: 'barcode', partName: 'Barcode/QR', shape: 'barcode', colorHex: '#e2e8f0', applicableDefectTypes: ['Missing Feature', 'Contamination'] },
];

async function seedVisionCatalog(prismaClient) {
  const db = prismaClient || prisma;
  const existing = await db.visionPartCatalogEntry.count();
  if (existing > 0) {
    console.log(`✓ CorverxisVision part catalog already seeded (${existing} entries) — skipping`);
    return;
  }
  let created = 0;
  for (const p of PARTS) {
    try {
      await db.visionPartCatalogEntry.create({ data: p });
      created++;
    } catch (e) {
      console.error(`⚠ Vision catalog entry seed failed for ${p.partKey} (non-fatal):`, e.message);
    }
  }
  console.log(`✓ CorverxisVision part catalog: ${created} parts seeded`);
}

module.exports = { seedVisionCatalog, DEFECT_TYPES };

if (require.main === module) {
  seedVisionCatalog()
    .catch((e) => { console.error('❌ Vision catalog seed failed:', e); process.exit(1); })
    .finally(async () => { await prisma.$disconnect(); });
}
