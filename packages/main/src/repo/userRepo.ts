import { withClient } from '../services/db';

export type DbUser = {
  id: number;
  username: string;
  displayName: string | null;
  passwordHash: string;
  securityPetHash: string;
  securityMaidenHash: string;
  securitySchoolHash: string;
  role: 'admin' | 'operator' | string;
  forcePasswordReset: boolean;
  failedAttempts: number;
  activeSessionToken: string | null;
};

export async function findUserByUsername(username: string): Promise<DbUser | null> {
  return withClient(async (client) => {
    const { rows } = await client.query<DbUser & { display_name: string | null }>({
      text: `
        SELECT id,
               username,
               display_name AS "displayName",
               password_hash AS "passwordHash",
               security_pet_hash AS "securityPetHash",
               security_maiden_hash AS "securityMaidenHash",
               security_school_hash AS "securitySchoolHash",
               role,
               force_password_reset AS "forcePasswordReset",
               failed_attempts AS "failedAttempts",
               active_session_token AS "activeSessionToken"
          FROM public.app_users
         WHERE LOWER(username) = LOWER($1)
         LIMIT 1
      `,
      values: [username]
    });
    return rows[0] ?? null;
  });
}

export async function createUser(input: {
  username: string;
  displayName: string;
  passwordHash: string;
  securityPetHash: string;
  securityMaidenHash: string;
  securitySchoolHash: string;
}): Promise<DbUser> {
  return withClient(async (client) => {
    const { rows } = await client.query<DbUser & { display_name: string | null }>({
      text: `
        INSERT INTO public.app_users (
          username,
          display_name,
          password_hash,
          security_pet_hash,
          security_maiden_hash,
          security_school_hash
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id,
                  username,
                  display_name AS "displayName",
                  password_hash AS "passwordHash",
                  security_pet_hash AS "securityPetHash",
                  security_maiden_hash AS "securityMaidenHash",
                  security_school_hash AS "securitySchoolHash",
                  role,
                  force_password_reset AS "forcePasswordReset",
                  failed_attempts AS "failedAttempts",
                  active_session_token AS "activeSessionToken"
      `,
      values: [
        input.username,
        input.displayName,
        input.passwordHash,
        input.securityPetHash,
        input.securityMaidenHash,
        input.securitySchoolHash
      ]
    });
    return rows[0];
  });
}

export async function activateSession(userId: number, token: string): Promise<void> {
  await withClient((client) =>
    client.query(
      `
        UPDATE public.app_users
           SET active_session_token = $2,
               active_session_issued_at = now(),
               last_login_at = now(),
               failed_attempts = 0
         WHERE id = $1
      `,
      [userId, token]
    )
  );
}

export async function clearSession(userId: number): Promise<void> {
  await withClient((client) =>
    client.query(
      `
        UPDATE public.app_users
           SET active_session_token = NULL,
               active_session_issued_at = NULL
         WHERE id = $1
      `,
      [userId]
    )
  );
}

export async function recordFailedLogin(userId: number): Promise<{ attempts: number; requiresReset: boolean }> {
  return withClient(async (client) => {
    const { rows } = await client.query<{ failed_attempts: number; force_password_reset: boolean }>({
      text: `
        UPDATE public.app_users
           SET failed_attempts = failed_attempts + 1,
               force_password_reset = CASE WHEN failed_attempts + 1 >= 5 THEN true ELSE force_password_reset END
         WHERE id = $1
         RETURNING failed_attempts, force_password_reset
      `,
      values: [userId]
    });
    const row = rows[0];
    return {
      attempts: row?.failed_attempts ?? 0,
      requiresReset: row?.force_password_reset ?? false
    };
  });
}

export async function resetPasswordWithAnswers(userId: number, passwordHash: string): Promise<void> {
  await withClient((client) =>
    client.query(
      `
        UPDATE public.app_users
           SET password_hash = $2,
               failed_attempts = 0,
               force_password_reset = false,
               active_session_token = NULL,
               active_session_issued_at = NULL,
               last_login_at = now()
         WHERE id = $1
      `,
      [userId, passwordHash]
    )
  );
}
