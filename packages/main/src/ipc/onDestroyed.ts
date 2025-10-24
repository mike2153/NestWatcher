import type { WebContents } from 'electron';
import { logger } from '../logger';

type Cleanup = () => void;

const destroyedCleanups = new WeakMap<WebContents, Set<Cleanup>>();

function attachOnce(contents: WebContents, cleanups: Set<Cleanup>) {
  contents.once('destroyed', () => {
    destroyedCleanups.delete(contents);
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch (error) {
        logger.warn({ error }, 'onDestroyed: cleanup threw');
      }
    }
    cleanups.clear();
  });
}

export function onContentsDestroyed(contents: WebContents, cleanup: Cleanup) {
  let cleanups = destroyedCleanups.get(contents);
  if (!cleanups) {
    cleanups = new Set();
    destroyedCleanups.set(contents, cleanups);
    attachOnce(contents, cleanups);
  }
  cleanups.add(cleanup);
}
