# NC-Cat Supabase Auto-Login & Seat Validation (Design Notes)

Goal: once a machine has been activated and a subscription is valid, NestWatcher/NC-Cat should start without prompting for Supabase credentials again. We also want to verify the machine is still active, the subscription is active, and seat limits are respected before opening the UI.

## Current behavior (today)
- Login uses Supabase email/password → `can_activate_machine`/`activate_machine` RPCs claim a seat for the machine hardware hash.
- Session is cached in `nc-catalyst-auth-state` (access token, refresh token, machineId, hardwareId).
- On startup `initializeAuth` loads the cached session and calls `supabase.auth.setSession`. If that fails (e.g., stale refresh token), the user is prompted to log in.
- Heartbeat (`heartbeat_ping`) checks subscription status but does not re-validate seats/activation.
- Seats are never freed on logout (intended: keep seats allocated once activated).

## Desired behavior
- On startup, if the machine hash is known, the subscription is active, and seats are not over-allocated, auto-continue without asking for Supabase credentials.
- Refresh tokens automatically so restarts keep working.
- Block UI if subscription/machine/seat checks fail, with clear errors instead of a login prompt.

## Proposed changes
1) **Server-side RPC**: Add a new Postgres function (name suggestion: `machine_authenticate`) that takes `hardware_id` and returns `{ ok, subscription_status, machine_active, seats_ok, needs_login }`. It should:
   - Verify the machine is activated for the current subscription and not locked.
   - Verify subscription status is active or in grace.
   - Verify seat allocation is within limits for the subscription.
   - Return a machine-scoped session or a flag that the client must fall back to full Supabase login (if the hardware is unknown or the refresh token is invalid).
2) **Client startup path** (NC-Cat):
   - Early boot: call `machine_authenticate(hardwareId)` using either:
     - A stored Supabase service role function via `supabase.rpc` if the refresh token is still valid, or
     - A dedicated machine token endpoint (short-lived JWT) issued by `machine_authenticate` when the hardware is recognized.
   - If the RPC reports `ok && machine_active && seats_ok && subscription_status in (active, grace)`, reuse/refresh tokens and set `SubscriptionAuthState` without showing the sign-in UI.
   - If it fails (unknown machine, subscription locked, seats exceeded), show the existing sign-in flow with the error reason.
3) **Token persistence**:
   - Keep `persistSession: true` and update `nc-catalyst-auth-state` on every `onAuthStateChange` (already added).
   - When `machine_authenticate` refreshes/returns a session, save the new access/refresh tokens to `nc-catalyst-auth-state` immediately.
4) **Heartbeat upgrade**:
   - Extend heartbeat to call a seat-aware RPC (e.g., reuse `machine_authenticate` or add `heartbeat_with_seat_check`) that re-validates subscription + machine + seats. If it returns “locked/too many seats”, surface a banner and optionally close access until resolved.
5) **Renderer gating**:
   - Keep `SubscriptionGateLayout` but allow silent entry when the machine RPC confirms validity (no Supabase login prompt needed).

## Flow (after change)
```mermaid
flowchart LR
  NW[ NestWatcher main ] --> NC[NC-Cat hidden window]
  NC -->|machine_authenticate(hardwareId)| Supa[Supabase RPC]
  Supa -->|session + status| NC
  NC -->|stateUpdate| NW
  NW --> UI[Renderer gates open if active/grace + seats_ok]
```

## Notes on the ERR_FAILED load error
- Error: `Failed to load NC Catalyst - ERR_FAILED (-2) loading 'file:///D:/GitHub/electron_port/NestWatcher/resources/NC_CAT_V3/nc-catalyst/dist/index.html'`.
- Likely causes: the NC-Cat build is missing in `resources/NC_CAT_V3/nc-catalyst/dist`, or the path is wrong during dev. In dev, ensure `NC_CATALYST_DEV_URL`/`NC_CATALYST_ENTRY`/`NC_CATALYST_DEV_DIR` are set, or rebuild NC-Cat (`pnpm --filter nc-catalyst build`) so the file exists.
