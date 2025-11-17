function serializeArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg);
  } catch {
    try { return String(arg); } catch { return '[unserializable]'; }
  }
}

function formatMessage(args: unknown[]): string {
  return args.map(serializeArg).join(' ');
}

export function installRendererConsoleForwarding() {
  type ApiLog = { [k: string]: (msg: string, ctx?: Record<string, unknown>) => Promise<unknown> };
  const apiWrapper = (window as unknown as { api?: { log?: ApiLog } }).api;
  if (!apiWrapper || !apiWrapper.log) return;
  const apiLog: ApiLog = apiWrapper.log;

  const orig = { ...console };
  console.log = (...args: unknown[]) => {
    orig.log(...args);
    void apiLog.info?.(formatMessage(args));
  };
  console.info = (...args: unknown[]) => {
    orig.info(...args);
    void apiLog.info?.(formatMessage(args));
  };
  console.debug = (...args: unknown[]) => {
    orig.debug?.(...args);
    void apiLog.debug?.(formatMessage(args));
  };
  console.warn = (...args: unknown[]) => {
    orig.warn(...args);
    void apiLog.warn?.(formatMessage(args));
  };
  console.error = (...args: unknown[]) => {
    orig.error(...args);
    const msg = formatMessage(args);
    void apiLog.error?.(msg);
  };

  // Capture unhandled errors and rejections
  window.addEventListener('error', (ev) => {
    const message = ev?.error instanceof Error ? `${ev.error.name}: ${ev.error.message}` : String(ev.message ?? 'Unhandled error');
    void apiLog.error?.(message);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const reason = (ev as PromiseRejectionEvent)?.reason;
    const message = reason instanceof Error ? `${reason.name}: ${reason.message}` : serializeArg(reason);
    void apiLog.error?.(`Unhandled rejection: ${message}`);
  });
}
