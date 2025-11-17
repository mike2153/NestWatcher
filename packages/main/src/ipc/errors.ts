import { AppErrorSchema, type AppError } from '../../../shared/src';
import type { DatabaseError } from 'pg';

function pickDetails(error: DatabaseError) {
  const details: Record<string, unknown> = {};
  if (error.detail) details.detail = error.detail;
  if (error.schema) details.schema = error.schema;
  if (error.table) details.table = error.table;
  if (error.constraint) details.constraint = error.constraint;
  const column = (error as unknown as { column?: unknown }).column;
  if (column !== undefined) {
    details.column = column;
  }
  return Object.keys(details).length ? details : undefined;
}

const PG_ERROR_MAPPERS: Record<string, (error: DatabaseError) => AppError> = {
  '23505': (error) => ({
    code: 'db.uniqueViolation',
    message: 'A record with the same value already exists.',
    details: pickDetails(error)
  }),
  '23503': (error) => ({
    code: 'db.foreignKeyViolation',
    message: 'The requested record references missing related data.',
    details: pickDetails(error)
  }),
  '23502': (error) => ({
    code: 'db.notNullViolation',
    message: 'A required column was missing.',
    details: pickDetails(error)
  }),
  '22001': (error) => ({
    code: 'db.stringTooLong',
    message: 'Input was too long for the target column.',
    details: pickDetails(error)
  })
};

function defaultPgError(error: DatabaseError): AppError {
  return {
    code: 'db.error',
    message: error.message,
    details: pickDetails(error)
  };
}

function isDatabaseError(error: unknown): error is DatabaseError {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

export function toAppError(error: unknown): AppError {
  if (!(error instanceof Error) && AppErrorSchema.safeParse(error).success) {
    return error as AppError;
  }

  if (isDatabaseError(error)) {
    const mapper = PG_ERROR_MAPPERS[error.code ?? ''];
    return mapper ? mapper(error) : defaultPgError(error);
  }

  if (error instanceof Error) {
    return {
      code: 'unknown',
      message: error.message,
      details: error.stack ? { stack: error.stack } : undefined
    };
  }

  return {
    code: 'unknown',
    message: 'An unknown error occurred.',
    details: { raw: error }
  };
}

export function createAppError(code: string, message: string, details?: unknown): AppError {
  return { code, message, details };
}
