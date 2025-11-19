# Ordering Page

## Why this page exists
- Surfaces every material whose pending jobs exceed the stock currently available in Grundner.
- Lets planners mark shortages as “ordered” and leave a short cross-shift note.
- Provides CSV/PDF exports so the snapshot can be shared outside the app.

The UI lives in `packages/renderer/src/pages/OrderingPage.tsx`. All server-side logic is implemented in `packages/main/src/repo/orderingRepo.ts` and exposed over IPC via handlers registered in `packages/main/src/ipc/ordering.ts`.

## How rows are computed
1. **Collect outstanding work.** `computeOrderingRows()` queries `public.jobs` twice: `status = 'PENDING'` for total required count and `is_locked = TRUE AND status <> 'NESTPICK_COMPLETE'` for the locked count.
2. **Normalize material keys.** Depending on `getGrundnerLookupColumn()` the key is either `type_data` or `customer_id`; blank values fall back to `__UNKNOWN__`.
3. **Join Grundner snapshot.** For every material key we fetch `id`, `type_data`, `customer_id`, `stock`, `stock_available`, and `reserved_stock` from `public.grundner`.
4. **Attach ordering state.** If a Grundner row exists we pull `ordered`, `ordered_by`, `ordered_at`, and `comments` from `public.ordering_status`.
5. **Compute shortage metrics.**
   - `required` = pending job count.
   - `lockedCount` = non-complete locked jobs.
   - `effectiveAvailable` prefers `stock_available` and falls back to `stock`.
   - `orderAmount` = `max(required - effectiveAvailable, 0)`; rows with `orderAmount <= 0` are hidden.
6. **Add the synthetic `Unknown` row** whenever there are pending jobs without a matching Grundner key.
7. **Sort** by `orderAmount` (desc) then `materialLabel`.

`listOrdering()` returns `{ items, includeReserved, generatedAt }`. `includeReserved` mirrors the settings flag so the UI can show/hide the reserved column, and `generatedAt` is displayed over the table.

## Renderer behavior
- On mount the page calls `window.api.ordering.list()` and stores the results locally. Shared IPC types are defined in `packages/shared/src/ipc.ts`.
- Search filters `materialLabel`, `materialKey`, `customerId`, and `typeData`.
- Sorting defaults to `orderAmount desc` but every column is user-sortable through TanStack Table.
- Export buttons call `window.api.ordering.exportCsv()` / `exportPdf()` which generate timestamped files through Electron’s save dialog.

### Ordered toggle
Clicking the checkbox sends `window.api.ordering.update({ id, ordered: !row.ordered })`. `updateOrderingStatus()` updates `public.ordering_status`, stamps the authenticated user’s display name, and recomputes the rows. If the row was already marked ordered by someone else the handler returns an `ORDER_LOCKED` error that the UI surfaces via `alert`.

### Comments
- Each row renders a controlled text input seeded with `row.comments`.
- Drafts are cached client-side (`materialKey → value`) so typing stays responsive.
- When the input blurs or the user presses Enter the renderer invokes `window.api.ordering.update({ id, comments })`.
- The backend trims the value, enforces the 20-character limit (`OrderingUpdateReq`), and saves it to `public.ordering_status.comments`.

## Column cheat sheet
| Column | Source | Notes |
| --- | --- | --- |
| Type Data / Customer ID | Grundner snapshot | Key depends on factory configuration. |
| Available | `effectiveAvailable` | Represents usable stock. |
| Required | Pending jobs count. |  |
| Order Amount | `max(required - effectiveAvailable, 0)` | Default sort column. |
| Reserved | `reserved_stock` (shown when `includeReserved` is true). |  |
| Locked | Locked job count. | Highlights competing work. |
| Ordered | Checkbox + actor/timestamp (`ordering_status`). |  |
| Comments | Notes saved to `ordering_status.comments`. |  |

## Example scenarios

### Shortage present
```
pending jobs (material 12045): 18
locked jobs: 4
stock_available: 5
```
`orderAmount = 18 - 5 = 13`, so the row stays visible and Locked = 4 shows that most demand is in-flight.

### Balanced stock
```
pending jobs (customer 600487): 3
stock_available: 5
```
`orderAmount = max(3 - 5, 0) = 0`, so the row is hidden because the shortage is resolved.

### Unknown material
```
pending jobs without type/customer: 2
```
The synthetic `Unknown` row appears with `effectiveAvailable = 0` and `orderAmount = 2`. Ordered/comments are disabled because there is no Grundner ID to update.

Use this document when modifying shortage calculations, tweaking the UI, or debugging why a material does or does not appear. For the IPC plumbing details, see `docs/IPC.md`.
