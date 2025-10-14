import { existsSync, promises as fsp } from 'fs';
import { join, normalize } from 'path';
import { loadConfig } from './config';

type OrderItem = { key: string; ncfile: string | null; material: string | null };

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number, intervalMs = 300): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function waitForStableFile(path: string, attempts = 4, intervalMs = 300): Promise<void> {
  let lastSize = -1;
  for (let i = 0; i < attempts; i++) {
    try {
      const stat = await fsp.stat(path);
      if (stat.size === lastSize) return;
      lastSize = stat.size;
    } catch {}
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function toNcName(base: string | null): string {
  const name = (base ?? '').trim();
  if (!name) return '';
  return /\.nc$/i.test(name) ? name : `${name}.nc`;
}

export async function placeOrderSawCsv(items: OrderItem[], timeoutMs = 10_000): Promise<{ confirmed: boolean; erl?: string; csv?: string; folder: string }>{
  if (!items.length) throw new Error('No items to order');
  const cfg = loadConfig();
  const folderRaw = cfg.paths.grundnerFolderPath?.trim() ?? '';
  if (!folderRaw) throw new Error('Grundner folder path is not configured');
  const folder = normalize(folderRaw);
  if (!existsSync(folder)) throw new Error(`Grundner folder does not exist: ${folder}`);

  const csvPath = join(folder, 'order_saw.csv');
  const tmpPath = join(folder, 'order_saw.tmp');
  const erlPath = join(folder, 'order_saw.erl');

  // Make sure previous reply is cleared to avoid stale confirmations
  try { await fsp.unlink(erlPath); } catch {}

  // Avoid overwriting an in-flight order: if present, wait 5s once then fail if still present
  if (existsSync(csvPath) || existsSync(tmpPath)) {
    await new Promise((r) => setTimeout(r, 5000));
    if (existsSync(csvPath) || existsSync(tmpPath)) {
      throw new Error('order_saw.csv is busy; please retry shortly');
    }
  }

  const lines = items.map((it) => `${toNcName(it.ncfile)};${(it.material ?? '').trim()};1;0;0;0;0;0;0;0;`).join('\r\n') + '\r\n';

  // Write atomic temp then rename
  await fsp.writeFile(tmpPath, lines, 'utf8');
  await fsp.rename(tmpPath, csvPath).catch(async () => { await fsp.writeFile(csvPath, lines, 'utf8'); });

  // Wait for reply
  const ok = await waitFor(async () => existsSync(erlPath), timeoutMs);
  if (!ok) return { confirmed: false, folder };

  await waitForStableFile(erlPath);
  const erl = await fsp.readFile(erlPath, 'utf8');

  // Normalize CRLF and trailing whitespace for comparison
  const norm = (s: string) => s.replace(/\r\n/g, '\n').trim();
  const confirmed = norm(erl) === norm(lines);
  return { confirmed, erl, csv: lines, folder };
}
