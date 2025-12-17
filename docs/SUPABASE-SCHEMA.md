# Supabase Database Schema for NC-Catalyst Licensing

> **Purpose**: Authentication, subscription management, and per-machine licensing for NC-Catalyst.
> This schema is deployed to Supabase (cloud), not the local NestWatcher PostgreSQL.

---

## Quick Start Setup Guide

### Step 1: Create Supabase Project

1. Go to https://supabase.com and create an account
2. Click "New project" and fill in:
   - Project name: `nc-catalyst`
   - Database password: (save this securely)
   - Region: Choose closest to your users
3. Wait for project to provision (~2 minutes)

### Step 2: Run Database Schema

1. In Supabase dashboard, go to **SQL Editor**
2. Click "New query"
3. Copy ALL the SQL from this file (sections: Tables, Functions, Triggers)
4. Run in this order:
   - First: All `CREATE TABLE` statements
   - Then: All `CREATE FUNCTION` statements
   - Finally: All `CREATE TRIGGER` statements
5. Verify: Check **Table Editor** shows: `profiles`, `subscriptions`, `machines`, `seat_cooldowns`

### Step 3: Get API Keys

1. Go to **Settings → API**
2. Copy these values:
   - `Project URL` → This is `SUPABASE_URL`
   - `anon public` key → This is `SUPABASE_ANON_KEY`

### Step 4: Add to NC-Cat

Create `.env` file in `resources/NC_CAT_V3/nc-catalyst/`:

```env
VITE_SUPABASE_URL=https://your-project-id.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Step 5: Set Up Stripe (Required for Payments)

1. Create Stripe account at https://stripe.com
2. In Stripe Dashboard, create two products:

   **Product 1: NC-Catalyst Base**
   - Name: "NC-Catalyst Base Subscription"
   - Price: $99.00 USD / month (recurring)
   - Metadata: `type` = `base`, `seats` = `1`

   **Product 2: Additional Machine Seat**
   - Name: "Additional Machine Seat"
   - Price: $29.00 USD / month (recurring)
   - Metadata: `type` = `seat`

3. Enable Customer Portal:
   - Go to **Settings → Billing → Customer portal**
   - Enable "Allow customers to update payment methods"
   - Enable "Allow customers to cancel subscriptions"

4. Note down from **Developers → API keys**:
   - Secret key → `STRIPE_SECRET_KEY`
   - After webhook setup: `STRIPE_WEBHOOK_SECRET`

### Step 6: Deploy Edge Functions (Optional - Do Later)

Edge functions handle Stripe webhooks. Deploy when ready for production:

```bash
cd supabase/functions
supabase functions deploy stripe-webhook
supabase functions deploy create-checkout-session
supabase functions deploy create-portal-session
```

---

## Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SUPABASE CLOUD                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐     ┌──────────────────┐     ┌───────────────────────┐   │
│  │    users     │────<│  subscriptions   │────<│       machines        │   │
│  │ (Supabase    │     │                  │     │                       │   │
│  │  Auth)       │     │ stripe_sub_id    │     │ hardware_id (hash)    │   │
│  │              │     │ status           │     │ last_seen_at          │   │
│  │ is_admin     │     │ base_seats: 1    │     │ is_active             │   │
│  └──────────────┘     │ extra_seats      │     │ deactivated_at        │   │
│                       └──────────────────┘     └───────────────────────┘   │
│                                                                              │
│  Admin accounts (kyle@, michael@woodtron.com.au):                           │
│    - is_admin = true                                                         │
│    - No subscription required                                                │
│    - Unlimited machines                                                      │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Tables

### 1. `profiles` (extends Supabase auth.users)

Stores additional user metadata. Linked 1:1 with `auth.users`.

```sql
CREATE TABLE public.profiles (
  id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email         text NOT NULL,
  display_name  text,
  is_admin      boolean DEFAULT false NOT NULL,
  created_at    timestamptz DEFAULT now() NOT NULL,
  updated_at    timestamptz DEFAULT now() NOT NULL
);

-- Admin accounts bypass all subscription checks
-- Hardcoded: kyle@woodtron.com.au, michael@woodtron.com.au

COMMENT ON TABLE public.profiles IS
  'Extended user profiles linked to Supabase auth.users';

COMMENT ON COLUMN public.profiles.is_admin IS
  'Admin users have unlimited machines and no payment required';

