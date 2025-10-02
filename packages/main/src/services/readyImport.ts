import { promises as fsp } from 'fs';
import { basename, dirname, extname, join, relative, resolve } from 'path';
import { eq } from 'drizzle-orm';
import type { JobStatus, ReadyImportRes } from '../../../shared/src';
import { jobs } from '../db/schema';
import { appendJobEvent } from '../repo/jobEventsRepo';
import { getMachine } from '../repo/machinesRepo';
import { withDb } from './db';

function toPosix(path: string): string {
  return path.split('\\').join('/');
}

async function parseNcMetadata(filePath: string): Promise<{
  material: string | null;
  size: string | null;
  thickness: string | null;
}> {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const lines = raw.split(/\r?\n/);
    let material: string | null = null;
    let size: string | null = null;
    let thickness: string | null = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!material) {
        const match = trimmed.match(/ID\s*=\s*([A-Za-z0-9_.-]+)/i);
        if (match) {
          material = match[1];
        }
      }
      if (!size || !thickness) {
        const match = trimmed.match(
          /G100\s+X([0-9]+(?:\.[0-9]+)?)\s+Y([0-9]+(?:\.[0-9]+)?)\s+Z([0-9]+(?:\.[0-9]+)?)/i
        );
        if (match) {
          size = `${match[1]}x${match[2]}`;
          thickness = match[3];
        }
      }
      if (material && size && thickness) {
        break;
      }
    }
    return { material, size, thickness };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read NC file: ${message}`);
  }
}

async function countParts(directory: string, base: string): Promise<string | null> {
  try {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    const lowerBase = base.toLowerCase();
    const target = entries.find((entry) => {
      if (!entry.isFile()) return false;
      const name = entry.name.toLowerCase();
      return name === `${lowerBase}.pts` || name === `${lowerBase}.lpt`;
    });
    if (!target) {
      return null;
    }
    const file = join(directory, target.name);
    const raw = await fsp.readFile(file, 'utf8');
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return String(lines.length);
  } catch {
    return null;
  }
}

function buildJobKey(relativePath: string): { key: string; baseName: string } {
  const normalized = toPosix(relativePath).replace(/^\/+/, '');
  const lastSlash = normalized.lastIndexOf('/');
  const folderRelative = lastSlash >= 0 ? normalized.slice(0, lastSlash) : '';
  const fileName = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  const baseName = fileName.replace(/\.[^./]+$/, '') || fileName;
  const key = (folderRelative ? `${folderRelative}/${baseName}` : baseName).slice(0, 100);
  return { key, baseName };
}

export async function importReadyFile(machineId: number, relativePath: string): Promise<ReadyImportRes> {
  const machine = await getMachine(machineId);
  if (!machine) {
    throw new Error(`Machine ${machineId} not found`);
  }
  const root = machine.apJobfolder?.trim();
  if (!root) {
    throw new Error('Machine ap_jobfolder is not configured');
  }
  if (!relativePath) {
    throw new Error('relativePath is required');
  }

  const rootResolved = resolve(root);
  const normalizedRelative = toPosix(relativePath).replace(/^\/+/, '');
  const absolutePath = resolve(rootResolved, normalizedRelative);
  const relativeCheck = relative(rootResolved, absolutePath);
  if (relativeCheck.startsWith('..')) {
    throw new Error('Resolved path escapes machine job folder');
  }
  if (extname(absolutePath).toLowerCase() !== '.nc') {
    throw new Error('Only NC files can be imported');
  }

  const stats = await fsp.stat(absolutePath).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to access NC file: ${message}`);
  });
  if (!stats.isFile()) {
    throw new Error('Provided path does not point to a file');
  }

  const { key, baseName } = buildJobKey(relativePath);
  const folderAbsolute = dirname(absolutePath);
  const folderLeaf = basename(folderAbsolute);
  const metadata = await parseNcMetadata(absolutePath);
  const parts = await countParts(folderAbsolute, baseName);
  const now = new Date();

  return withDb(async (db) => {
    const existing = await db
      .select({
        status: jobs.status,
        material: jobs.material,
        size: jobs.size,
        thickness: jobs.thickness,
        parts: jobs.parts
      })
      .from(jobs)
      .where(eq(jobs.key, key))
      .limit(1);

    const nextMaterial = metadata.material ?? existing[0]?.material ?? null;
    const nextSize = metadata.size ?? existing[0]?.size ?? null;
    const nextThickness = metadata.thickness ?? existing[0]?.thickness ?? null;
    const nextParts = parts ?? existing[0]?.parts ?? null;

    if (existing.length) {
      await db
        .update(jobs)
        .set({
          folder: folderLeaf,
          ncfile: baseName,
          material: nextMaterial,
          size: nextSize,
          thickness: nextThickness,
          parts: nextParts,
          machineId,
          updatedAt: now
        })
        .where(eq(jobs.key, key));

      await appendJobEvent(
        key,
        'manual-import:updated',
        { relativePath: toPosix(relativePath), machineId },
        machineId,
        db
      );

      return {
        jobKey: key,
        created: false,
        status: existing[0].status as JobStatus,
        folder: folderLeaf,
        ncfile: baseName,
        material: nextMaterial,
        size: nextSize,
        thickness: nextThickness,
        parts: nextParts
      };
    }

    const status: JobStatus = 'PENDING';
    await db.insert(jobs).values({
      key,
      folder: folderLeaf,
      ncfile: baseName,
      material: metadata.material,
      size: metadata.size,
      thickness: metadata.thickness,
      parts,
      machineId,
      status,
      dateAdded: now,
      updatedAt: now
    });

    await appendJobEvent(
      key,
      'manual-import:created',
      { relativePath: toPosix(relativePath), machineId },
      machineId,
      db
    );

    return {
      jobKey: key,
      created: true,
      status,
      folder: folderLeaf,
      ncfile: baseName,
      material: metadata.material,
      size: metadata.size,
      thickness: metadata.thickness,
      parts
    };
  });
}
