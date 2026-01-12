// Subscription authentication types shared between NC-Cat and NestWatcher
// NC-Cat handles all Supabase communication; NestWatcher queries NC-Cat for auth state

// ---------------------------------------------------------------------------------
// Subscription Status
// ---------------------------------------------------------------------------------

export type SubscriptionStatus = 'active' | 'grace_period' | 'locked' | 'none';

// ---------------------------------------------------------------------------------
// Auth State (NC-Cat → NestWatcher)
// ---------------------------------------------------------------------------------

/**
 * Current subscription authentication state.
 * NC-Cat maintains this state and exposes it to NestWatcher via IPC.
 */
export interface SubscriptionAuthState {
  /** Whether the user is authenticated with Supabase */
  authenticated: boolean;
  /** Supabase user ID */
  userId?: string;
  /** User's email */
  email?: string;
  /** Display name from Supabase user metadata (e.g., full_name) */
  displayName?: string;
  /** Whether user is an admin (kyle@ or michael@woodtron.com.au) */
  isAdmin: boolean;
  /** Machine ID from Supabase machines table (UUID) */
  machineId?: string;
  /** Hardware ID hash (CPU + Motherboard) */
  hardwareId: string;
  /** Current subscription status */
  subscriptionStatus: SubscriptionStatus;
  /** ISO timestamp when grace period ends (if in grace_period) */
  graceEndsAt?: string;
  /** ISO timestamp of last successful Supabase ping */
  lastSuccessfulPing?: string;
  /** Error message if authentication failed */
  error?: string;
}

// ---------------------------------------------------------------------------------
// Auth Requests (NestWatcher → NC-Cat)
// ---------------------------------------------------------------------------------

/**
 * Request to log in with email/password
 */
export interface SubscriptionLoginReq {
  email: string;
  password: string;
}

/**
 * Response from login attempt
 */
export interface SubscriptionLoginRes {
  success: boolean;
  state?: SubscriptionAuthState;
  error?: string;
  /** True if this is a new machine that needs a seat */
  needsActivation?: boolean;
  /** True if user has no active subscription */
  needsSubscription?: boolean;
}

/**
 * Request to sign up a new account
 */
export interface SubscriptionSignupReq {
  email: string;
  password: string;
}

/**
 * Response from signup attempt
 */
export interface SubscriptionSignupRes {
  success: boolean;
  /** True if email confirmation is required */
  needsConfirmation?: boolean;
  error?: string;
}

/**
 * Response from logout
 */
export interface SubscriptionLogoutRes {
  success: boolean;
}

// ---------------------------------------------------------------------------------
// Machine Management
// ---------------------------------------------------------------------------------

/**
 * A machine registered to the user's subscription
 */
export interface SubscriptionMachine {
  id: string;
  hardwareId: string;
  machineName?: string;
  isActive: boolean;
  lastSeenAt: string;
  activatedAt: string;
  deactivatedAt?: string;
  osInfo?: string;
  appVersion?: string;
}

/**
 * Request to deactivate a machine
 */
export interface DeactivateMachineReq {
  machineId: string;
}

/**
 * Response from machine deactivation
 */
export interface DeactivateMachineRes {
  success: boolean;
  /** ISO timestamp when the seat cooldown ends */
  cooldownEndsAt?: string;
  error?: string;
}

/**
 * Response from listing user's machines
 */
export interface ListMachinesRes {
  machines: SubscriptionMachine[];
  totalSeats: number;
  usedSeats: number;
}

// ---------------------------------------------------------------------------------
// Subscription Info
// ---------------------------------------------------------------------------------

/**
 * Detailed subscription information for display in settings
 */
export interface SubscriptionInfo {
  status: SubscriptionStatus;
  /** Base seats included with subscription */
  baseSeats: number;
  /** Extra seats purchased */
  extraSeats: number;
  /** Total available seats */
  totalSeats: number;
  /** Currently used seats */
  usedSeats: number;
  /** ISO timestamp when current period ends */
  currentPeriodEnd?: string;
  /** ISO timestamp when subscription will cancel (if scheduled) */
  cancelAt?: string;
  /** ISO timestamp when payment failed (if past_due) */
  paymentFailedAt?: string;
  /** ISO timestamp when grace period ends (if in grace) */
  graceEndsAt?: string;
}

/**
 * Response from getting subscription info
 */
export interface GetSubscriptionInfoRes {
  subscription?: SubscriptionInfo;
  isAdmin: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------------
// Stripe URLs
// ---------------------------------------------------------------------------------

/**
 * Response with Stripe Checkout URL
 */
export interface GetCheckoutUrlRes {
  url?: string;
  error?: string;
}

/**
 * Response with Stripe Customer Portal URL
 */
export interface GetBillingPortalUrlRes {
  url?: string;
  error?: string;
}

// ---------------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------------

/**
 * Response from heartbeat ping
 */
export interface HeartbeatRes {
  ok: boolean;
  status?: SubscriptionStatus;
  lastSeenAt?: string;
  graceEndsAt?: string;
  /** Action the client should take */
  action?: 'none' | 'logout' | 'reactivate' | 'renew_subscription' | 'update_payment';
  error?: string;
}

// ---------------------------------------------------------------------------------
// Local Auth State (persisted by NC-Cat)
// ---------------------------------------------------------------------------------

/**
 * Auth state stored locally by NC-Cat.
 * Used to persist sessions across app restarts.
 */
export interface LocalAuthState {
  /** Supabase access token (JWT) */
  accessToken: string;
  /** Supabase refresh token */
  refreshToken: string;
  /** Token expiry timestamp (Unix ms) */
  expiresAt: number;
  /** Supabase user ID */
  userId: string;
  /** User's email */
  email: string;
  /** Whether user is admin */
  isAdmin: boolean;
  /** Machine ID from Supabase (UUID) */
  machineId: string;
  /** Hardware ID hash */
  hardwareId: string;
  /** ISO timestamp of last successful ping */
  lastSuccessfulPing: string;
  /** Current subscription status */
  subscriptionStatus: SubscriptionStatus;
  /** ISO timestamp when grace period ends */
  graceEndsAt?: string;
}

// ---------------------------------------------------------------------------------
// IPC Channel Names
// ---------------------------------------------------------------------------------

export const SUBSCRIPTION_AUTH_CHANNELS = {
  // Auth operations
  GET_STATE: 'nc-catalyst:auth:getState',
  LOGIN: 'nc-catalyst:auth:login',
  SIGNUP: 'nc-catalyst:auth:signup',
  LOGOUT: 'nc-catalyst:auth:logout',

  // State change events (NC-Cat → NestWatcher)
  ON_STATE_CHANGE: 'nc-catalyst:auth:onStateChange',

  // Machine management
  LIST_MACHINES: 'nc-catalyst:auth:listMachines',
  DEACTIVATE_MACHINE: 'nc-catalyst:auth:deactivateMachine',

  // Subscription info
  GET_SUBSCRIPTION_INFO: 'nc-catalyst:auth:getSubscriptionInfo',
  GET_CHECKOUT_URL: 'nc-catalyst:auth:getCheckoutUrl',
  GET_BILLING_PORTAL_URL: 'nc-catalyst:auth:getBillingPortalUrl',

  // Heartbeat
  HEARTBEAT: 'nc-catalyst:auth:heartbeat',

  // Hardware ID (NestWatcher provides this to NC-Cat)
  GET_HARDWARE_ID: 'nc-catalyst:auth:getHardwareId',
} as const;
