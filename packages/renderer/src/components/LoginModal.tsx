import { useEffect, useMemo, useState } from 'react';
import { X, UserCircle2, ShieldCheck, RefreshCcw } from 'lucide-react';

type AuthMode = 'login' | 'register' | 'reset';

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type FormState = {
  email: string;
  password: string;
  confirmPassword: string;
  displayName: string;
};

const EMPTY_FORM: FormState = {
  email: '',
  password: '',
  confirmPassword: '',
  displayName: ''
};

export function LoginModal({ isOpen, onClose }: LoginModalProps) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<{ variant: 'info' | 'error' | 'success'; text: string } | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setMode('login');
      setForm(EMPTY_FORM);
      setSubmitting(false);
      setStatus(null);
    }
  }, [isOpen]);

  const header = useMemo(() => {
    switch (mode) {
      case 'register':
        return 'Create account';
      case 'reset':
        return 'Reset password';
      default:
        return 'Sign in';
    }
  }, [mode]);

  const cta = useMemo(() => {
    switch (mode) {
      case 'register':
        return 'Create account';
      case 'reset':
        return 'Send reset link';
      default:
        return 'Sign in';
    }
  }, [mode]);

  const hint = useMemo(() => {
    switch (mode) {
      case 'register':
        return { text: 'Already have an account?', action: 'Sign in', mode: 'login' as AuthMode };
      case 'reset':
        return { text: 'Remember your password?', action: 'Back to login', mode: 'login' as AuthMode };
      default:
        return { text: "Don't have an account?", action: 'Create one', mode: 'register' as AuthMode };
    }
  }, [mode]);

  if (!isOpen) return null;

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus(null);

    if (mode === 'register' && form.password !== form.confirmPassword) {
      setStatus({ variant: 'error', text: 'Passwords do not match.' });
      return;
    }
    if (!form.email.trim()) {
      setStatus({ variant: 'error', text: 'Email is required.' });
      return;
    }
    if (mode !== 'reset' && !form.password.trim()) {
      setStatus({ variant: 'error', text: 'Password is required.' });
      return;
    }

    setSubmitting(true);
    setTimeout(() => {
      setSubmitting(false);
      setStatus({
        variant: 'info',
        text: 'Authentication flow not wired yet – hook this up to the future auth IPC API.'
      });
    }, 400);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-[90vw] max-w-lg rounded-xl border border-border bg-background shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-primary/10 p-2 text-primary">
              {mode === 'register' ? <ShieldCheck className="h-5 w-5" /> : <UserCircle2 className="h-5 w-5" />}
            </div>
            <div>
              <p className="text-base font-semibold">{header}</p>
              <p className="text-xs text-muted-foreground">Accounts sync across every workstation.</p>
            </div>
          </div>
          <button className="rounded-md p-1 hover:bg-muted" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-6">
          {status ? (
            <div
              className={`rounded border px-3 py-2 text-sm ${
                status.variant === 'error'
                  ? 'border-destructive/50 bg-destructive/10 text-destructive'
                  : status.variant === 'success'
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600'
                    : 'border-primary/40 bg-primary/5 text-primary'
              }`}
            >
              {status.text}
            </div>
          ) : null}

          {mode === 'register' ? (
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-muted-foreground">Display name</span>
              <input
                className="w-full rounded border px-3 py-2"
                value={form.displayName}
                onChange={(e) => setForm((prev) => ({ ...prev, displayName: e.target.value }))}
                placeholder="Jane Smith"
              />
            </label>
          ) : null}

          <label className="block text-sm">
            <span className="mb-1 block font-medium text-muted-foreground">Email</span>
            <input
              type="email"
              className="w-full rounded border px-3 py-2"
              value={form.email}
              onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
              placeholder="jane@example.com"
            />
          </label>

          {mode !== 'reset' ? (
            <>
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-muted-foreground">Password</span>
                <input
                  type="password"
                  className="w-full rounded border px-3 py-2"
                  value={form.password}
                  onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
                  placeholder="••••••••"
                />
              </label>
              {mode === 'register' ? (
                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-muted-foreground">Confirm password</span>
                  <input
                    type="password"
                    className="w-full rounded border px-3 py-2"
                    value={form.confirmPassword}
                    onChange={(e) => setForm((prev) => ({ ...prev, confirmPassword: e.target.value }))}
                    placeholder="Repeat password"
                  />
                </label>
              ) : null}
            </>
          ) : null}

          {mode === 'login' ? (
            <button
              type="button"
              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
              onClick={() => setMode('reset')}
            >
              Forgot password?
            </button>
          ) : null}

          <button
            type="submit"
            disabled={submitting}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
          >
            {submitting ? <RefreshCcw className="h-4 w-4 animate-spin" /> : null}
            {cta}
          </button>

          <div className="text-center text-sm text-muted-foreground">
            {hint.text}{' '}
            <button
              type="button"
              className="font-medium text-primary underline-offset-4 hover:underline"
              onClick={() => {
                setMode(hint.mode);
                setStatus(null);
              }}
            >
              {hint.action}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
