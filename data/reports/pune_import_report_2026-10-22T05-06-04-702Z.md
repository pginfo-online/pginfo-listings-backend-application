# Pune PG Dataset Import Report
**Date:** 2026-10-22T05:06:04.702Z  
**Execution Mode:** LIVE APPLY  
**Duration:** 14.09s  

---

## 1. Executive Summary
- **Files Scanned:** 100 JSON files (20 valid data files, 80 empty placeholder files, 0 malformed)
- **Total Listings in Source:** 200
- **Successfully Transformed:** 200
- **Validation Failures:** 0
- **Properties Written:** 0
- **PGs Written:** 0
- **Owners Resolved/Created:** 167 (New: 0, Matched: 167)
- **Areas Resolved/Created:** 67 distinct localities (New: 0, Matched: 399)
- **Room Configurations:** 433
- **Photos Mapped:** 1014

---

## 2. City & Area Resolution
- **City:** Pune (`6a8698dfcfb45c57ac09ad31`)
- **New Localities Added to Areas Collection (0):**  
  

---

## 3. Owner User Provisioning
- **Total Owner Profiles:** 167
- **New Users Added (0):** All assigned roles `['owner', 'pg_owner']`, verified phone & active status.
- **Phone Collisions:** 0
- **Email Collisions:** 0

---

## 4. Listing Schema & Data Quality
- **Category:** `pg`
- **Purpose:** `rent`
- **Status:** `approved`
- **Coordinates:** 100% valid GeoJSON `Point` coordinates. Zero `[0, 0]` coordinates.
- **Slugs:** 100% unique slugs generated using `slugUtil`. Zero collisions.
- **Photos:** Up to 20 photos per property (range: 2-14 photos per listing).
- **Pricing:** Min starting rent calibrated from room configs (`expectedPrice`).

---

## 5. Validation & Error Log
_Zero validation failures encountered. 100% of records passed strict checks._

---

## 6. Safety & Rollback Information
- Baseline database snapshot created prior to execution.
- To reverse this import at any time, execute:
  `node src/scripts/import/rollbackPuneImport.js --apply`
