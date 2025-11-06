# Auto Pre-Reserve Implementation

**Date:** 2025-11-06
**Summary:** Changed job reservation logic so all PENDING jobs are automatically pre-reserved when created

---

## Changes Made

### 1. Database Constraint
**File:** [migrations/2025-11-06_add_mutual_exclusivity_constraint.sql](../migrations/2025-11-06_add_mutual_exclusivity_constraint.sql)

Added a CHECK constraint to enforce mutual exclusivity:
- A job cannot be both `pre_reserved = true` AND `is_locked = true` simultaneously
- When jobs are locked, `pre_reserved` must be cleared
- Migration also updates any existing rows that violate this constraint

**To apply:**
```sql
psql -U postgres -d your_database -f migrations/2025-11-06_add_mutual_exclusivity_constraint.sql
```

---

### 2. Auto Pre-Reserve on Job Creation
**File:** [packages/main/src/services/ingest.ts:154](../packages/main/src/services/ingest.ts#L154)

**Changed:** INSERT query now sets `pre_reserved = true` by default for all new jobs

**Before:**
```sql
INSERT INTO public.jobs(key, folder, ncfile, material, parts, size, thickness, dateadded, updated_at)
VALUES($1,$2,$3,$4,$5,$6,$7, now(), now())
```

**After:**
```sql
INSERT INTO public.jobs(key, folder, ncfile, material, parts, size, thickness, dateadded, updated_at, pre_reserved)
VALUES($1,$2,$3,$4,$5,$6,$7, now(), now(), true)
```

**Added:** Sync Grundner `pre_reserved` counts after new jobs are inserted (lines 201-223)

---

### 3. Clear Pre-Reserved When Locking
**Files:**
- [packages/main/src/repo/jobsRepo.ts:324](../packages/main/src/repo/jobsRepo.ts#L324) - `lockJob()`
- [packages/main/src/repo/jobsRepo.ts:354](../packages/main/src/repo/jobsRepo.ts#L354) - `lockJobAfterGrundnerConfirmation()`

**Changed:** Both lock functions now:
1. Set `pre_reserved = false` when setting `is_locked = true`
2. Sync Grundner `pre_reserved` counts after clearing the flag
3. Return `material` in the query result to enable the sync

**Why:** Ensures mutual exclusivity and keeps Grundner inventory counts accurate

---

### 4. Ordering Page Calculation Update
**File:** [packages/main/src/repo/orderingRepo.ts:57](../packages/main/src/repo/orderingRepo.ts#L57)

**Changed:** Ordering calculation now uses the formula:
```
shortage = (prereserved + locked) - stock
```

**Before:**
- Queried only PENDING jobs
- Calculated: `orderAmount = required - (stock - locked)`

**After:**
- Queries both pre-reserved AND locked jobs separately
- Combines counts: `totalRequired = prereservedCount + lockedCount`
- Calculates: `orderAmount = totalRequired - stock`
- Only shows materials where `orderAmount > 0`

**Impact:**
- Ordering page now shows exactly what needs to be ordered to fulfill all pending and locked jobs
- Negative stock availability is implicitly shown via positive order amounts

---

### 5. UI Changes - Remove Pre-Reserved Column from JobsPage
**File:** [packages/renderer/src/pages/JobsPage.tsx:78](../packages/renderer/src/pages/JobsPage.tsx#L78)

**Changed:** Removed the "Pre-Reserved" column from JobsPage only
- Removed column width configuration
- Removed column definition
- Removed Pre-Reserve/Unreserve context menu items
- Removed unused `performReserve()` function and related state variables

**Note:** Pre-Reserved column is **kept** in GrundnerPage as it shows the count of pre-reserved jobs per material type, which is useful for inventory tracking.

**Why:** Since all PENDING jobs are now automatically pre-reserved, showing this in the Jobs table provides no value to users (it would always show "Yes" for pending jobs). However, the count in Grundner is still useful.

---

## Behavior Changes

### Before This Change
1. Jobs entered database with `pre_reserved = false`
2. Users manually pre-reserved jobs in the UI
3. Ordering page calculated based on PENDING jobs only
4. Jobs could be both pre-reserved AND locked (undefined behavior)

### After This Change
1. ✅ Jobs are automatically `pre_reserved = true` when created
2. ✅ Pre-reservation is automatic and transparent
3. ✅ Ordering page calculates based on `(prereserved + locked) - stock`
4. ✅ Jobs cannot be both pre-reserved and locked (enforced by constraint)
5. ✅ When jobs are locked, `pre_reserved` is automatically cleared
6. ✅ Grundner `pre_reserved` counts stay synchronized

---

## Testing Checklist

- [ ] Apply database migration
- [ ] Restart the application
- [ ] Create new NC files and verify they appear as pre-reserved in jobs table
- [ ] Check Grundner table `pre_reserved` column increments correctly
- [ ] Lock a job and verify `pre_reserved` is cleared
- [ ] Check Grundner table `pre_reserved` column decrements correctly
- [ ] Verify ordering page shows correct shortage amounts
- [ ] Verify constraint prevents manually setting both flags to true

---

## Migration Notes

**Existing Data:**
- Existing jobs with `pre_reserved = false` will remain unchanged
- Only NEW jobs will be auto-reserved
- If you want to bulk-update existing PENDING jobs:

```sql
UPDATE public.jobs
SET pre_reserved = true
WHERE status = 'PENDING' AND pre_reserved = false;
```

Then run the Grundner sync:
```sql
-- This would need to be done via the app's resyncGrundnerPreReservedForMaterial function
-- for each material, or manually in SQL
```
