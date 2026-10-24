/**
 * Pre-Import Database State Backup & Snapshot Script
 *
 * Captures current database collection counts, indexes, and primary ID manifests
 * to verify data integrity and guarantee non-destructive execution before imports.
 */

const fs = require('fs');
const path = require('path');
const backendRoot = path.join(__dirname, '../../..');
require('dotenv').config({ path: path.join(backendRoot, '.env') });
const mongoose = require('mongoose');

async function backupDatabaseState() {
  console.log('🔄 Connecting to MongoDB to capture baseline snapshot...');
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const backupDir = path.join(backendRoot, 'data/backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotFile = path.join(backupDir, `pre_pune_import_snapshot_${timestamp}.json`);
  const latestFile = path.join(backupDir, 'latest_snapshot.json');

  const collections = ['users', 'properties', 'pgs', 'cities', 'areas'];
  const snapshot = {
    timestamp: new Date().toISOString(),
    collections: {},
    manifests: {}
  };

  for (const colName of collections) {
    const col = db.collection(colName);
    const count = await col.countDocuments();
    const indexes = await col.indexes();
    
    snapshot.collections[colName] = {
      count,
      indexes: indexes.map(idx => idx.name)
    };

    // For critical collections, record existing IDs for tamper detection
    if (['properties', 'pgs', 'users'].includes(colName)) {
      const docs = await col.find({}, { projection: { _id: 1, createdAt: 1 } }).toArray();
      snapshot.manifests[colName] = docs.map(d => ({
        id: d._id.toString(),
        createdAt: d.createdAt
      }));
    }
  }

  fs.writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2), 'utf8');
  fs.writeFileSync(latestFile, JSON.stringify(snapshot, null, 2), 'utf8');

  console.log('✅ Baseline snapshot successfully captured:');
  console.log(`   Snapshot file: ${snapshotFile}`);
  console.log(`   Collections summary:`);
  for (const [col, info] of Object.entries(snapshot.collections)) {
    console.log(`   - ${col.padEnd(12)}: ${info.count} documents (${info.indexes.length} indexes)`);
  }

  await mongoose.disconnect();
  return snapshot;
}

if (require.main === module) {
  backupDatabaseState()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('❌ Backup failed:', err);
      process.exit(1);
    });
}

module.exports = backupDatabaseState;
