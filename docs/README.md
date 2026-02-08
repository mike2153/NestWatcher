# NestWatcher Documentation Map

Use this page as the single entry point. Each link below is the **current, maintained** source for that topic.

- `docs/DEVELOPER_GUIDE.md` — how the app is put together (Main/Preload/Renderer), IPC patterns, database map, auth, and dev commands.
- `docs/OPERATIONS_GUIDE.md` — day-to-day file flow: intake, staging, AutoPAC, Nestpick, Grundner, folder paths, and operator tasks.
- `docs/MES_AND_DATA.md` — how `validation.json` is ingested, what lands in `public.nc_stats`, and the key MES fields we store.
- `docs/JOB-FLOW.md` — lifecycle steps for jobs.
- `docs/STYLING.md` — UI theming and Tailwind notes (kept as-is).
- NC-Catalyst references (left unchanged): `docs/NC-CATALYST-INTEGRATION.md`, `docs/NC-CAT-SUPABASE-AUTO-LOGIN.md`, and `docs/Grundner Gateway NESTPICK communication V 3_6.pdf`.
- Database snapshot: `docs/schema.sql` (full local Postgres schema); migrations live in `docs/migrations/`.
- Charts: mermaid source files remain under `docs/charts/` for reuse when updating diagrams.

All other prior docs have been consolidated into the three guides above to reduce duplication and outdated guidance.
