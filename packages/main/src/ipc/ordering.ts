import { BrowserWindow, dialog } from 'electron';
import { promises as fs } from 'fs';
import { ok, err } from 'neverthrow';
import type { AppError, OrderingExportRes, OrderingRow, OrderingListRes } from '../../../shared/src';
import { OrderingUpdateReq } from '../../../shared/src';
import { listOrdering, updateOrderingStatus } from '../repo/orderingRepo';
import { createAppError } from './errors';
import { registerResultHandler } from './result';
import { requireSession } from '../services/authSessions';

function buildTimestampedFilename(extension: 'csv' | 'pdf'): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(
    now.getMinutes()
  )}${pad(now.getSeconds())}`;
  return `ordering-${stamp}.${extension}`;
}

function escapeCsvCell(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildCsv(rows: OrderingRow[]): string {
  const header = [
    'Type',
    'Material Name',
    'Customer ID',
    'Stock',
    'Demand',
    'Shortfall',
    'Ordered',
    'Ordered By',
    'Ordered At',
    'Comments'
  ];

  const lines = [header.map(escapeCsvCell).join(',')];
  for (const row of rows) {
    const line = [
      row.typeData != null ? String(row.typeData) : '',
      row.materialName ?? '',
      row.customerId ?? '',
      row.stock != null ? String(row.stock) : '',
      String(row.demand),
      String(row.shortfall),
      row.ordered ? 'Yes' : 'No',
      row.orderedBy ?? '',
      row.orderedAt ? new Date(row.orderedAt).toLocaleString() : '',
      row.comments ?? ''
    ];
    lines.push(line.map(escapeCsvCell).join(','));
  }

  return lines.join('\n');
}

function buildPdfHtml(rows: OrderingRow[], generatedAt: string): string {
  const headerCells = [
    '<th>Type</th>',
    '<th>Material Name</th>',
    '<th>Customer ID</th>',
    '<th class="num">Stock</th>',
    '<th class="num">Demand</th>',
    '<th class="num">Shortfall</th>',
    '<th>Ordered</th>',
    '<th>Ordered By</th>',
    '<th>Ordered At</th>',
    '<th>Comments</th>'
  ];

  const rowsHtml = rows
    .map((row) => {
      const orderedAt = escapeHtml(row.orderedAt ? new Date(row.orderedAt).toLocaleString() : '');
      const cells = [
        `<td>${escapeHtml(row.typeData != null ? String(row.typeData) : '')}</td>`,
        `<td>${escapeHtml(row.materialName ?? '')}</td>`,
        `<td>${escapeHtml(row.customerId ?? '')}</td>`,
        `<td class="num">${escapeHtml(row.stock != null ? String(row.stock) : '')}</td>`,
        `<td class="num">${escapeHtml(String(row.demand))}</td>`,
        `<td class="num">${escapeHtml(String(row.shortfall))}</td>`
      ];
      cells.push(
        `<td>${row.ordered ? 'Yes' : 'No'}</td>`,
        `<td>${escapeHtml(row.orderedBy ?? '')}</td>`,
        `<td>${orderedAt}</td>`,
        `<td>${escapeHtml(row.comments ?? '')}</td>`
      );
      return `<tr>${cells.join('')}</tr>`;
    })
    .join('');

  const generatedLabel = escapeHtml(generatedAt ? new Date(generatedAt).toLocaleString() : new Date().toLocaleString());

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Ordering Report</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            margin: 32px;
            color: #111;
          }
          h1 {
            margin-bottom: 4px;
            font-size: 20px;
          }
          p.meta {
            margin-top: 0;
            color: #555;
            font-size: 12px;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 16px;
          }
          th, td {
            border: 1px solid #d0d0d0;
            padding: 6px 8px;
            font-size: 12px;
          }
          th {
            background: #f5f5f5;
            text-align: left;
          }
          td.num, th.num {
            text-align: right;
          }
          tr:nth-child(even) td {
            background: #fafafa;
          }
        </style>
      </head>
      <body>
        <h1>Ordering Report</h1>
        <p class="meta">Generated ${generatedLabel}</p>
        <table>
          <thead>
            <tr>${headerCells.join('')}</tr>
          </thead>
          <tbody>
            ${rowsHtml || '<tr><td colspan="10">No shortages at this time.</td></tr>'}
          </tbody>
        </table>
      </body>
    </html>
  `;
}

export function registerOrderingIpc() {
  registerResultHandler('ordering:list', async () => {
    const result = await listOrdering();
    return ok<OrderingListRes, AppError>(result);
  });

  registerResultHandler('ordering:update', async (event, raw) => {
    const session = await requireSession(event);
    const parsed = OrderingUpdateReq.safeParse(raw ?? {});
    if (!parsed.success) {
      return err(createAppError('ordering.invalidArguments', parsed.error.message));
    }

    try {
      const row = await updateOrderingStatus(parsed.data.id, session.displayName, {
        ordered: parsed.data.ordered,
        comments: parsed.data.comments ?? null
      });
      return ok<OrderingRow, AppError>(row);
    } catch (error) {
      if (error instanceof Error && (error as Error & { code?: string }).code === 'ORDER_LOCKED') {
        return err(createAppError('ordering.locked', 'This material has already been marked as ordered by another user.'));
      }
      const message = error instanceof Error ? error.message : String(error);
      return err(createAppError('ordering.updateFailed', message));
    }
  });

  registerResultHandler('ordering:exportCsv', async () => {
    const { items } = await listOrdering();
    const csv = buildCsv(items);

    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Save Ordering CSV',
      defaultPath: buildTimestampedFilename('csv'),
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    });

    if (canceled || !filePath) {
      return ok<OrderingExportRes, AppError>({ savedPath: null });
    }

    await fs.writeFile(filePath, csv, 'utf8');
    return ok<OrderingExportRes, AppError>({ savedPath: filePath });
  });

  registerResultHandler('ordering:exportPdf', async () => {
    const { items, generatedAt } = await listOrdering();
    const html = buildPdfHtml(items, generatedAt);

    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: false,
        webSecurity: true
      }
    });

    try {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      const pdf = await win.webContents.printToPDF({
        landscape: false,
        pageSize: 'A4',
        printBackground: true
      });

      const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Save Ordering PDF',
        defaultPath: buildTimestampedFilename('pdf'),
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      });

      if (canceled || !filePath) {
        return ok<OrderingExportRes, AppError>({ savedPath: null });
      }

      await fs.writeFile(filePath, pdf);
      return ok<OrderingExportRes, AppError>({ savedPath: filePath });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(createAppError('ordering.exportFailed', message));
    } finally {
      win.destroy();
    }
  });
}