-- RLS: Users can only read/update their own profile
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id);
```

### 2. `subscriptions`

Tracks Stripe subscription status per user.

```sql
CREATE TABLE public.subscriptions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

  -- Stripe fields
  stripe_customer_id  text UNIQUE,
  stripe_subscription_id text UNIQUE,
  stripe_price_id     text,                    -- Current price ID

  -- Subscription status
  status              text NOT NULL DEFAULT 'inactive',
    -- 'active', 'past_due', 'canceled', 'incomplete', 'trialing', 'inactive'

  -- Seat management
  base_seats          integer DEFAULT 1 NOT NULL,  -- Included with base ($99/mo)
  extra_seats         integer DEFAULT 0 NOT NULL,  -- Additional seats ($29/mo each)

  -- Billing cycle
  current_period_start timestamptz,
  current_period_end   timestamptz,
  cancel_at            timestamptz,            -- Scheduled cancellation date
  canceled_at          timestamptz,            -- When user canceled

  -- Grace period tracking
  payment_failed_at    timestamptz,            -- When payment first failed
  grace_period_ends_at timestamptz,            -- 7 days after payment_failed_at

  created_at          timestamptz DEFAULT now() NOT NULL,
  updated_at          timestamptz DEFAULT now() NOT NULL,

  CONSTRAINT positive_seats CHECK (base_seats >= 0 AND extra_seats >= 0)
);

CREATE INDEX subscriptions_user_id_idx ON public.subscriptions(user_id);
CREATE INDEX subscriptions_stripe_customer_idx ON public.subscriptions(stripe_customer_id);
CREATE INDEX subscriptions_status_idx ON public.subscriptions(status);

COMMENT ON TABLE public.subscriptions IS
  'Stripe subscription tracking - one active subscription per user';

COMMENT ON COLUMN public.subscriptions.base_seats IS
  'Seats included with base subscription ($99/mo includes 1 seat)';

COMMENT ON COLUMN public.subscriptions.extra_seats IS
  'Additional seats purchased ($29/mo each)';

-- RLS
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own subscription"
  ON public.subscriptions FOR SELECT
  USING (auth.uid() = user_id);

-- Only service role can insert/update (via webhooks)
```

### 3. `machines`

Tracks individual machine activations per subscription.

```sql
CREATE TABLE public.machines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

  -- Machine identification
  hardware_id     text NOT NULL,               -- Hash of CPU ID + Motherboard serial
  machine_name    text,                        -- User-friendly name (e.g., "Workshop PC")

  -- Activation status
  is_active       boolean DEFAULT true NOT NULL,
  activated_at    timestamptz DEFAULT now() NOT NULL,
  deactivated_at  timestamptz,                 -- When user deactivated

  -- Heartbeat tracking
  last_seen_at    timestamptz DEFAULT now() NOT NULL,

  -- Metadata
  os_info         text,                        -- e.g., "Windows 11 Pro"
  app_version     text,                        -- NC-Cat version at last ping

  created_at      timestamptz DEFAULT now() NOT NULL,
  updated_at      timestamptz DEFAULT now() NOT NULL,

  -- Prevent duplicate hardware on same subscription
  CONSTRAINT unique_hardware_per_subscription
    UNIQUE (subscription_id, hardware_id)
);

CREATE INDEX machines_user_id_idx ON public.machines(user_id);
CREATE INDEX machines_subscription_id_idx ON public.machines(subscription_id);
CREATE INDEX machines_hardware_id_idx ON public.machines(hardware_id);
CREATE INDEX machines_last_seen_idx ON public.machines(last_seen_at);
CREATE INDEX machines_active_idx ON public.machines(is_active) WHERE is_active = true;

COMMENT ON TABLE public.machines IS
  'Individual machine activations - one row per hardware ID';

COMMENT ON COLUMN public.machines.hardware_id IS
  'SHA-256 hash of CPU ID + Motherboard serial number';

COMMENT ON COLUMN public.machines.last_seen_at IS
  'Updated every hour by NC-Cat heartbeat ping';

COMMENT ON COLUMN public.machines.subscription_id IS
  'NULL for admin users (unlimited machines, no subscription)';

-- RLS
ALTER TABLE public.machines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own machines"
  ON public.machines FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update own machines"
  ON public.machines FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can deactivate own machines"
  ON public.machines FOR DELETE
  USING (auth.uid() = user_id);
```

### 4. `seat_cooldowns`

Prevents seat abuse by tracking recent deactivations.

```sql
CREATE TABLE public.seat_cooldowns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  hardware_id     text NOT NULL,               -- The deactivated machine's hardware ID
  deactivated_at  timestamptz DEFAULT now() NOT NULL,
  cooldown_ends_at timestamptz NOT NULL,       -- 1 hour after deactivation

  created_at      timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX seat_cooldowns_subscription_idx ON public.seat_cooldowns(subscription_id);
