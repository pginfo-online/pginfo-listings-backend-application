# Pune PG Dataset Import Report
**Date:** 2026-10-22T05:02:39.053Z  
**Execution Mode:** DRY RUN  
**Duration:** 0.85s  

---

## 1. Executive Summary
- **Files Scanned:** 100 JSON files (20 valid data files, 80 empty placeholder files, 0 malformed)
- **Total Listings in Source:** 200
- **Successfully Transformed:** 200
- **Validation Failures:** 0
- **Properties Written:** Simulated (200)
- **PGs Written:** Simulated (200)
- **Owners Resolved/Created:** 167 (New: 167, Matched: 0)
- **Areas Resolved/Created:** 67 distinct localities (New: 50, Matched: 349)
- **Room Configurations:** 433
- **Photos Mapped:** 1014

---

## 2. City & Area Resolution
- **City:** Pune (`6a8698dfcfb45c57ac09ad31`)
- **New Localities Added to Areas Collection (50):**  
  `Yerawada` (slug: `yerawada`), `Chokhi Dhani` (slug: `chokhi-dhani`), `Gokhalenagar` (slug: `gokhalenagar`), `Kalas` (slug: `kalas`), `Mundhwa` (slug: `mundhwa`), `Kharadi Bypass Road` (slug: `kharadi-bypass-road`), `Tingre Nagar` (slug: `tingre-nagar`), `Vadgaon Budruk` (slug: `vadgaon-budruk`), `Baner Road` (slug: `baner-road`), `Baner Gaon` (slug: `baner-gaon`), `Veerbhadra Nagar` (slug: `veerbhadra-nagar`), `Balewadi Gaon` (slug: `balewadi-gaon`), `Wireless Colony` (slug: `wireless-colony`), `Samarth Colony` (slug: `samarth-colony`), `Mhada Colony` (slug: `mhada-colony`), `Aundh Road` (slug: `aundh-road`), `Pashan` (slug: `pashan`), `Dhanori` (slug: `dhanori`), `Sanjay Park` (slug: `sanjay-park`), `Model Colony` (slug: `model-colony`), `Sopan Nagar` (slug: `sopan-nagar`), `Pisoli` (slug: `pisoli`), `Krushna Nagar` (slug: `krushna-nagar`), `Clover Park` (slug: `clover-park`), `Ganesh Nagar` (slug: `ganesh-nagar`), `Somnath Nagar` (slug: `somnath-nagar`), `Konark Nagar` (slug: `konark-nagar`), `Sakore Nagar` (slug: `sakore-nagar`), `Survey Number 235` (slug: `survey-number-235`), `Old Mundhwa Road` (slug: `old-mundhwa-road`), `Air Force Area` (slug: `air-force-area`), `Jagtap Dairy` (slug: `jagtap-dairy`), `Aga Nagar` (slug: `aga-nagar`), `Raghavendra Nagar` (slug: `raghavendra-nagar`), `Thite Nagar` (slug: `thite-nagar`), `Rakshak Nagar` (slug: `rakshak-nagar`), `Kharadi Gaon` (slug: `kharadi-gaon`), `Eknath Pathare Vasti` (slug: `eknath-pathare-vasti`), `Ashoka Nagar` (slug: `ashoka-nagar`), `Chandan Nagar` (slug: `chandan-nagar`), `Yashwant Nagar` (slug: `yashwant-nagar`), `Perugate` (slug: `perugate`), `Shree Datta Colony` (slug: `shree-datta-colony`), `Sadashiv Peth` (slug: `sadashiv-peth`), `Dhankawadi` (slug: `dhankawadi`), `Hermes Heritage Society Phase 1` (slug: `hermes-heritage-society-phase-1`), `Shukrawar Peth` (slug: `shukrawar-peth`), `Sangamvadi` (slug: `sangamvadi`), `Vitthal Nagar` (slug: `vitthal-nagar`), `Chavan Nagar` (slug: `chavan-nagar`)

---

## 3. Owner User Provisioning
- **Total Owner Profiles:** 167
- **New Users Added (167):** All assigned roles `['owner', 'pg_owner']`, verified phone & active status.
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
