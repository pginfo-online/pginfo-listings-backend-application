const mongoose = require('mongoose');
const { z } = require('zod');

const config = z.object({
  MONGODB_URI: z.string().min(1),
  ADMIN_SEED_DATABASE: z.string().min(1),
  ADMIN_SEED_EMAIL: z.string().trim().toLowerCase().email(),
  ADMIN_SEED_NAME: z.string().trim().min(2).max(100),
  ADMIN_SEED_PASSWORD: z.string().min(14).refine((value) => Buffer.byteLength(value) <= 72),
}).safeParse(process.env);

async function seedAdmin() {
  if (!config.success) {
    throw new Error(`Check seed configuration: ${config.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
  }
  const env = config.data;
  const User = require('../models/User.model');
  await mongoose.connect(env.MONGODB_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
  if (mongoose.connection.name !== env.ADMIN_SEED_DATABASE) throw new Error('Connected database does not match ADMIN_SEED_DATABASE.');
  const indexes = await User.collection.indexes().catch((error) => {
    if (error.code === 26) return [];
    throw error;
  });
  if (!indexes.some((index) => index.unique && index.key.email === 1 && Object.keys(index.key).length === 1)) {
    await User.collection.createIndex({ email: 1 }, { unique: true, sparse: true });
  }
  const existing = await User.findOne({ email: env.ADMIN_SEED_EMAIL });
  if (existing) {
    if (!existing.isActive || !existing.hasRole('admin')) throw new Error('Existing account requires explicit operator review.');
    console.log('Administrator already exists.');
    return;
  }
  await User.create({ name: env.ADMIN_SEED_NAME, email: env.ADMIN_SEED_EMAIL,
    password: env.ADMIN_SEED_PASSWORD, role: 'admin', roles: ['admin'] });
  console.log('Administrator created.');
}

seedAdmin().catch((error) => {
  const message = error.name === 'Error' && /^(Check seed|Connected database|Existing account)/.test(error.message)
    ? error.message : 'Database operation failed. Verify connectivity, the email index, and database permissions.';
  console.error(message);
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