CREATE INDEX seat_cooldowns_ends_at_idx ON public.seat_cooldowns(cooldown_ends_at);

COMMENT ON TABLE public.seat_cooldowns IS
  'Tracks 1-hour cooldown after machine deactivation before seat can be reused';

-- Auto-cleanup old cooldowns (run via cron)
-- DELETE FROM public.seat_cooldowns WHERE cooldown_ends_at < now();
```

---

## Functions

### Check if user can activate a machine

```sql
CREATE OR REPLACE FUNCTION public.can_activate_machine(
  p_user_id uuid,
  p_hardware_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_profile public.profiles;
  v_subscription public.subscriptions;
  v_active_machines integer;
  v_total_seats integer;
  v_existing_machine public.machines;
  v_cooldown public.seat_cooldowns;
BEGIN
  -- Get user profile
  SELECT * INTO v_profile FROM public.profiles WHERE id = p_user_id;

  IF v_profile IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'User not found');
  END IF;

  -- Admin users can always activate
  IF v_profile.is_admin THEN
    RETURN jsonb_build_object('allowed', true, 'reason', 'Admin user');
  END IF;

  -- Check for existing machine with same hardware (reactivation)
  SELECT * INTO v_existing_machine
  FROM public.machines
  WHERE user_id = p_user_id AND hardware_id = p_hardware_id;

  IF v_existing_machine IS NOT NULL THEN
    IF v_existing_machine.is_active THEN
      RETURN jsonb_build_object('allowed', true, 'reason', 'Machine already active', 'machine_id', v_existing_machine.id);
    ELSE
      -- Reactivating a deactivated machine
      RETURN jsonb_build_object('allowed', true, 'reason', 'Reactivating existing machine', 'machine_id', v_existing_machine.id);
    END IF;
  END IF;

  -- Get active subscription
  SELECT * INTO v_subscription
  FROM public.subscriptions
  WHERE user_id = p_user_id AND status IN ('active', 'past_due')
  LIMIT 1;

  IF v_subscription IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'No active subscription', 'needs_subscription', true);
  END IF;

  -- Check grace period
  IF v_subscription.status = 'past_due' AND v_subscription.grace_period_ends_at < now() THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'Payment overdue - grace period expired');
  END IF;

  -- Count active machines
  SELECT COUNT(*) INTO v_active_machines
  FROM public.machines
  WHERE subscription_id = v_subscription.id AND is_active = true;

  -- Calculate total seats
  v_total_seats := v_subscription.base_seats + v_subscription.extra_seats;

  IF v_active_machines >= v_total_seats THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'No available seats',
      'active_machines', v_active_machines,
      'total_seats', v_total_seats,
      'needs_seat', true
    );
  END IF;

  -- Check for cooldown on this hardware
  SELECT * INTO v_cooldown
  FROM public.seat_cooldowns
  WHERE subscription_id = v_subscription.id
    AND hardware_id = p_hardware_id
    AND cooldown_ends_at > now();

  IF v_cooldown IS NOT NULL THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'Seat cooldown active',
      'cooldown_ends_at', v_cooldown.cooldown_ends_at
    );
  END IF;

  RETURN jsonb_build_object('allowed', true, 'subscription_id', v_subscription.id);
END;
$$;
```

### Activate a machine

```sql
CREATE OR REPLACE FUNCTION public.activate_machine(
  p_user_id uuid,
  p_hardware_id text,
  p_machine_name text DEFAULT NULL,
  p_os_info text DEFAULT NULL,
  p_app_version text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_check jsonb;
  v_profile public.profiles;
  v_subscription_id uuid;
  v_machine public.machines;
BEGIN
  -- First check if activation is allowed
  v_check := public.can_activate_machine(p_user_id, p_hardware_id);

  IF NOT (v_check->>'allowed')::boolean THEN
    RETURN v_check;
  END IF;

  -- Get profile for admin check
  SELECT * INTO v_profile FROM public.profiles WHERE id = p_user_id;

  -- Get subscription ID (NULL for admins)
  IF v_profile.is_admin THEN
    v_subscription_id := NULL;
  ELSE
    v_subscription_id := (v_check->>'subscription_id')::uuid;
  END IF;

  -- Check if reactivating existing machine
  IF v_check->>'machine_id' IS NOT NULL THEN
    UPDATE public.machines
    SET
      is_active = true,
      deactivated_at = NULL,
      last_seen_at = now(),
      machine_name = COALESCE(p_machine_name, machine_name),
      os_info = COALESCE(p_os_info, os_info),
      app_version = COALESCE(p_app_version, app_version),
      updated_at = now()
    WHERE id = (v_check->>'machine_id')::uuid
    RETURNING * INTO v_machine;
  ELSE
    -- Create new machine
    INSERT INTO public.machines (
      subscription_id, user_id, hardware_id, machine_name,
      os_info, app_version, is_active, activated_at, last_seen_at
    )
    VALUES (
      v_subscription_id, p_user_id, p_hardware_id, p_machine_name,
      p_os_info, p_app_version, true, now(), now()
    )
    RETURNING * INTO v_machine;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'machine_id', v_machine.id,
    'hardware_id', v_machine.hardware_id
  );
