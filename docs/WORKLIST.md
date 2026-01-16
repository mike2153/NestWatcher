## Worklist: Staging Jobs to Ready‑To‑Run (Beginner Lesson)

When an operator chooses “Add To Worklist”, we copy a job’s files from the processed jobs root into the machine’s Ready‑To‑Run folder with the correct associated assets.

### Where the Logic Lives
- `packages/main/src/services/worklist.ts`
  - File walking and copy planning
  - NC/CSV/LPT/PTS/image resolution rules
  - Lifecycle updates + job events

### Two Modes: Alphacam vs Planit
- Alphacam: detected when a `.pts` exists for the same base as the NC
  - Copy NC and exact companions
  - Also copy all wildcard images `base*.bmp|jpg|jpeg` from the job root and subfolders
- Planit: detected when an `.lpt` exists (and no `.pts`)
  - Copy NC, per‑file CSV `base.csv`, and family CSV `prefix.csv` (first three letters)
  - Image mapping uses the family CSV only (labels → image tokens)

### CSV Copy Rules
- If `base.csv` exists, copy it (this is the parts CSV forwarded to Nestpick)
- For Planit, also copy `prefix.csv` (e.g., `RJT.csv`) alongside
  - Image mapping uses `prefix.csv` (never the per‑file CSV)

### Image Rules
- Alphacam: wildcard all images starting with `base`
- Planit: image tokens resolved via family CSV + LPT label numbers

### Overwrite Semantics
- Some files (e.g., CSV/NC/LPT/PTS/images) can be overwritten; existing destination files may be skipped if not in the overwrite list
- Planit family CSV (`prefix.csv`, e.g., `RJT.csv`) is not overwritten if it already exists in the destination folder

### Lifecycle and Events
- On success, lifecycle transitions to `STAGED` and we append a `worklist:staged` job event with details (copied/skipped counts)

### NC Cat validation at staging time
Before we copy anything to the machine, NestWatcher can validate the job again using NC Cat:

- Reason is `stage`.
- The machine ID is passed so the correct profile can be selected.
- If validation returns errors, staging is blocked and the UI shows the validation report.

This is separate from the intake validation that happens when a job first arrives in `jobsRoot`.

### Grundner order saw and locking
After staging, NestWatcher can request sheet allocation from Grundner:

- NestWatcher writes `order_saw.csv` into the Grundner folder.
- Grundner replies by writing `order_saw.erl`.
- If the reply matches the request, NestWatcher locks the job.

Important behavior:
- If the Grundner step fails, staging still succeeds. NestWatcher shows a warning dialog instead of rolling back the file copies.

For the end to end view, see `docs/JOB-FLOW.md`.

