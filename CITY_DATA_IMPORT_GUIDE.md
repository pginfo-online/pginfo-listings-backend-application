# Importing PG Data for Another City

This guide explains how to import a city's JSON PG listings into this backend's
MongoDB database using `src/scripts/import/importCityDataset.js`.

## Before you start

- Run the commands from the `backend` directory.
- Confirm `.env` points to the intended MongoDB database. The import scripts load
  `.env` themselves; do not paste or share its contents.
- Have a **restorable** database backup before applying an import. The
  `backupDatabaseState.js` script below records collection counts, indexes, and
  ID manifests; it is not a database backup.
- Have the city's listings as JSON files in a folder such as
  `data/Mumbai/1.json`, `data/Mumbai/2.json`, and so on. The importer scans
  `.json` files directly in that folder, not in nested folders.

The importer accepts these JSON shapes:

```json
{ "data": [{ "data": [{ "_id": "..." }] }] }
```

```json
[{ "_id": "..." }]
```

```json
{ "data": [{ "_id": "..." }] }
```

```json
{ "properties": [{ "_id": "..." }] }
```

Each importable listing needs a valid MongoDB ObjectId in `_id` and an owner ID
in `userId` or `owner._id`.

## 1. Set the city and prepare its data folder

Replace `Mumbai` with the canonical city name used in the database:

```bash
cd /path/to/PgInfoListings/backend
CITY="Mumbai"
mkdir -p "data/$CITY"
find "data/$CITY" -maxdepth 1 -type f -name '*.json' -print | sort
```

Place the city's JSON files in that folder. Empty JSON files are skipped, but
malformed JSON files are reported.

## 2. Confirm the city record and coordinates

The city must already exist in the `cities` collection. Check it before
importing; the coordinates matter because the importer uses them when a
listing has no valid coordinates.

```bash
node - "$CITY" <<'NODE'
require('dotenv').config();
const mongoose = require('mongoose');
const cityName = process.argv[2];

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    const city = await mongoose.connection.db.collection('cities').findOne(
      { name: new RegExp(`^${cityName}$`, 'i') },
      { projection: { name: 1, state: 1, latitude: 1, longitude: 1 } }
    );
    console.log(city || `City not found: ${cityName}`);
    if (!city) process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
NODE
```

If the city is missing or its coordinates are missing, stop and have the city
record corrected before proceeding. The import script requires the city record;
its fallback coordinates are Pune's.

## 3. Capture a database-state manifest

```bash
node src/scripts/backup/backupDatabaseState.js
```

This writes timestamped metadata and `data/backups/latest_snapshot.json`. It
does **not** contain the database documents and cannot restore the database.
Use your database provider's snapshot or another approved full-backup method
before applying changes, especially for production.

## 4. Run a dry-run

```bash
node src/scripts/import/importCityDataset.js \
  --city="$CITY" \
  --dir="data/$CITY" \
  --dry-run
```

The dry-run connects to MongoDB to inspect the city, existing areas, and users,
but does not write those records or listings to MongoDB. It does write a local
report under `data/reports/`.

Review the summary and report. Check that:

- The scanned, valid, and empty file counts are expected.
- The raw listing count is plausible for the source data.
- There are no malformed files or validation failures.
- The proposed new area and owner counts are expected.

Stop and investigate any unexpected counts or failures. The importer can still
proceed with valid records when some source data is invalid, so a successful
dry-run alone is not a reason to ignore reported failures.

## 5. Apply the import

Only after reviewing the dry-run and confirming the backup, run:

```bash
node src/scripts/import/importCityDataset.js \
  --city="$CITY" \
  --dir="data/$CITY" \
  --apply
```

The default property batch size is 100. It can be changed with, for example,
`--batch-size=50`.

### What the apply does

- Resolves the existing city record; it does not create a missing city.
- Upserts areas for the city's localities.
- Resolves owners by ID, phone, or email, and creates user records for owners
  that do not match an existing user.
- Transforms listings and upserts them into the unified `properties`
  collection as PG listings. It does not import them into the legacy `pgs`
  collection.
- Saves a detailed report in `data/reports/`.

Property writes use each source listing's `_id`. If that ID already exists in
`properties`, the import updates that document; otherwise, it inserts it.
Area, user, and property writes are not one database transaction. If an apply
fails, some earlier writes or batches may already have completed. Review the
error and database state before retrying.

## 6. Verify the city-level property count

This reports the total PG property count for the city:

```bash
node - "$CITY" <<'NODE'
require('dotenv').config();
const mongoose = require('mongoose');
const cityName = process.argv[2];

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    const count = await mongoose.connection.db.collection('properties').countDocuments({
      city: cityName,
      category: 'pg'
    });
    console.log(`${cityName} PG properties in database: ${count}`);
  } finally {
    await mongoose.disconnect();
  }
})().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
NODE
```

This count may include listings that were already in the database. Compare it
with the apply output and the import report, which records the number of source
listings transformed and written.

## Important notes

- The import report is generated for both dry-run and apply.
- `src/scripts/import/rollbackPuneImport.js` is Pune-specific; do not use it to
  roll back another city's import.
- Keep the source JSON files, dry-run/apply reports, and database backup until
  the imported data has been checked.
