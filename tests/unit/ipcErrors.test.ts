import { describe, expect, it } from 'vitest';
interface DatabaseError extends Error { code?: string; detail?: string; schema?: string; table?: string; constraint?: string; column?: string }

import { createAppError, toAppError } from '../../packages/main/src/ipc/errors';

const makeDbError = (message: string, props: Record<string, unknown>): DatabaseError => {
  return Object.assign(new Error(message), props) as DatabaseError;
};

describe('ipc error mapping', () => {
  it('returns existing AppError instances unchanged', () => {
    const appError = createAppError('custom.error', 'something went wrong', { hint: 'retry' });
    const mapped = toAppError(appError);
    expect(mapped).toBe(appError);
  });

  it('maps known Postgres errors to friendly AppError variants', () => {
    const dbError = makeDbError('duplicate key value violates unique constraint "jobs_pkey"', {
      code: '23505',
      detail: 'Key (id)=(1) already exists.',
      schema: 'public',
      table: 'jobs',
      constraint: 'jobs_pkey',
      column: 'id'
    });

    const mapped = toAppError(dbError);

    expect(mapped.code).toBe('db.uniqueViolation');
    expect(mapped.message).toBe('A record with the same value already exists.');
    expect(mapped.details).toEqual({
      detail: 'Key (id)=(1) already exists.',
      schema: 'public',
      table: 'jobs',
      constraint: 'jobs_pkey',
      column: 'id'
    });
  });

  it('falls back to generic db error for unmapped Postgres codes', () => {
    const dbError = makeDbError('connection reset', {
      code: '99999',
      table: 'jobs'
    });

    const mapped = toAppError(dbError);

    expect(mapped.code).toBe('db.error');
    expect(mapped.message).toBe('connection reset');
    expect(mapped.details).toEqual({ table: 'jobs' });
  });

  it('wraps standard Error instances', () => {
    const error = new Error('explode');

    const mapped = toAppError(error);

    expect(mapped.code).toBe('unknown');
    expect(mapped.message).toBe('explode');
    const details = mapped.details as { stack?: string } | undefined;
    if (details) {
      expect(typeof details.stack).toBe('string');
    }
  });

  it('wraps arbitrary values as unknown errors', () => {
    const raw = { unexpected: true };

    const mapped = toAppError(raw);

    expect(mapped.code).toBe('unknown');
    expect(mapped.message).toBe('An unknown error occurred.');
    expect(mapped.details).toEqual({ raw });
  });
});

