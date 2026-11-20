const definitions = [
  {
    key: { owner: 1, createdAt: -1, _id: -1 },
    name: 'catalog_owner_newest',
  },
];

async function run() {
  require('dotenv').config();
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
  });
  const apply = process.argv.includes('--apply');

  try {
    await client.connect();
    const collection = client.db().collection('properties');
    const indexes = await collection.indexes();
    for (const { key, name } of definitions) {
      const current = indexes.find((index) => index.name === name);
      if (current) {
        if (JSON.stringify(current.key) !== JSON.stringify(key)) {
          throw new Error(`Existing index ${name} has a different key pattern`);
        }
        console.log(`Present ${name}`);
      } else if (apply) {
        await collection.createIndex(key, { name });
        console.log(`Created ${name}`);
      } else {
        console.log(`Would create ${name} ${JSON.stringify(key)}`);
      }
    }
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = definitions;
