require('dotenv').config();
const mongoose = require('mongoose');
const SavedSearch = require('../../models/SavedSearch.model');
const RentalBooking = require('../../models/RentalBooking.model');

async function main() {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGODB_URI, {
    autoCreate: false,
    autoIndex: false,
    serverSelectionTimeoutMS: 5000,
  });
  try {
    const db = mongoose.connection.db;
    for (const model of [SavedSearch, RentalBooking]) {
      const collection = db.collection(model.collection.name);
      const exists = await db.listCollections({ name: collection.collectionName }, { nameOnly: true }).hasNext();
      const existing = exists ? await collection.indexes() : [];
      for (const [key, options] of model.schema.indexes()) {
        const current = existing.find((index) => JSON.stringify(index.key) === JSON.stringify(key));
        if (current) console.log(`Present ${current.name}`);
        else if (apply) console.log(`Created ${await collection.createIndex(key, options)}`);
        else console.log(`Would create ${JSON.stringify(key)}`);
      }
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