END;
$$;
```

### Heartbeat ping (called every hour)

```sql
CREATE OR REPLACE FUNCTION public.heartbeat_ping(
  p_user_id uuid,
  p_hardware_id text,
  p_app_version text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_profile public.profiles;
  v_machine public.machines;
  v_subscription public.subscriptions;
BEGIN
  -- Get profile
  SELECT * INTO v_profile FROM public.profiles WHERE id = p_user_id;

  IF v_profile IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'User not found', 'action', 'logout');
  END IF;

  -- Get machine
  SELECT * INTO v_machine
  FROM public.machines
  WHERE user_id = p_user_id AND hardware_id = p_hardware_id AND is_active = true;

  IF v_machine IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'Machine not activated', 'action', 'reactivate');
  END IF;

  -- Update last_seen
  UPDATE public.machines
  SET
    last_seen_at = now(),
    app_version = COALESCE(p_app_version, app_version),
    updated_at = now()
  WHERE id = v_machine.id;

  -- Admin users always OK
  IF v_profile.is_admin THEN
    RETURN jsonb_build_object(
      'ok', true,
      'is_admin', true,
      'last_seen_at', now()
    );
  END IF;

  -- Check subscription status
  SELECT * INTO v_subscription
  FROM public.subscriptions
  WHERE id = v_machine.subscription_id;

  IF v_subscription IS NULL OR v_subscription.status NOT IN ('active', 'past_due') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'Subscription inactive',
      'action', 'renew_subscription'
    );
  END IF;

  -- Check grace period for past_due
  IF v_subscription.status = 'past_due' THEN
    IF v_subscription.grace_period_ends_at < now() THEN
      RETURN jsonb_build_object(
        'ok', false,
        'reason', 'Grace period expired',
        'action', 'update_payment'
      );
    ELSE
      RETURN jsonb_build_object(
        'ok', true,
        'status', 'grace_period',
        'grace_ends_at', v_subscription.grace_period_ends_at,
        'last_seen_at', now()
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'status', 'active',
    'last_seen_at', now(),
    'subscription_ends_at', v_subscription.current_period_end
  );
END;
$$;
```

### Deactivate a machine

```sql
CREATE OR REPLACE FUNCTION public.deactivate_machine(
  p_user_id uuid,
  p_machine_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_machine public.machines;
BEGIN
  -- Get and verify ownership
  SELECT * INTO v_machine
  FROM public.machines
  WHERE id = p_machine_id AND user_id = p_user_id;

  IF v_machine IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'Machine not found');
  END IF;

  IF NOT v_machine.is_active THEN
    RETURN jsonb_build_object('success', false, 'reason', 'Machine already deactivated');
  END IF;

  -- Deactivate machine
  UPDATE public.machines
  SET
    is_active = false,
    deactivated_at = now(),
    updated_at = now()
  WHERE id = p_machine_id;

  -- Create cooldown record (1 hour)
  IF v_machine.subscription_id IS NOT NULL THEN
    INSERT INTO public.seat_cooldowns (subscription_id, hardware_id, cooldown_ends_at)
    VALUES (v_machine.subscription_id, v_machine.hardware_id, now() + interval '1 hour');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'cooldown_ends_at', now() + interval '1 hour'
  );
END;
$$;
```

---

## Triggers

### Auto-create profile on signup

```sql
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_is_admin boolean := false;
BEGIN
  -- Check if admin email
  IF NEW.email IN ('kyle@woodtron.com.au', 'michael@woodtron.com.au') THEN
    v_is_admin := true;
  END IF;

  INSERT INTO public.profiles (id, email, is_admin)
  VALUES (NEW.id, NEW.email, v_is_admin);

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
```

### Updated_at trigger

```sql
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER set_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_subscriptions_updated_at
  BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_machines_updated_at
  BEFORE UPDATE ON public.machines
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
```

---

## Stripe Integration

### Products & Prices (to create in Stripe Dashboard)

```
Product 1: NC-Catalyst Base Subscription
  - Price: $99/month (recurring)
  - Metadata: { "type": "base", "seats": "1" }

