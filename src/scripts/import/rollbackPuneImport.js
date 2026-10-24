/**
 * Rollback Script for Pune PG Dataset Import
 *
 * Safely removes records that were created by the Pune JSON import process,
 * leaving all pre-existing records 100% untouched.
 *
 * Usage:
 *   node src/scripts/import/rollbackPuneImport.js --dry-run   (Dry run, no changes)
 *   node src/scripts/import/rollbackPuneImport.js --apply     (Performs safe rollback)
 */

const fs = require('fs');
const path = require('path');
const backendRoot = path.join(__dirname, '../../..');
require('dotenv').config({ path: path.join(backendRoot, '.env') });
const mongoose = require('mongoose');

async function rollbackPuneImport() {
  const isApply = process.argv.includes('--apply');
  const mode = isApply ? 'APPLY (LIVE)' : 'DRY RUN';
  console.log(`\n============================================================`);
  console.log(`  PUNE IMPORT ROLLBACK UTILITY [Mode: ${mode}]`);
  console.log(`============================================================\n`);

  // 1. Gather all imported IDs from data/Pune/1.json..20.json
  const puneDir = path.join(backendRoot, 'data/Pune');
  const importedPropertyIds = [];
  const importedOwnerIds = new Set();
  const importedLocalities = new Set();

  for (let i = 1; i <= 20; i++) {
    const filePath = path.join(puneDir, `${i}.json`);
    if (!fs.existsSync(filePath)) continue;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) continue;
    const parsed = JSON.parse(raw);
    const items = parsed.data?.[0]?.data || [];
    items.forEach(item => {
      importedPropertyIds.push(new mongoose.Types.ObjectId(item._id));
      if (item.userId) importedOwnerIds.add(new mongoose.Types.ObjectId(item.userId));
      if (item.locality) importedLocalities.add(item.locality.trim().toLowerCase());
    });
  }

  console.log(`Identified ${importedPropertyIds.length} property IDs from Pune JSON files.`);
  console.log(`Identified ${importedOwnerIds.size} potential owner IDs.`);

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const puneCity = await db.collection('cities').findOne({ name: { $regex: /^pune$/i } });
  const puneCityId = puneCity?._id;

  // Check matching properties in DB
  const matchingProps = await db.collection('properties').find({ _id: { $in: importedPropertyIds } }).toArray();
  const matchingPgs = await db.collection('pgs').find({ _id: { $in: importedPropertyIds } }).toArray();
  console.log(`Found ${matchingProps.length} matching properties in 'properties' collection.`);
  console.log(`Found ${matchingPgs.length} matching PGs in 'pgs' collection.`);

  // Find areas in Pune that match imported localities
  let matchingAreas = [];
  if (puneCityId) {
    matchingAreas = await db.collection('areas').find({
      city: puneCityId,
      isAutoCreated: true
    }).toArray();
    console.log(`Found ${matchingAreas.length} auto-created areas under Pune.`);
  }

  // Find owners created that have no properties outside this set
  const ownerIdList = Array.from(importedOwnerIds);
  const matchingOwners = await db.collection('users').find({ _id: { $in: ownerIdList } }).toArray();
  console.log(`Found ${matchingOwners.length} matching owner users in 'users' collection.`);

  if (!isApply) {
    console.log(`\nℹ️  DRY RUN complete. To execute rollback, re-run with:`);
    console.log(`   node src/scripts/import/rollbackPuneImport.js --apply\n`);
    await mongoose.disconnect();
    return;
  }

  console.log('\n⚠️  APPLYING ROLLBACK...');

  // 1. Delete properties
  if (matchingProps.length > 0) {
    const resProp = await db.collection('properties').deleteMany({ _id: { $in: importedPropertyIds } });
    console.log(`🗑️  Deleted ${resProp.deletedCount} documents from 'properties'.`);
  }

  // 2. Delete PGs
  if (matchingPgs.length > 0) {
    const resPg = await db.collection('pgs').deleteMany({ _id: { $in: importedPropertyIds } });
    console.log(`🗑️  Deleted ${resPg.deletedCount} documents from 'pgs'.`);
  }

  // 3. Delete auto-created Pune areas if no other properties reference them
  if (matchingAreas.length > 0) {
    const areaIds = matchingAreas.map(a => a._id);
    const stillReferenced = await db.collection('properties').distinct('areaId', { areaId: { $in: areaIds } });
    const unreferencedAreaIds = areaIds.filter(id => !stillReferenced.some(ref => ref.equals(id)));
    if (unreferencedAreaIds.length > 0) {
      const resArea = await db.collection('areas').deleteMany({ _id: { $in: unreferencedAreaIds } });
      console.log(`🗑️  Deleted ${resArea.deletedCount} unused auto-created areas from 'areas'.`);
    }
  }

  // 4. Delete owner users if they own no other properties
  if (matchingOwners.length > 0) {
    const stillOwners = await db.collection('properties').distinct('owner', { owner: { $in: ownerIdList } });
    const ownersToDelete = ownerIdList.filter(id => !stillOwners.some(ref => ref.equals(id)));
    if (ownersToDelete.length > 0) {
      const resUser = await db.collection('users').deleteMany({ _id: { $in: ownersToDelete } });
      console.log(`🗑️  Deleted ${resUser.deletedCount} imported owner users from 'users'.`);
    }
  }

  console.log('\n✅ Rollback completed successfully.\n');
  await mongoose.disconnect();
}

if (require.main === module) {
  rollbackPuneImport()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('❌ Rollback error:', err);
      process.exit(1);
    });
}

module.exports = rollbackPuneImport;
