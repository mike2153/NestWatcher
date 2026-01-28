import { describe, it, expect } from 'vitest';
import type { NcCatHeadlessValidationFileResult } from '../packages/shared/src';
import { buildNcCatValidationReport } from '../packages/main/src/services/ncCatValidationReport';

function result(params: {
  filename: string;
  status: 'pass' | 'warnings' | 'errors';
  warnings?: string[];
  errors?: string[];
  syntax?: string[];
}): NcCatHeadlessValidationFileResult {
  return {
    filename: params.filename,
    validation: {
      status: params.status,
      warnings: params.warnings ?? [],
      errors: params.errors ?? [],
      ...(params.syntax ? { syntax: params.syntax } : {})
    } as any
  };
}

describe('buildNcCatValidationReport', () => {
  it('marks overallStatus pass when all files pass', () => {
    const report = buildNcCatValidationReport({
      reason: 'stage',
      folderName: 'kitchen',
      profileName: 'Machine A',
      processedAt: '2026-01-01T00:00:00.000Z',
      results: [result({ filename: '10.nc', status: 'pass' }), result({ filename: '11.nc', status: 'pass' })]
    });

    expect(report.overallStatus).toBe('pass');
    expect(report.files).toHaveLength(2);
  });

  it('marks overallStatus warnings when any file has warnings', () => {
    const report = buildNcCatValidationReport({
      reason: 'ingest',
      folderName: 'kitchen',
      profileName: null,
      results: [result({ filename: '10.nc', status: 'warnings', warnings: ['W1'] })]
    });

    expect(report.overallStatus).toBe('warnings');
    expect(report.profileName).toBeNull();
    expect(report.files[0]?.warnings).toEqual(['W1']);
  });

  it('marks overallStatus errors when any file has errors', () => {
    const report = buildNcCatValidationReport({
      reason: 'stage',
      folderName: 'kitchen',
      results: [result({ filename: '10.nc', status: 'errors', errors: ['E1'] })]
    });

    expect(report.overallStatus).toBe('errors');
    expect(report.files[0]?.errors).toEqual(['E1']);
  });

  it('merges legacy syntax into errors', () => {
    const report = buildNcCatValidationReport({
      reason: 'stage',
      folderName: 'kitchen',
      results: [result({ filename: '10.nc', status: 'errors', errors: ['E1'], syntax: ['S1', 'S2'] })]
    });

    expect(report.files[0]?.errors).toEqual(['E1', 'S1', 'S2']);
  });

  it('defaults processedAt when not supplied', () => {
    const report = buildNcCatValidationReport({
      reason: 'stage',
      folderName: 'kitchen',
      results: [result({ filename: '10.nc', status: 'pass' })]
    });

    expect(typeof report.processedAt).toBe('string');
    expect(report.processedAt.length).toBeGreaterThan(10);
  });
});