Product 2: NC-Catalyst Additional Machine Seat
  - Price: $29/month (recurring)
  - Metadata: { "type": "seat" }
```

### Webhook Events to Handle

| Event | Action |
|-------|--------|
| `customer.subscription.created` | Create/update subscription record |
| `customer.subscription.updated` | Update status, seats, period dates |
| `customer.subscription.deleted` | Set status to 'canceled' |
| `invoice.payment_succeeded` | Clear payment_failed_at, update period |
| `invoice.payment_failed` | Set payment_failed_at, grace_period_ends_at |

### Stripe Webhook Handler (Edge Function)

```typescript
// supabase/functions/stripe-webhook/index.ts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import Stripe from 'https://esm.sh/stripe@12.0.0'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2023-10-16' })
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

serve(async (req) => {
  const signature = req.headers.get('stripe-signature')!
  const body = await req.text()

  const event = stripe.webhooks.constructEvent(
    body,
    signature,
    Deno.env.get('STRIPE_WEBHOOK_SECRET')!
  )

  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const subscription = event.data.object as Stripe.Subscription
      const customerId = subscription.customer as string

      // Find user by stripe_customer_id
      const { data: existingSub } = await supabase
        .from('subscriptions')
        .select('id, user_id')
        .eq('stripe_customer_id', customerId)
        .single()

      // Count extra seats from subscription items
      let extraSeats = 0
      for (const item of subscription.items.data) {
        if (item.price.metadata?.type === 'seat') {
          extraSeats += item.quantity || 0
        }
      }

      const subData = {
        stripe_subscription_id: subscription.id,
        stripe_price_id: subscription.items.data[0]?.price.id,
        status: subscription.status,
        extra_seats: extraSeats,
        current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
        current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
        cancel_at: subscription.cancel_at ? new Date(subscription.cancel_at * 1000).toISOString() : null,
        canceled_at: subscription.canceled_at ? new Date(subscription.canceled_at * 1000).toISOString() : null,
      }

      if (existingSub) {
        await supabase
          .from('subscriptions')
          .update(subData)
          .eq('id', existingSub.id)
      }
      break
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice
      const subscriptionId = invoice.subscription as string

      await supabase
        .from('subscriptions')
        .update({
          payment_failed_at: new Date().toISOString(),
          grace_period_ends_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .eq('stripe_subscription_id', subscriptionId)
      break
    }

    case 'invoice.payment_succeeded': {
      const invoice = event.data.object as Stripe.Invoice
      const subscriptionId = invoice.subscription as string

      await supabase
        .from('subscriptions')
        .update({
          payment_failed_at: null,
          grace_period_ends_at: null,
        })
        .eq('stripe_subscription_id', subscriptionId)
      break
    }
  }

  return new Response(JSON.stringify({ received: true }), { status: 200 })
})
```

---

## Local Storage (NC-Cat / NestWatcher)

NC-Cat stores locally (electron-store or localStorage):

```typescript
interface LocalAuthState {
  // Supabase session
  accessToken: string;
  refreshToken: string;
  expiresAt: number;           // Unix timestamp

  // User info
  userId: string;
  email: string;
  isAdmin: boolean;

  // Machine info
  machineId: string;           // UUID from Supabase machines table
  hardwareId: string;          // Hash of CPU + Motherboard

  // License state
  lastSuccessfulPing: string;  // ISO timestamp
  subscriptionStatus: 'active' | 'grace_period' | 'locked';
  graceEndsAt?: string;        // ISO timestamp if in grace period
}
```

---

## API Endpoints (Edge Functions)

| Function | Method | Purpose |
|----------|--------|---------|
| `/auth/signup` | POST | Create account (uses Supabase Auth) |
| `/auth/login` | POST | Login (uses Supabase Auth) |
| `/machines/activate` | POST | Activate machine on first login |
| `/machines/heartbeat` | POST | Hourly ping to update last_seen |
| `/machines/deactivate` | POST | User deactivates their machine |
| `/machines/list` | GET | List user's machines |
| `/subscription/status` | GET | Get current subscription status |
| `/subscription/portal` | POST | Generate Stripe Customer Portal link |
| `/subscription/checkout` | POST | Generate Stripe Checkout link |

---

## Security Considerations

1. **Hardware ID cannot be trusted alone** - Users could spoof it. The combination of:
   - Supabase auth (email/password)
   - Hardware ID hash
   - Regular heartbeat pings
   Makes it impractical to share licenses.

2. **RLS enforces user isolation** - Users can only see/modify their own data.

3. **Service role only for webhooks** - Stripe webhooks use service role to bypass RLS.

4. **No sensitive data in local storage** - Hardware ID hash is not reversible.
