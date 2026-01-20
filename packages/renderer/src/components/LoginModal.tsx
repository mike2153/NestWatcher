import { useEffect, useMemo, useState } from 'react';
import { X, UserCircle2, ShieldCheck, RefreshCcw, KeyRound } from 'lucide-react';
import type { AuthSession } from '../../../shared/src';
import { Button } from '@/components/ui/button';

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
  const [canForceLogin, setCanForceLogin] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setMode('login');
      setForm(EMPTY_FORM);
      setSubmitting(false);
      setStatus(null);
      setCanForceLogin(false);
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
        const res = await window.api.auth.login({ username, password: form.password, force: false });
        if (!res.ok) {
          if (res.error.code === 'auth.alreadyActive') {
            setStatus({
              variant: 'info',
              text: 'This user appears signed in on another workstation. If that session is stale, you can sign in here to take over.'
            });
            setCanForceLogin(true);
            return;
          }
          throw new Error(res.error.message);
        }
        onAuthenticated(res.value.session);
        setForm(EMPTY_FORM);
        setStatus(null);
        setCanForceLogin(false);
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

  const handleForceLogin = async () => {
    const username = form.username.trim();
    if (!username || !form.password.trim()) return;
    setSubmitting(true);
    setStatus(null);
    try {
      const res = await window.api.auth.login({ username, password: form.password, force: true });
      if (!res.ok) throw new Error(res.error.message);
      onAuthenticated(res.value.session);
      setForm(EMPTY_FORM);
      setStatus(null);
      setCanForceLogin(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ variant: 'error', text: message });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-[92vw] max-w-md rounded-lg border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] shadow-lg animate-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-[var(--muted)] p-2 text-[var(--foreground)]">
              {mode === 'register' ? (
                <ShieldCheck className="h-5 w-5" />
              ) : mode === 'reset' ? (
                <KeyRound className="h-5 w-5" />
              ) : (
                <UserCircle2 className="h-5 w-5" />
              )}
            </div>
            <div>
              <p className="text-xs font-medium text-[var(--muted-foreground)]">NestWatcher</p>
              <p className="text-base font-semibold">{header}</p>
            </div>
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="size-8 rounded-md"
            onClick={onClose}
            disabled={disableClose}
            type="button"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-5 py-5">
          {status ? (
            <div
              className={`rounded-md border px-3 py-2 text-sm ${
                status.variant === 'error'
                  ? 'border-[var(--status-error-border)] bg-[var(--status-error-bg)] text-[var(--status-error-text)]'
                  : status.variant === 'success'
                    ? 'border-[var(--status-success-border)] bg-[var(--status-success-bg)] text-[var(--status-success-text)]'
                    : 'border-[var(--status-info-border)] bg-[var(--status-info-bg)] text-[var(--status-info-text)]'
              }`}
            >
              {status.text}
            </div>
          ) : null}

          {mode === 'register' ? (
            <label className="block text-sm">
              <span className="mb-1 block text-sm font-medium text-[var(--foreground)]">Display name</span>
              <input
                className="h-9 w-full rounded-md border border-[var(--border)] bg-transparent px-3 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:border-[var(--ring)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
                value={form.displayName}
                onChange={(e) => setForm((prev) => ({ ...prev, displayName: e.target.value }))}
                placeholder="Jane Smith"
              />
            </label>
          ) : null}

          <label className="block text-sm">
            <span className="mb-1 block text-sm font-medium text-[var(--foreground)]">Username</span>
            <input
              className="h-9 w-full rounded-md border border-[var(--border)] bg-transparent px-3 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:border-[var(--ring)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
              value={form.username}
              onChange={(e) => setForm((prev) => ({ ...prev, username: e.target.value }))}
              placeholder="e.g. jsmith"
              autoComplete="username"
            />
          </label>

          {(mode === 'login' || mode === 'register') && (
            <>
              <label className="block text-sm">
                <span className="mb-1 block text-sm font-medium text-[var(--foreground)]">Password</span>
                <input
                  type="password"
                  className="h-9 w-full rounded-md border border-[var(--border)] bg-transparent px-3 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:border-[var(--ring)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
                  value={form.password}
                  onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
                  placeholder="••••••••"
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                />
              </label>
              {mode === 'register' ? (
                <label className="block text-sm">
                  <span className="mb-1 block text-sm font-medium text-[var(--foreground)]">Confirm password</span>
                  <input
                    type="password"
                    className="h-9 w-full rounded-md border border-[var(--border)] bg-transparent px-3 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:border-[var(--ring)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
                    value={form.confirmPassword}
                    onChange={(e) => setForm((prev) => ({ ...prev, confirmPassword: e.target.value }))}
                    placeholder="Repeat password"
                    autoComplete="new-password"
                  />
                </label>
              ) : null}
            </>
          )}

          {(mode === 'register' || mode === 'reset') && (
            <>
              <p className="text-xs text-[var(--muted-foreground)]">
                {mode === 'reset'
                  ? 'Answer any two of the security questions below to reset your password.'
                  : 'Set your security answers (required for password resets).'}
              </p>
              <label className="block text-sm">
                <span className="mb-1 block text-sm font-medium text-[var(--foreground)]">First pet&apos;s name</span>
                <input
                  className="h-9 w-full rounded-md border border-[var(--border)] bg-transparent px-3 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:border-[var(--ring)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
                  value={form.firstPet}
                  onChange={(e) => setForm((prev) => ({ ...prev, firstPet: e.target.value }))}
                  placeholder="e.g. Milo"
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-sm font-medium text-[var(--foreground)]">Mother&apos;s maiden name</span>
                <input
                  className="h-9 w-full rounded-md border border-[var(--border)] bg-transparent px-3 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:border-[var(--ring)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
                  value={form.motherMaiden}
                  onChange={(e) => setForm((prev) => ({ ...prev, motherMaiden: e.target.value }))}
                  placeholder="e.g. Williams"
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-sm font-medium text-[var(--foreground)]">First school attended</span>
                <input
                  className="h-9 w-full rounded-md border border-[var(--border)] bg-transparent px-3 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:border-[var(--ring)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
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
                <span className="mb-1 block text-sm font-medium text-[var(--foreground)]">New password</span>
                <input
                  type="password"
                  className="h-9 w-full rounded-md border border-[var(--border)] bg-transparent px-3 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:border-[var(--ring)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
                  value={form.password}
                  onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
                  placeholder="••••••••"
                  autoComplete="new-password"
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-sm font-medium text-[var(--foreground)]">Confirm new password</span>
                <input
                  type="password"
                  className="h-9 w-full rounded-md border border-[var(--border)] bg-transparent px-3 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:border-[var(--ring)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
                  value={form.confirmPassword}
                  onChange={(e) => setForm((prev) => ({ ...prev, confirmPassword: e.target.value }))}
                  placeholder="Repeat new password"
                  autoComplete="new-password"
                />
              </label>
            </>
          ) : null}

          {mode === 'login' ? (
            <button
              type="button"
              className="text-sm font-medium text-[var(--primary)] hover:underline underline-offset-4"
              onClick={() => setMode('reset')}
            >
              Forgot password?
            </button>
          ) : null}

          <Button type="submit" disabled={submitting} className="h-9 w-full rounded-md text-sm font-medium">
            {submitting ? <RefreshCcw className="mr-2 h-4 w-4 animate-spin" /> : null}
            {cta}
          </Button>

          {mode === 'login' && canForceLogin ? (
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              className="h-9 w-full rounded-md text-sm font-medium"
              onClick={handleForceLogin}
            >
              Sign in here anyway
            </Button>
          ) : null}
          {mode === 'login' ? (
            <p className="text-center text-xs text-[var(--muted-foreground)]">
              Five failed attempts will require a security reset.
            </p>
          ) : null}

          <div className="text-center text-sm text-[var(--muted-foreground)]">
            {hint.text}{' '}
            <button
              type="button"
              className="font-medium text-[var(--primary)] underline-offset-4 hover:underline"
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
