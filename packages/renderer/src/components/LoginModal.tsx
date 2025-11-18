import { useEffect, useMemo, useState } from 'react';
import { X, UserCircle2, ShieldCheck, RefreshCcw } from 'lucide-react';
import type { AuthSession } from '../../../shared/src';

type AuthMode = 'login' | 'register' | 'reset';

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAuthenticated: (session: AuthSession) => void;
  disableClose?: boolean;
}

type FormState = {
  username: string;
  password: string;
  confirmPassword: string;
  displayName: string;
  firstPet: string;
  motherMaiden: string;
  firstSchool: string;
};

const EMPTY_FORM: FormState = {
  username: '',
  password: '',
  confirmPassword: '',
  displayName: '',
  firstPet: '',
  motherMaiden: '',
  firstSchool: ''
};

export function LoginModal({ isOpen, onClose, onAuthenticated, disableClose }: LoginModalProps) {
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
        return 'Reset password';
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

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus(null);

    const username = form.username.trim();
    if (!username) {
      setStatus({ variant: 'error', text: 'Username is required.' });
      return;
    }

    if (mode === 'login') {
      if (!form.password.trim()) {
        setStatus({ variant: 'error', text: 'Password is required.' });
        return;
      }
    }

    if (mode === 'register') {
      if (!form.displayName.trim()) {
        setStatus({ variant: 'error', text: 'Display name is required.' });
        return;
      }
      if (!form.password.trim() || !form.confirmPassword.trim()) {
        setStatus({ variant: 'error', text: 'Password and confirmation are required.' });
        return;
      }
      if (form.password !== form.confirmPassword) {
        setStatus({ variant: 'error', text: 'Passwords do not match.' });
        return;
      }
      const allAnswered = [form.firstPet, form.motherMaiden, form.firstSchool].every((value) => value.trim());
      if (!allAnswered) {
        setStatus({ variant: 'error', text: 'Please answer all security questions.' });
        return;
      }
    }

    if (mode === 'reset') {
      const answered = [form.firstPet, form.motherMaiden, form.firstSchool].filter((value) => value.trim()).length;
      if (answered < 2) {
        setStatus({ variant: 'error', text: 'Answer at least two security questions.' });
        return;
      }
      if (!form.password.trim() || !form.confirmPassword.trim()) {
        setStatus({ variant: 'error', text: 'Enter and confirm your new password.' });
        return;
      }
      if (form.password !== form.confirmPassword) {
        setStatus({ variant: 'error', text: 'New password confirmation does not match.' });
        return;
      }
    }

    setSubmitting(true);
    try {
      if (mode === 'login') {
        const res = await window.api.auth.login({ username, password: form.password });
        if (!res.ok) throw new Error(res.error.message);
        onAuthenticated(res.value.session);
        setForm(EMPTY_FORM);
        setStatus(null);
      } else if (mode === 'register') {
        const res = await window.api.auth.register({
          username,
          password: form.password,
          displayName: form.displayName.trim(),
          securityAnswers: {
            firstPet: form.firstPet.trim(),
            motherMaiden: form.motherMaiden.trim(),
            firstSchool: form.firstSchool.trim()
          }
        });
        if (!res.ok) throw new Error(res.error.message);
        onAuthenticated(res.value.session);
        setForm(EMPTY_FORM);
        setStatus(null);
      } else {
        const res = await window.api.auth.resetPassword({
          username,
          newPassword: form.password,
          answers: {
            firstPet: form.firstPet.trim(),
            motherMaiden: form.motherMaiden.trim(),
            firstSchool: form.firstSchool.trim()
          }
        });
        if (!res.ok) throw new Error(res.error.message);
        onAuthenticated(res.value.session);
        setForm(EMPTY_FORM);
        setStatus(null);
        setMode('login');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ variant: 'error', text: message });
    } finally {
      setSubmitting(false);
    }
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
          <button
            className="rounded-md p-1 hover:bg-muted disabled:opacity-50"
            onClick={onClose}
            disabled={disableClose}
          >
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
            <span className="mb-1 block font-medium text-muted-foreground">Username</span>
            <input
              className="w-full rounded border px-3 py-2"
              value={form.username}
              onChange={(e) => setForm((prev) => ({ ...prev, username: e.target.value }))}
              placeholder="e.g. jsmith"
            />
          </label>

          {(mode === 'login' || mode === 'register') && (
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
          )}

          {(mode === 'register' || mode === 'reset') && (
            <>
              <p className="text-xs text-muted-foreground">
                {mode === 'reset'
                  ? 'Answer any two of the security questions below to reset your password.'
                  : 'Set your security answers (required for password resets).'}
              </p>
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-muted-foreground">First pet&apos;s name</span>
                <input
                  className="w-full rounded border px-3 py-2"
                  value={form.firstPet}
                  onChange={(e) => setForm((prev) => ({ ...prev, firstPet: e.target.value }))}
                  placeholder="e.g. Milo"
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-muted-foreground">Mother&apos;s maiden name</span>
                <input
                  className="w-full rounded border px-3 py-2"
                  value={form.motherMaiden}
                  onChange={(e) => setForm((prev) => ({ ...prev, motherMaiden: e.target.value }))}
                  placeholder="e.g. Williams"
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-muted-foreground">First school attended</span>
                <input
                  className="w-full rounded border px-3 py-2"
                  value={form.firstSchool}
                  onChange={(e) => setForm((prev) => ({ ...prev, firstSchool: e.target.value }))}
                  placeholder="e.g. Central Primary"
                />
              </label>
            </>
          )}

          {mode === 'reset' ? (
            <>
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-muted-foreground">New password</span>
                <input
                  type="password"
                  className="w-full rounded border px-3 py-2"
                  value={form.password}
                  onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
                  placeholder="••••••••"
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-muted-foreground">Confirm new password</span>
                <input
                  type="password"
                  className="w-full rounded border px-3 py-2"
                  value={form.confirmPassword}
                  onChange={(e) => setForm((prev) => ({ ...prev, confirmPassword: e.target.value }))}
                  placeholder="Repeat new password"
                />
              </label>
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
          {mode === 'login' ? (
            <p className="text-center text-xs text-muted-foreground">
              Five failed attempts will require a security reset.
            </p>
          ) : null}

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
