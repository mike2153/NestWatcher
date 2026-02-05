import { ok } from 'neverthrow';
import type { AppError, NestpickModesRes, TelemetrySummaryReq, TelemetrySummaryRes } from '../../../shared/src';
import { TelemetrySummaryReq as TelemetrySummaryReqSchema } from '../../../shared/src';
import { registerResultHandler } from './result';
import { summarizeTelemetry } from '../repo/telemetryRepo';
import { listMachines } from '../repo/machinesRepo';
import { getLatestNestpickEnabledDebugForPcIp } from '../repo/nestpickModeRepo';
import type { WebContents } from 'electron';
import { onContentsDestroyed } from './onDestroyed';
import { logger } from '../logger';

type NestpickModeLogState = {
  // We only log on init and when custom_values changes.
  lastCustomValuesHash: string | null;
};

// Nestpick mode is polled by the renderer header every 5 seconds.
// We only log:
// - the first time we see a machine (init)
// - when the latest cncstats.custom_values JSON changes
const nestpickModeLogStateByMachineId = new Map<number, NestpickModeLogState>();

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unstringifiable json]';
  }
}

function buildNestpickModeDecisionMessage(args: {
  machineId: number;
  machineName: string;
  cncstatsRowKey: string | null;
  customValues: unknown;
  npEnabled: 'yes' | 'no';
}): string {
  const lastKey = args.cncstatsRowKey ?? '(none)';
  const customValuesText = safeJsonStringify(args.customValues);

  // Requested format (after normal logger prefix):
  // | Machine (machine name) | (last key) | NP Enabled (yes/no) | custom values
  return `| Machine ${args.machineName} | ${lastKey} | NP Enabled ${args.npEnabled} | ${customValuesText}`;
}

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

        const latest = await getLatestNestpickEnabledDebugForPcIp(pcIp);
        const shouldBeGreen = latest.enabled === true;

        // Logging policy: log once on init, then only when the latest cncstats.custom_values changes.
        // This avoids log spam while still capturing exactly when the input that drives
        // the dot changes.
        const customValuesHash = safeJsonStringify(latest.row.customValues);
        const state = nestpickModeLogStateByMachineId.get(m.machineId);
        const isInit = !state;
        const changed = state?.lastCustomValuesHash !== customValuesHash;
        if (isInit || changed) {
          const msg = buildNestpickModeDecisionMessage({
            machineId: m.machineId,
            machineName: m.name,
            cncstatsRowKey: latest.row.key,
            customValues: latest.row.customValues,
            npEnabled: shouldBeGreen ? 'yes' : 'no'
          });
          logger.info(msg);
          nestpickModeLogStateByMachineId.set(m.machineId, { lastCustomValuesHash: customValuesHash });
        }

        return {
          machineId: m.machineId,
          machineName: m.name,
          enabled: shouldBeGreen,
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
