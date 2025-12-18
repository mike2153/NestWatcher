# NC Cat Automatic Folder Watching - Testing Guide

## What Was Implemented

We added automatic folder watching for NC Cat jobs. This allows NestWatch to:

1. **Watch a "Jobs Root" folder** for new NC files being dropped in
2. **Automatically move job folders** to the "Processed Jobs Root" when detected
3. **Trigger job ingestion** so the job appears in the Jobs page immediately

### New Settings Added

Two new folder path settings in **Settings > Folder Paths**:

| Setting | Purpose |
|---------|---------|
| **Jobs Root (NC Cat Input)** | Folder where NC files are dropped for automatic processing |
| **Quarantine Root** | Folder where failed jobs go (for future validation integration) |

### How the Watcher Works

1. Watches `Jobs Root` for new `.nc` files (up to 3 folders deep)
2. Waits 2 seconds for the file to stabilize (finish copying)
3. Moves the **entire parent folder** (NC + all companion files like .pts, .lpt, .bmp) to `Processed Jobs Root`
4. Triggers ingest to create the job record in the database
5. Sends app notification (`ncCat.jobMoved`)

### Files Changed

**Modified:**
- `packages/shared/src/ipc.ts` - Added jobsRoot and quarantineRoot to settings schema
- `packages/main/src/services/config.ts` - Added defaults
- `packages/renderer/src/components/settings/FolderPathsSettings.tsx` - Added UI fields
- `packages/renderer/src/pages/SettingsPage.tsx` - Updated defaults
- `packages/main/src/ipc/hypernest.ts` - Updated to use folder move instead of file write
- `packages/main/src/workers/watchersWorker.ts` - Added NC Cat Jobs Watcher

**Created:**
- `packages/main/src/services/folderMove.ts` - Folder move utility
- `packages/main/src/services/ncCatValidation.ts` - Validation service (for future use)

---

## Testing Instructions

### Step 1: Build and Run

```bash
pnpm build
pnpm dev
```

### Step 2: Configure Folder Paths

1. Go to **Settings** page
2. Scroll to **Folder Paths** section
3. Set **Jobs Root (NC Cat Input)** to a test folder (e.g., `C:\TestJobs\Input`)
4. Set **Quarantine Root** to another folder (e.g., `C:\TestJobs\Quarantine`)
5. Make sure **Processed Jobs Root** is already set
6. Click **Save Changes**

### Step 3: Create Test Job Folder

Create a test job folder structure like this:

```
C:\TestJobs\Input\
  └── TestJob001\
      ├── TestJob001.nc
      ├── TestJob001.pts (optional)
      └── TestJob001.bmp (optional)
```

You can use any existing NC file for testing.

### Step 4: Test the Watcher

1. Copy/paste the `TestJob001` folder into `Jobs Root` (`C:\TestJobs\Input\`)
2. Wait 2-3 seconds for the watcher to detect and process it
3. Check that the folder **disappeared** from `C:\TestJobs\Input\`
4. Check that the folder **appeared** in `Processed Jobs Root`
5. Check the **Jobs page** - the new job should appear

### Step 5: Verify in Logs

Check the console/logs for messages like:
- `nccat: processing new NC file`
- `nccat: job folder moved successfully`
- `nccat: triggered ingest after move`

---

## Expected Behavior

| Action | Expected Result |
|--------|-----------------|
| Drop folder in Jobs Root | Folder moves to Processed Jobs Root after ~2 seconds |
| NC file appears in Processed Jobs Root | Job appears in Jobs page |
| All companion files (.pts, .bmp, etc.) | Moved together with NC file |
| Same folder name exists in destination | Timestamped suffix added (e.g., `TestJob001_1734567890123`) |
| Jobs Root on different drive than Processed Jobs Root | Works (uses copy + delete instead of rename) |

---

## Known Limitations (Current Version)

1. **No NC Cat validation yet** - Files are moved directly without calling NC Cat for validation. Validation integration will be added later.

2. **Quarantine not used yet** - The quarantine folder is configured but the watcher currently just moves everything to processedJobsRoot.

3. **Watcher starts on app launch** - If Jobs Root is configured, the watcher starts automatically when NestWatch launches.

---

## Troubleshooting

### Folder not moving?
- Check that Jobs Root path is valid (green checkmark in settings)
- Check that Processed Jobs Root is set
- Check console for error messages
- Make sure the NC file has `.nc` extension

### Job not appearing in Jobs page?
- Check that the folder was moved to Processed Jobs Root
- Wait a few seconds for ingest polling (runs every 5 seconds)
- Check console for ingest errors

### Permission errors?
- Make sure NestWatch has write access to both folders
- Try running as administrator if on a network drive

---

## Future Enhancements (Not Yet Implemented)

- NC Cat validation before moving (errors go to quarantine)
- Validation warnings flagged in database
- Manual quarantine review UI
