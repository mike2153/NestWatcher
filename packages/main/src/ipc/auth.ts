import { randomUUID } from 'crypto';
import { ok, err } from 'neverthrow';
import {
  AuthLoginReq,
  AuthRegisterReq,
  AuthResetPasswordReq,
  type AppError,
  type AuthSuccessRes,
  type AuthStateRes,
  type AuthSession
} from '../../../shared/src';
import { registerResultHandler } from './result';
import { createAppError } from './errors';
import {
  activateSession,
  createUser,
  findUserByUsername,
  recordFailedLogin,
  resetPasswordWithAnswers
} from '../repo/userRepo';
import { hashSecret, verifySecret } from '../services/hash';
import { detachSession, getSession, setSessionForEvent } from '../services/authSessions';

function toSession(user: { id: number; username: string; displayName: string | null; role: string }): AuthSession {
  const displayName = user.displayName?.trim() || user.username;
  const role = user.role === 'admin' ? 'admin' : 'operator';
  return { userId: user.id, username: user.username, displayName, role };
}

function formatDuplicateError() {
  return createAppError('auth.usernameTaken', 'That username is already in use.');
}

export function registerAuthIpc() {
  registerResultHandler<AuthStateRes>('auth:me', async (event) => {
    const session = getSession(event.sender);
    return ok<AuthStateRes, AppError>({ session });
  }, { requiresAuth: false });

  registerResultHandler<AuthSuccessRes>('auth:login', async (event, raw) => {
    const parsed = AuthLoginReq.safeParse(raw);
    if (!parsed.success) {
      return err(createAppError('auth.invalidArguments', parsed.error.message));
    }
    const username = parsed.data.username.trim();
    const password = parsed.data.password;
    const user = await findUserByUsername(username);
    if (!user) {
      return err(createAppError('auth.invalidCredentials', 'Invalid username or password.'));
    }
    if (user.activeSessionToken) {
      return err(createAppError('auth.alreadyActive', 'This user is already signed in on another workstation.'));
    }
    if (user.forcePasswordReset) {
      return err(createAppError('auth.resetRequired', 'Please reset your password to continue.'));
    }
    const passwordOk = await verifySecret(user.passwordHash, password);
    if (!passwordOk) {
      const { requiresReset } = await recordFailedLogin(user.id);
      if (requiresReset) {
        return err(createAppError('auth.resetRequired', 'Too many attempts. Please reset your password.'));
      }
      return err(createAppError('auth.invalidCredentials', 'Invalid username or password.'));
    }
    const token = randomUUID();
    await activateSession(user.id, token);
    const session = toSession(user);
    setSessionForEvent(event, { ...session, token });
    return ok<AuthSuccessRes, AppError>({ session });
  }, { requiresAuth: false });

  registerResultHandler<AuthSuccessRes>('auth:register', async (event, raw) => {
    const parsed = AuthRegisterReq.safeParse(raw);
    if (!parsed.success) {
      return err(createAppError('auth.invalidArguments', parsed.error.message));
    }
    const username = parsed.data.username.trim();
    const existing = await findUserByUsername(username);
    if (existing) {
      return err(formatDuplicateError());
    }
    try {
      const passwordHash = await hashSecret(parsed.data.password);
      const petHash = await hashSecret(parsed.data.securityAnswers.firstPet);
      const maidenHash = await hashSecret(parsed.data.securityAnswers.motherMaiden);
      const schoolHash = await hashSecret(parsed.data.securityAnswers.firstSchool);
      const created = await createUser({
        username,
        displayName: parsed.data.displayName.trim(),
        passwordHash,
        securityPetHash: petHash,
        securityMaidenHash: maidenHash,
        securitySchoolHash: schoolHash
      });
      const token = randomUUID();
      await activateSession(created.id, token);
      const session = toSession(created);
      setSessionForEvent(event, { ...session, token });
      return ok<AuthSuccessRes, AppError>({ session });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('app_users_username_ci_idx')) {
        return err(formatDuplicateError());
      }
      throw error;
    }
  }, { requiresAuth: false });

  registerResultHandler<AuthSessionRes>('auth:resetPassword', async (event, raw) => {
    const parsed = AuthResetPasswordReq.safeParse(raw);
    if (!parsed.success) {
      return err(createAppError('auth.invalidArguments', parsed.error.message));
    }
    const username = parsed.data.username.trim();
    const user = await findUserByUsername(username);
    if (!user) {
      return err(createAppError('auth.invalidCredentials', 'Security verification failed.'));
    }
    const matches = [
      await verifySecret(user.securityPetHash, parsed.data.answers.firstPet),
      await verifySecret(user.securityMaidenHash, parsed.data.answers.motherMaiden),
      await verifySecret(user.securitySchoolHash, parsed.data.answers.firstSchool)
    ].filter(Boolean).length;

    if (matches < 2) {
      return err(createAppError('auth.invalidCredentials', 'Security verification failed.'));
    }

    const newHash = await hashSecret(parsed.data.newPassword);
    await resetPasswordWithAnswers(user.id, newHash);

    const token = randomUUID();
    await activateSession(user.id, token);
    const session = toSession(user);
    setSessionForEvent(event, { ...session, token });
    return ok<AuthSuccessRes, AppError>({ session });
  }, { requiresAuth: false });

  registerResultHandler<null>('auth:logout', async (event) => {
    await detachSession(event.sender);
    return ok<null, AppError>(null);
  });
}
