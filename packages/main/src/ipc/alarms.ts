import type { WebContents } from 'electron';
import { ok } from 'neverthrow';
import type { AlarmsHistoryReq, AlarmsHistoryRes, AppError } from '../../../shared/src';
import { AlarmsHistoryReq as AlarmsHistoryReqSchema } from '../../../shared/src';
import { listActiveAlarms } from '../repo/alarmsRepo';
import { logger } from '../logger';
import { registerResultHandler } from './result';
import { onContentsDestroyed } from './onDestroyed';
import { listAlarmIntervals } from '../repo/alarmsHistoryRepo';

type AlarmSubscription = {
  timer: NodeJS.Timeout;
  refCount: number;
};

const POLL_INTERVAL_MS = 7500;
const subscribers = new Map<number, AlarmSubscription>();

async function pushAlarms(contents: WebContents) {
  try {
    const alarms = await listActiveAlarms();
    if (!contents.isDestroyed()) {
      contents.send('alarms:update', alarms);
    }
  } catch (err) {
    logger.error({ err }, 'alarms-ipc: failed to fetch alarms');
  }
}

function ensureSubscription(contents: WebContents) {
  const id = contents.id;
  const existing = subscribers.get(id);
  if (existing) {
    existing.refCount += 1;
    return;
  }

  const timer = setInterval(() => {
    void pushAlarms(contents);
  }, POLL_INTERVAL_MS);

  const subscription: AlarmSubscription = { timer, refCount: 1 };
  subscribers.set(id, subscription);

  onContentsDestroyed(contents, () => releaseSubscription(contents));
  void pushAlarms(contents);
}

function releaseSubscription(contents: WebContents) {
  const id = contents.id;
  const entry = subscribers.get(id);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount <= 0) {
    clearInterval(entry.timer);
    subscribers.delete(id);
  }
}

export function registerAlarmsIpc() {
  registerResultHandler('alarms:list', async () => ok(await listActiveAlarms()));

  registerResultHandler('alarms:subscribe', async (event) => {
    ensureSubscription(event.sender);
    return ok<null, AppError>(null);
  });

  registerResultHandler('alarms:unsubscribe', async (event) => {
    releaseSubscription(event.sender);
    return ok<null, AppError>(null);
  });

  registerResultHandler('alarms:history', async (_e, raw) => {
    const req = AlarmsHistoryReqSchema.parse(raw ?? {} as AlarmsHistoryReq);
    const items = await listAlarmIntervals(req);
    const res: AlarmsHistoryRes = { items };
    return ok<AlarmsHistoryRes, AppError>(res);
  });
}
