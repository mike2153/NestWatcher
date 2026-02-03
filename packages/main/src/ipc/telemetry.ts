import { ok } from 'neverthrow';
import { ok } from 'neverthrow';
import type { AppError, NestpickModesRes, TelemetrySummaryReq, TelemetrySummaryRes } from '../../../shared/src';
import { TelemetrySummaryReq as TelemetrySummaryReqSchema } from '../../../shared/src';
import { registerResultHandler } from './result';
import { summarizeTelemetry } from '../repo/telemetryRepo';
import { listMachines } from '../repo/machinesRepo';
import { getLatestNestpickEnabledForPcIp } from '../repo/nestpickModeRepo';
import type { WebContents } from 'electron';
import { onContentsDestroyed } from './onDestroyed';
import { logger } from '../logger';

export function registerTelemetryIpc() {
  registerResultHandler('telemetry:summary', async (_e, raw) => {
    const req = TelemetrySummaryReqSchema.parse(raw ?? {} as TelemetrySummaryReq);
    const items = await summarizeTelemetry(req);
    const res: TelemetrySummaryRes = { items };
    return ok<TelemetrySummaryRes, AppError>(res);
  });

  registerResultHandler('telemetry:nestpickModes', async () => {
    const machines = (await listMachines()).filter((m) => m.nestpickEnabled);
    const items = await Promise.all(
      machines.map(async (m) => {
        const pcIp = (m.pcIp ?? '').trim();
        const latest = pcIp ? await getLatestNestpickEnabledForPcIp(pcIp) : { enabled: null, lastSeenAt: null };
        return {
          machineId: m.machineId,
          machineName: m.name,
          enabled: latest.enabled === true,
          lastSeenAt: latest.lastSeenAt
        };
      })
    );
    const res: NestpickModesRes = { items };
    return ok<NestpickModesRes, AppError>(res);
  });

  type Sub = { timer: NodeJS.Timeout; req: TelemetrySummaryReq; lastHash: string | null };
  const POLL_MS = 5000;
  const subs = new Map<number, Sub>();

  async function push(contents: WebContents, entry: Sub) {
    try {
      const items = await summarizeTelemetry(entry.req);
      const res: TelemetrySummaryRes = { items };
      const hash = JSON.stringify(res);
      if (entry.lastHash !== hash) {
        entry.lastHash = hash;
        if (!contents.isDestroyed()) contents.send('telemetry:update', res);
        logger.debug({ items: items.length }, 'telemetry: pushed update');
      }
    } catch (err) {
      logger.error({ err }, 'telemetry: push failed');
    }
  }

  function ensure(contents: WebContents, req: TelemetrySummaryReq) {
    const id = contents.id;
    const existing = subs.get(id);
    if (existing) {
      existing.req = req;
      existing.lastHash = null;
      void push(contents, existing);
      return;
    }
    const entry: Sub = { req, lastHash: null, timer: setInterval(() => void push(contents, entry), POLL_MS) };
    subs.set(id, entry);
    onContentsDestroyed(contents, () => release(contents));
    void push(contents, entry);
  }

  function release(contents: WebContents) {
    const id = contents.id;
    const entry = subs.get(id);
    if (!entry) return;
    clearInterval(entry.timer);
    subs.delete(id);
  }

  registerResultHandler('telemetry:subscribe', async (event, raw) => {
    const req = TelemetrySummaryReqSchema.parse(raw ?? {} as TelemetrySummaryReq);
    logger.debug({ req }, 'telemetry: subscribe');
    ensure(event.sender, req);
    return ok<null, AppError>(null);
  });

  registerResultHandler('telemetry:unsubscribe', async (event) => {
    logger.debug('telemetry: unsubscribe');
    release(event.sender);
    return ok<null, AppError>(null);
  });
}
