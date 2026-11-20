const fs = require('node:fs');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { once } = require('node:events');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { BSON, MongoClient } = require('mongodb');
require('dotenv').config();

const selected = [
  'pgs', 'agreements', 'buildings', 'expenses', 'payments', 'rentrecords', 'rooms', 'tenants',
  'buffetmenus', 'buffetpromotions', 'buffetreservations', 'buffetreviews', 'buffets',
  'hotelregistrationrequests', 'hotels', 'hotdealcategories', 'hotdeals', 'weeklybuffetplans',
];
const magic = Buffer.from('PGARCH1');
const headerSize = magic.length + 12;

function keyFromEnvironment() {
  const value = process.env.PGINFO_LEGACY_ARCHIVE_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('Set a 32-byte hexadecimal PGINFO_LEGACY_ARCHIVE_KEY.');
  return Buffer.from(value, 'hex');
}

async function createArchive(path, key) {
  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  const session = client.startSession({ snapshot: true });
  const nonce = crypto.randomBytes(12);
  const header = Buffer.concat([magic, nonce]);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(header);
  const output = fs.createWriteStream(path, { flags: 'wx' });
  await once(output, 'open');
  try {
    output.write(header);
    await client.connect();
    const db = client.db();
    const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(({ name }) => name));
    const counts = {};
    async function* contents() {
      for (const name of selected.filter((name) => existing.has(name))) {
        const collection = db.collection(name);
        const indexes = await collection.indexes();
        yield BSON.EJSON.stringify({ collection: name, indexes }, { relaxed: false }) + '\n';
        counts[name] = 0;
        const cursor = collection.find({}, { batchSize: 100, session }).sort({ _id: 1 });
        for await (const doc of cursor) {
          yield BSON.EJSON.stringify({ collection: name, document: doc }, { relaxed: false }) + '\n';
          counts[name] += 1;
        }
      }
      yield JSON.stringify({ counts }) + '\n';
    }
    const appendTag = new Transform({
      transform(chunk, _encoding, callback) { callback(null, chunk); },
      flush(callback) { callback(null, cipher.getAuthTag()); },
    });
    await pipeline(contents(), cipher, appendTag, output);
    console.log(JSON.stringify({ archived: counts }, null, 2));
  } catch (error) {
    output.destroy();
    throw error;
  } finally {
    await session.endSession();
    await client.close();
  }
}

async function readArchive(path, key, visit = async () => {}) {
  const file = await fs.promises.open(path, 'r');
  const header = Buffer.alloc(headerSize);
  const tag = Buffer.alloc(16);
  const { size } = await file.stat();
  try {
    if (size <= headerSize + tag.length) throw new Error('Archive is truncated.');
    await file.read(header, 0, header.length, 0);
    await file.read(tag, 0, tag.length, size - tag.length);
  } finally {
    await file.close();
  }
  if (!header.subarray(0, magic.length).equals(magic)) throw new Error('Archive header is invalid.');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(magic.length));
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  const counts = {};
  let expected;
  await pipeline(fs.createReadStream(path, { start: headerSize, end: size - tag.length - 1 }), decipher, async (source) => {
    for await (const line of readline.createInterface({ input: source, crlfDelay: Infinity })) {
      const entry = BSON.EJSON.parse(line, { relaxed: false });
      if (entry.indexes) counts[entry.collection] = 0;
      else if (entry.document) counts[entry.collection] += 1;
      else if (entry.counts) expected = Object.fromEntries(
        Object.entries(entry.counts).map(([name, count]) => [name, Number(count)])
      );
      await visit(entry, line);
    }
  });
  if (!expected || JSON.stringify(counts) !== JSON.stringify(expected)) throw new Error('Archive counts do not match.');
  return counts;
}

async function testRestore(path, key) {
  const uri = process.env.PGINFO_ARCHIVE_RESTORE_URI || '';
  const target = new URL(uri);
  if (target.protocol !== 'mongodb:' || target.hostname !== '127.0.0.1' ||
      !target.port || !/^\/pginfo_archive_restore_[a-z0-9]+$/.test(target.pathname) ||
      target.username || target.password || target.search) {
    throw new Error('Restore verification requires a dedicated local pginfo_archive_restore_* MongoDB database.');
  }
  const expected = await readArchive(path, key);
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const db = client.db();
    if (await db.listCollections().hasNext()) throw new Error('Restore verification database must be empty.');
    const collections = new Map();
    let batch = [];
    let current;
    let hash;
    const flush = async () => {
      if (batch.length) await db.collection(current).insertMany(batch);
      batch = [];
    };

    await readArchive(path, key, async (entry) => {
      if (entry.indexes) {
        await flush();
        current = entry.collection;
        if (!selected.includes(current) || collections.has(current)) throw new Error('Unexpected collection in archive.');
        await db.createCollection(current);
        hash = crypto.createHash('sha256');
        collections.set(current, { indexes: entry.indexes, hash });
      } else if (entry.document) {
        if (entry.collection !== current) throw new Error('Archive document is outside its collection.');
        hash.update(BSON.EJSON.stringify(entry.document, { relaxed: false }) + '\n');
        batch.push(entry.document);
        if (batch.length >= 100) await flush();
      }
    });
    await flush();

    let indexCount = 0;
    for (const [name, archive] of collections) {
      const collection = db.collection(name);
      for (const { key: indexKey, v, ns, ...options } of archive.indexes) {
        if (options.name !== '_id_') {
          const keys = Object.entries(indexKey).map(([field, value]) =>
            [field, typeof value === 'string' ? value : Number(value)]
          );
          // Text indexes expose their internal key and store the original fields in weights.
          const textKeys = keys.flatMap(([field, value]) => field === '_fts'
            ? Object.keys(options.weights).map((textField) => [textField, 'text'])
            : field === '_ftsx' ? [] : [[field, value]]);
          await collection.createIndex(textKeys, BSON.EJSON.deserialize(BSON.EJSON.serialize(options), { relaxed: true }));
        }
      }
      const restoredIndexes = await collection.indexes();
      const names = new Set(restoredIndexes.map(({ name: indexName }) => indexName));
      if (names.size !== archive.indexes.length || archive.indexes.some((index) => !names.has(index.name))) {
        throw new Error('Restored index names do not match in ' + name);
      }
      indexCount += names.size;
      const digest = crypto.createHash('sha256');
      let count = 0;
      const cursor = collection.find({}, { promoteValues: false }).sort({ _id: 1 });
      for await (const document of cursor) {
        digest.update(BSON.EJSON.stringify(document, { relaxed: false }) + '\n');
        count += 1;
      }
      if (count !== expected[name] || digest.digest('hex') !== archive.hash.digest('hex')) {
        throw new Error('Restored document counts or contents differ in ' + name);
      }
    }
    console.log(JSON.stringify({ restored: expected, indexCount, verifiedContents: true }, null, 2));
  } finally {
    await client.close();
  }
}

async function main() {
  const [action, target] = process.argv.slice(2);
  if (!target || !['--create', '--verify', '--test-restore'].includes(action)) {
    throw new Error('Usage: node archiveRetiredCollections.js --create|--verify|--test-restore <encrypted archive path>');
  }
  const key = keyFromEnvironment();
  if (action === '--create') await createArchive(target, key);
  else if (action === '--test-restore') await testRestore(target, key);
  else console.log(JSON.stringify({ verified: await readArchive(target, key) }, null, 2));
}

if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { readArchive };
