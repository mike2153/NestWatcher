import { useEffect, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { ChevronDown, FileText, FileSpreadsheet } from 'lucide-react';
import type { ValidationDataRes, AggregatedValidationDataRes } from '../../../shared/src';

type ValidationDataModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobKey: string | null;
  jobKeys?: string[] | null;
};

function formatSeconds(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const parts = [] as string[];
  if (hrs) parts.push(`${hrs}h`);
  if (mins) parts.push(`${mins}m`);
  if (secs || parts.length === 0) parts.push(`${secs}s`);
  return parts.join(' ');
}

function formatNumber(value: number | null, fractionDigits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toFixed(fractionDigits);
}

// Threshold: 10,000 cm³ = 0.01 m³
const VOLUME_THRESHOLD_CM3 = 10_000;

/**
 * Smart volume formatter that switches from cm³ to m³ when value exceeds threshold.
 * Input is in m³, converts to cm³ for display unless above threshold.
 */
function formatVolume(valueM3: number | null, fractionDigits = 2): string {
  if (valueM3 == null || !Number.isFinite(valueM3)) return '—';

  const valueCm3 = valueM3 * 1_000_000;

  if (valueCm3 >= VOLUME_THRESHOLD_CM3) {
    // Display in m³
    return `${valueM3.toLocaleString(undefined, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })} m³`;
  }
  // Display in cm³
  return `${valueCm3.toLocaleString(undefined, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })} cm³`;
}

/**
 * Format volume for table cells - returns object with value and unit for flexible display
 */
function formatVolumeForTable(valueM3: number | null, fractionDigits = 2): { value: string; unit: string } {
  if (valueM3 == null || !Number.isFinite(valueM3)) return { value: '—', unit: '' };

  const valueCm3 = valueM3 * 1_000_000;

  if (valueCm3 >= VOLUME_THRESHOLD_CM3) {
    return {
      value: valueM3.toLocaleString(undefined, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }),
      unit: 'm³'
    };
  }
  return {
    value: valueCm3.toLocaleString(undefined, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }),
    unit: 'cm³'
  };
}

// PDF Generation
function generatePDF(
  data: ValidationDataRes | null,
  aggregatedData: AggregatedValidationDataRes | null,
  jobKey: string | null,
  jobKeys: string[] | null
) {
  const isAggregated = jobKeys && jobKeys.length > 1;
  const title = isAggregated ? 'NC File Statistics Report' : 'MES Data Report';
  const subtitle = isAggregated
    ? `Aggregated data for ${aggregatedData?.jobCount ?? jobKeys.length} jobs`
    : `Job: ${jobKey}`;
  const date = new Date().toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  // Build HTML content for PDF
  let html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>${title}</title>
      <style>
        @page { size: A4; margin: 20mm; }
        * { box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          color: #1a1a1a;
          line-height: 1.5;
          font-size: 11pt;
          margin: 0;
          padding: 0;
        }
        .header {
          border-bottom: 2px solid #2563eb;
          padding-bottom: 16px;
          margin-bottom: 24px;
        }
        .header h1 {
          margin: 0 0 4px 0;
          font-size: 24pt;
          color: #1e3a5f;
          font-weight: 600;
        }
        .header .subtitle {
          color: #64748b;
          font-size: 12pt;
          margin: 0;
        }
        .header .date {
          color: #94a3b8;
          font-size: 10pt;
          margin-top: 8px;
        }
        .section {
          margin-bottom: 20px;
        }
        .section-title {
          font-size: 13pt;
          font-weight: 600;
          color: #1e3a5f;
          margin: 0 0 12px 0;
          padding-bottom: 6px;
          border-bottom: 1px solid #e2e8f0;
        }
        .summary-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 12px;
          margin-bottom: 20px;
        }
        .summary-card {
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          padding: 12px 16px;
        }
        .summary-card .label {
          font-size: 9pt;
          color: #64748b;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          margin-bottom: 4px;
        }
        .summary-card .value {
          font-size: 16pt;
          font-weight: 600;
          color: #1e3a5f;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          font-size: 10pt;
          margin-bottom: 16px;
        }
        th, td {
          padding: 8px 12px;
          text-align: left;
          border-bottom: 1px solid #e2e8f0;
        }
        th {
          background: #f1f5f9;
          font-weight: 600;
          color: #475569;
          font-size: 9pt;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        tr:nth-child(even) td {
          background: #fafafa;
        }
        .jobs-list {
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          padding: 12px 16px;
          max-height: 150px;
          overflow: hidden;
          font-size: 9pt;
          color: #64748b;
        }
        .jobs-list ul {
          margin: 0;
          padding-left: 16px;
          columns: 2;
          column-gap: 24px;
        }
        .jobs-list li {
          margin-bottom: 2px;
        }
        .badge {
          display: inline-block;
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 9pt;
          font-weight: 500;
        }
        .badge-green { background: #dcfce7; color: #166534; }
        .badge-red { background: #fee2e2; color: #991b1b; }
        .footer {
          margin-top: 32px;
          padding-top: 16px;
          border-top: 1px solid #e2e8f0;
          text-align: center;
          font-size: 9pt;
          color: #94a3b8;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>${title}</h1>
        <p class="subtitle">${subtitle}</p>
        <p class="date">Generated: ${date}</p>
      </div>
  `;

  if (isAggregated && aggregatedData) {
    // Jobs list
    html += `
      <div class="section">
        <h2 class="section-title">Jobs Included (${jobKeys.length})</h2>
        <div class="jobs-list">
          <ul>
            ${jobKeys.slice(0, 20).map(k => `<li>${k}</li>`).join('')}
            ${jobKeys.length > 20 ? `<li>... and ${jobKeys.length - 20} more</li>` : ''}
          </ul>
        </div>
      </div>
    `;

    // Summary cards
    html += `
      <div class="section">
        <h2 class="section-title">Summary</h2>
        <div class="summary-grid">
          <div class="summary-card">
            <div class="label">Total Runtime</div>
            <div class="value">${formatSeconds(aggregatedData.totalNcEstRuntime)}</div>
          </div>
          <div class="summary-card">
            <div class="label">Average Yield</div>
            <div class="value">${formatNumber(aggregatedData.avgYieldPercentage, 2)}%</div>
          </div>
          <div class="summary-card">
            <div class="label">Total Cutting Distance</div>
            <div class="value">${formatNumber(aggregatedData.totalCuttingDistanceMeters, 2)} m</div>
          </div>
          <div class="summary-card">
            <div class="label">Total Waste Offcut</div>
            <div class="value">${formatNumber(aggregatedData.totalWasteOffcutM2, 2)} m²</div>
          </div>
        </div>
      </div>
    `;

    // Combined Tool & Drill Usage table
    const hasTools = aggregatedData.toolUsage?.length > 0;
    const hasDrills = aggregatedData.drillUsage?.length > 0;

    if (hasTools || hasDrills) {
      html += `
        <div class="section">
          <h2 class="section-title">Tool & Drill Usage</h2>
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>#</th>
                <th>Name</th>
                <th>Holes</th>
                <th>Distance (m)</th>
                <th>Dust</th>
              </tr>
            </thead>
            <tbody>
      `;

      if (hasTools) {
        for (const tool of aggregatedData.toolUsage) {
          const dust = formatVolumeForTable(tool.toolDustM3);
          html += `
            <tr>
              <td>Tool</td>
              <td>${tool.toolNumber}</td>
              <td>${tool.toolName}</td>
              <td>—</td>
              <td>${formatNumber(tool.cuttingDistanceMeters, 2)}</td>
              <td>${dust.value} ${dust.unit}</td>
            </tr>
          `;
        }
      }

      if (hasDrills) {
        for (const drill of aggregatedData.drillUsage) {
          const dust = formatVolumeForTable(drill.drillDustM3);
          html += `
            <tr>
              <td>Drill</td>
              <td>${drill.drillNumber}</td>
              <td>${drill.drillName}</td>
              <td>${drill.holeCount}</td>
              <td>${formatNumber(drill.drillDistanceMeters, 2)}</td>
              <td>${dust.value} ${dust.unit}</td>
            </tr>
          `;
        }
      }

      html += `
            </tbody>
          </table>
        </div>
      `;
    }

    // Dust Summary
    html += `
      <div class="section">
        <h2 class="section-title">Dust & Material Summary</h2>
        <div class="summary-grid">
          <div class="summary-card">
            <div class="label">Total Waste Offcut Dust</div>
            <div class="value">${formatVolume(aggregatedData.totalWasteOffcutDustM3)}</div>
          </div>
          <div class="summary-card">
            <div class="label">Total Tool Dust</div>
            <div class="value">${formatVolume(aggregatedData.totalToolDustM3)}</div>
          </div>
          <div class="summary-card">
            <div class="label">Total Drill Dust</div>
            <div class="value">${formatVolume(aggregatedData.totalDrillDustM3)}</div>
          </div>
          <div class="summary-card">
            <div class="label">Total Sheet Dust</div>
            <div class="value">${formatVolume(aggregatedData.totalSheetDustM3)}</div>
          </div>
        </div>
      </div>
    `;

    // NestPick
    html += `
      <div class="section">
        <h2 class="section-title">NestPick Summary</h2>
        <div class="summary-grid">
          <div class="summary-card">
            <div class="label">All Parts Pickable</div>
            <div class="value">
              <span class="badge ${aggregatedData.allPartsPickable ? 'badge-green' : 'badge-red'}">
                ${aggregatedData.allPartsPickable ? 'Yes' : 'No'}
              </span>
            </div>
          </div>
          <div class="summary-card">
            <div class="label">Total Pallet Adjusted Volume</div>
            <div class="value">${formatNumber(aggregatedData.totalPalletAdjustedVolumeM3, 5)} m³</div>
          </div>
        </div>
      </div>
    `;
  } else if (data) {
    // Single job view
    if (data.mesOutputVersion) {
      html += `<p style="color: #94a3b8; font-size: 9pt; margin-bottom: 16px;">MES version ${data.mesOutputVersion}</p>`;
    }

    html += `
      <div class="section">
        <h2 class="section-title">Summary</h2>
        <div class="summary-grid">
          <div class="summary-card">
            <div class="label">Estimated Runtime</div>
            <div class="value">${formatSeconds(data.ncEstRuntime)}</div>
          </div>
          <div class="summary-card">
            <div class="label">Yield</div>
            <div class="value">${formatNumber(data.yieldPercentage, 2)}%</div>
          </div>
          <div class="summary-card">
            <div class="label">Cutting Distance</div>
            <div class="value">${formatNumber(data.cuttingDistanceMeters, 2)} m</div>
          </div>
          <div class="summary-card">
            <div class="label">Waste Offcut</div>
            <div class="value">${formatNumber(data.wasteOffcutM2, 2)} m²</div>
          </div>
        </div>
      </div>
    `;

    // Combined Tool & Drill Usage table
    const hasTools = data.toolUsage?.length > 0;
    const hasDrills = data.drillUsage?.length > 0;

    if (hasTools || hasDrills) {
      html += `
        <div class="section">
          <h2 class="section-title">Tool & Drill Usage</h2>
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>#</th>
                <th>Name</th>
                <th>Holes</th>
                <th>Distance (m)</th>
                <th>Dust</th>
              </tr>
            </thead>
            <tbody>
      `;

      if (hasTools) {
        for (const tool of data.toolUsage) {
          const dust = formatVolumeForTable(tool.toolDustM3);
          html += `
            <tr>
              <td>Tool</td>
              <td>${tool.toolNumber}</td>
              <td>${tool.toolName}</td>
              <td>—</td>
              <td>${formatNumber(tool.cuttingDistanceMeters, 2)}</td>
              <td>${dust.value} ${dust.unit}</td>
            </tr>
          `;
        }
      }

      if (hasDrills) {
        for (const drill of data.drillUsage) {
          const dust = formatVolumeForTable(drill.drillDustM3);
          html += `
            <tr>
              <td>Drill</td>
              <td>${drill.drillNumber}</td>
              <td>${drill.drillName}</td>
              <td>${drill.holeCount}</td>
              <td>${formatNumber(drill.drillDistanceMeters, 2)}</td>
              <td>${dust.value} ${dust.unit}</td>
            </tr>
          `;
        }
      }

      html += `
            </tbody>
          </table>
        </div>
      `;
    }

    // Dust Summary
    html += `
      <div class="section">
        <h2 class="section-title">Dust Summary</h2>
        <div class="summary-grid">
          <div class="summary-card">
            <div class="label">Waste Offcut Dust</div>
            <div class="value">${formatVolume(data.wasteOffcutDustM3)}</div>
          </div>
          <div class="summary-card">
            <div class="label">Total Tool Dust</div>
            <div class="value">${formatVolume(data.totalToolDustM3)}</div>
          </div>
          <div class="summary-card">
            <div class="label">Total Drill Dust</div>
            <div class="value">${formatVolume(data.totalDrillDustM3)}</div>
          </div>
          <div class="summary-card">
            <div class="label">Total Sheet Dust</div>
            <div class="value">${formatVolume(data.sheetTotalDustM3)}</div>
          </div>
        </div>
      </div>
    `;

    // NestPick
    if (data.nestPick) {
      html += `
        <div class="section">
          <h2 class="section-title">NestPick</h2>
          <div class="summary-grid">
            <div class="summary-card">
              <div class="label">All Parts Pickable</div>
              <div class="value">
                <span class="badge ${data.nestPick.canAllBePicked ? 'badge-green' : 'badge-red'}">
                  ${data.nestPick.canAllBePicked ? 'Yes' : 'No'}
                </span>
              </div>
            </div>
            <div class="summary-card">
              <div class="label">Failed Parts</div>
              <div class="value">${data.nestPick.failedParts.length}</div>
            </div>
            <div class="summary-card">
              <div class="label">Oversized Parts</div>
              <div class="value">${data.nestPick.partsTooLargeForPallet.length}</div>
            </div>
            <div class="summary-card">
              <div class="label">Pallet Adjusted Volume</div>
              <div class="value">${formatNumber(data.nestPick.palletAdjustedVolumeM3, 5)} m³</div>
            </div>
          </div>
        </div>
      `;
    }

    // Usable Offcuts
    if (data.usableOffcuts?.length) {
      html += `
        <div class="section">
          <h2 class="section-title">Usable Offcuts</h2>
          <table>
            <thead>
              <tr>
                <th>X (mm)</th>
                <th>Y (mm)</th>
                <th>Z (mm)</th>
              </tr>
            </thead>
            <tbody>
              ${data.usableOffcuts.map(o => `
                <tr>
                  <td>${o.x}</td>
                  <td>${o.y}</td>
                  <td>${o.z}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }
  }

  html += `
      <div class="footer">
        Generated by NestWatcher
      </div>
    </body>
    </html>
  `;

  // Create an iframe for printing (works in Electron)
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = 'none';
  document.body.appendChild(iframe);

  const iframeDoc = iframe.contentWindow?.document;
  if (iframeDoc) {
    iframeDoc.open();
    iframeDoc.write(html);
    iframeDoc.close();

    // Wait for content to render, then print
    setTimeout(() => {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
      // Remove iframe after printing
      setTimeout(() => {
        document.body.removeChild(iframe);
      }, 1000);
    }, 250);
  }
}

// CSV Generation
function generateCSV(
  data: ValidationDataRes | null,
  aggregatedData: AggregatedValidationDataRes | null,
  jobKey: string | null,
  jobKeys: string[] | null
) {
  const isAggregated = jobKeys && jobKeys.length > 1;
  const rows: string[][] = [];

  // Helper to escape CSV values
  const escape = (val: unknown): string => {
    if (val == null) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  if (isAggregated && aggregatedData) {
    // Header info
    rows.push(['NC File Statistics Report']);
    rows.push([`Generated: ${new Date().toLocaleDateString('en-AU')}`]);
    rows.push([`Jobs: ${aggregatedData.jobCount}`]);
    rows.push([]);

    // Summary
    rows.push(['Summary']);
    rows.push(['Metric', 'Value']);
    rows.push(['Total Runtime', formatSeconds(aggregatedData.totalNcEstRuntime)]);
    rows.push(['Average Yield (%)', formatNumber(aggregatedData.avgYieldPercentage, 2)]);
    rows.push(['Total Cutting Distance (m)', formatNumber(aggregatedData.totalCuttingDistanceMeters, 2)]);
    rows.push(['Total Waste Offcut (m²)', formatNumber(aggregatedData.totalWasteOffcutM2, 2)]);
    rows.push(['All Parts Pickable', aggregatedData.allPartsPickable ? 'Yes' : 'No']);
    rows.push(['Total Pallet Adjusted Volume (m³)', formatNumber(aggregatedData.totalPalletAdjustedVolumeM3, 5)]);
    rows.push([]);

    // Tool Usage
    if (aggregatedData.toolUsage?.length) {
      rows.push(['Tool Usage']);
      rows.push(['Type', 'Number', 'Name', 'Distance (m)', 'Dust (m³)']);
      for (const tool of aggregatedData.toolUsage) {
        rows.push(['Tool', tool.toolNumber, tool.toolName, formatNumber(tool.cuttingDistanceMeters, 2), formatNumber(tool.toolDustM3, 6)]);
      }
      rows.push([]);
    }

    // Drill Usage
    if (aggregatedData.drillUsage?.length) {
      rows.push(['Drill Usage']);
      rows.push(['Type', 'Number', 'Name', 'Holes', 'Distance (m)', 'Dust (m³)']);
      for (const drill of aggregatedData.drillUsage) {
        rows.push(['Drill', drill.drillNumber, drill.drillName, String(drill.holeCount), formatNumber(drill.drillDistanceMeters, 2), formatNumber(drill.drillDustM3, 6)]);
      }
      rows.push([]);
    }

    // Dust Summary
    rows.push(['Dust Summary']);
    rows.push(['Metric', 'Value (m³)']);
    rows.push(['Total Waste Offcut Dust', formatNumber(aggregatedData.totalWasteOffcutDustM3, 6)]);
    rows.push(['Total Tool Dust', formatNumber(aggregatedData.totalToolDustM3, 6)]);
    rows.push(['Total Drill Dust', formatNumber(aggregatedData.totalDrillDustM3, 6)]);
    rows.push(['Total Sheet Dust', formatNumber(aggregatedData.totalSheetDustM3, 6)]);
    rows.push([]);

    // Jobs list
    rows.push(['Jobs Included']);
    for (const key of jobKeys) {
      rows.push([key]);
    }
  } else if (data) {
    // Single job
    rows.push(['MES Data Report']);
    rows.push([`Job: ${jobKey}`]);
    rows.push([`Generated: ${new Date().toLocaleDateString('en-AU')}`]);
    if (data.mesOutputVersion) {
      rows.push([`MES Version: ${data.mesOutputVersion}`]);
    }
    rows.push([]);

    // Summary
    rows.push(['Summary']);
    rows.push(['Metric', 'Value']);
    rows.push(['Estimated Runtime', formatSeconds(data.ncEstRuntime)]);
    rows.push(['Yield (%)', formatNumber(data.yieldPercentage, 2)]);
    rows.push(['Cutting Distance (m)', formatNumber(data.cuttingDistanceMeters, 2)]);
    rows.push(['Waste Offcut (m²)', formatNumber(data.wasteOffcutM2, 2)]);
    rows.push([]);

    // Tool Usage
    if (data.toolUsage?.length) {
      rows.push(['Tool Usage']);
      rows.push(['Number', 'Name', 'Distance (m)', 'Dust (m³)']);
      for (const tool of data.toolUsage) {
        rows.push([tool.toolNumber, tool.toolName, formatNumber(tool.cuttingDistanceMeters, 2), formatNumber(tool.toolDustM3, 6)]);
      }
      rows.push([]);
    }

    // Drill Usage
    if (data.drillUsage?.length) {
      rows.push(['Drill Usage']);
      rows.push(['Number', 'Name', 'Holes', 'Distance (m)', 'Dust (m³)']);
      for (const drill of data.drillUsage) {
        rows.push([drill.drillNumber, drill.drillName, String(drill.holeCount), formatNumber(drill.drillDistanceMeters, 2), formatNumber(drill.drillDustM3, 6)]);
      }
      rows.push([]);
    }

    // Dust Summary
    rows.push(['Dust Summary']);
    rows.push(['Metric', 'Value (m³)']);
    rows.push(['Waste Offcut Dust', formatNumber(data.wasteOffcutDustM3, 6)]);
    rows.push(['Total Tool Dust', formatNumber(data.totalToolDustM3, 6)]);
    rows.push(['Total Drill Dust', formatNumber(data.totalDrillDustM3, 6)]);
    rows.push(['Total Sheet Dust', formatNumber(data.sheetTotalDustM3, 6)]);
    rows.push([]);

    // NestPick
    if (data.nestPick) {
      rows.push(['NestPick']);
      rows.push(['All Parts Pickable', data.nestPick.canAllBePicked ? 'Yes' : 'No']);
      rows.push(['Failed Parts', String(data.nestPick.failedParts.length)]);
      rows.push(['Oversized Parts', String(data.nestPick.partsTooLargeForPallet.length)]);
      rows.push(['Pallet Adjusted Volume (m³)', formatNumber(data.nestPick.palletAdjustedVolumeM3, 5)]);
      rows.push([]);
    }

    // Usable Offcuts
    if (data.usableOffcuts?.length) {
      rows.push(['Usable Offcuts']);
      rows.push(['X (mm)', 'Y (mm)', 'Z (mm)']);
      for (const offcut of data.usableOffcuts) {
        rows.push([String(offcut.x), String(offcut.y), String(offcut.z)]);
      }
    }
  }

  // Generate CSV string
  const csv = rows.map(row => row.map(escape).join(',')).join('\n');

  // Download
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = isAggregated
    ? `nc-stats-${aggregatedData?.jobCount ?? jobKeys?.length ?? 0}-jobs-${new Date().toISOString().split('T')[0]}.csv`
    : `mes-data-${jobKey?.replace(/[/\\:]/g, '-') ?? 'export'}-${new Date().toISOString().split('T')[0]}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function ValidationDataModal({ open, onOpenChange, jobKey, jobKeys }: ValidationDataModalProps) {
  const [data, setData] = useState<ValidationDataRes | null>(null);
  const [aggregatedData, setAggregatedData] = useState<AggregatedValidationDataRes | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAggregated = jobKeys && jobKeys.length > 1;

  useEffect(() => {
    let cancelled = false;
    if (!open) return undefined;

    // Reset state
    setLoading(true);
    setError(null);
    setData(null);
    setAggregatedData(null);

    if (isAggregated) {
      // Fetch aggregated data for multiple jobs
      window.api.validation
        .getAggregatedData({ keys: jobKeys })
        .then((res) => {
          if (cancelled) return;
          if (!res.ok) {
            setError(res.error.message);
            return;
          }
          setAggregatedData(res.value);
        })
        .catch((err) => {
          if (cancelled) return;
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    } else if (jobKey) {
      // Fetch single job data
      window.api.validation
        .getData({ key: jobKey })
        .then((res) => {
          if (cancelled) return;
          if (!res.ok) {
            setError(res.error.message);
            return;
          }
          setData(res.value);
        })
        .catch((err) => {
          if (cancelled) return;
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    } else {
      setLoading(false);
    }

    return () => {
      cancelled = true;
    };
  }, [open, jobKey, jobKeys, isAggregated]);

  const handleExportPDF = () => {
    generatePDF(data, aggregatedData, jobKey, jobKeys ?? null);
  };

  const handleExportCSV = () => {
    generateCSV(data, aggregatedData, jobKey, jobKeys ?? null);
  };

  const canExport = !loading && !error && (data || aggregatedData);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-[880px] max-w-[95vw] overflow-y-auto">
          <SheetHeader>
            <div className="flex items-center justify-between gap-4">
              <SheetTitle>{isAggregated ? 'Aggregated Job Stats' : 'Job Stats'}</SheetTitle>
              <div className="flex items-center gap-3">
                {isAggregated && aggregatedData && (
                  <span className="text-lg font-semibold text-muted-foreground">{aggregatedData.jobCount} jobs</span>
                )}
              <div className="relative">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" disabled={!canExport}>
                      Export
                      <ChevronDown className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={handleExportPDF}>
                      <FileText className="h-4 w-4 mr-2" />
                      Export as PDF
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={handleExportCSV}>
                      <FileSpreadsheet className="h-4 w-4 mr-2" />
                      Export as CSV
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>
          {!isAggregated && (
            <SheetDescription>{jobKey ? `Job: ${jobKey}` : 'Select a job to view MES data'}</SheetDescription>
          )}
        </SheetHeader>

        <div className="mt-4 space-y-4">
          {loading && <p className="text-sm text-muted-foreground">Loading...</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {!loading && !error && !data && !aggregatedData && (
            <p className="text-sm text-muted-foreground">No stats available.</p>
          )}

          {isAggregated && aggregatedData ? (
            <AggregatedContent data={aggregatedData} jobKeys={jobKeys} />
          ) : data ? (
            <SingleJobContent data={data} />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SingleJobContent({ data }: { data: ValidationDataRes }) {
  return (
    <div className="space-y-6">
      {data.mesOutputVersion ? (
        <span className="text-xs text-muted-foreground">MES version {data.mesOutputVersion}</span>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <SummaryCard label="Estimated Runtime" value={formatSeconds(data.ncEstRuntime)} />
        <SummaryCard label="Yield" value={`${formatNumber(data.yieldPercentage, 2)} %`} />
        <SummaryCard label="Cutting Distance" value={`${formatNumber(data.cuttingDistanceMeters, 2)} m`} />
        <SummaryCard label="Waste Offcut" value={`${formatNumber(data.wasteOffcutM2, 2)} m²`} />
      </div>

      {data.toolUsage?.length ? (
        <div className="space-y-2">
          <p className="text-sm font-semibold">Tool Usage</p>
          <table className="w-full text-sm border border-border rounded">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-3 py-2">#</th>
                <th className="text-left px-3 py-2">Tool</th>
                <th className="text-left px-3 py-2">Distance (m)</th>
                <th className="text-left px-3 py-2">Dust</th>
              </tr>
            </thead>
            <tbody>
              {data.toolUsage.map((tool, idx) => {
                const dust = formatVolumeForTable(tool.toolDustM3);
                return (
                  <tr key={`${tool.toolNumber}-${idx}`} className="border-t border-border">
                    <td className="px-3 py-2">{tool.toolNumber}</td>
                    <td className="px-3 py-2">{tool.toolName}</td>
                    <td className="px-3 py-2">{formatNumber(tool.cuttingDistanceMeters, 2)}</td>
                    <td className="px-3 py-2">{dust.value} {dust.unit}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {data.drillUsage?.length ? (
        <div className="space-y-2">
          <p className="text-sm font-semibold">Drill Usage</p>
          <table className="w-full text-sm border border-border rounded">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-3 py-2">#</th>
                <th className="text-left px-3 py-2">Drill</th>
                <th className="text-left px-3 py-2">Holes</th>
                <th className="text-left px-3 py-2">Distance (m)</th>
                <th className="text-left px-3 py-2">Dust</th>
              </tr>
            </thead>
            <tbody>
              {data.drillUsage.map((drill, idx) => {
                const dust = formatVolumeForTable(drill.drillDustM3);
                return (
                  <tr key={`${drill.drillNumber}-${idx}`} className="border-t border-border">
                    <td className="px-3 py-2">{drill.drillNumber}</td>
                    <td className="px-3 py-2">{drill.drillName}</td>
                    <td className="px-3 py-2">{drill.holeCount}</td>
                    <td className="px-3 py-2">{formatNumber(drill.drillDistanceMeters, 2)}</td>
                    <td className="px-3 py-2">{dust.value} {dust.unit}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {data.nestPick ? (
        <div className="space-y-2">
          <p className="text-sm font-semibold">NestPick</p>
          <div className="rounded border p-3 text-sm space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">All parts pickable:</span>
              <Badge
                variant={data.nestPick.canAllBePicked ? 'default' : 'destructive'}
                className={data.nestPick.canAllBePicked ? 'bg-green-600 hover:bg-green-600/80' : ''}
              >
                {data.nestPick.canAllBePicked ? 'Yes' : 'No'}
              </Badge>
            </div>
            <div>
              <span className="font-medium">Failed parts:</span>{' '}
              {data.nestPick.failedParts.length ? data.nestPick.failedParts.length : '0'}
            </div>
            <div>
              <span className="font-medium">Oversized parts:</span>{' '}
              {data.nestPick.partsTooLargeForPallet.length ? data.nestPick.partsTooLargeForPallet.length : '0'}
            </div>
            <div>
              <span className="font-medium">Pallet Adjusted Volume:</span>{' '}
              {formatNumber(data.nestPick.palletAdjustedVolumeM3, 5)} m³
            </div>
          </div>
        </div>
      ) : null}

      {data.usableOffcuts?.length ? (
        <div className="space-y-2">
          <p className="text-sm font-semibold">Usable Offcuts</p>
          <table className="w-full text-sm border border-border rounded">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-3 py-2">X (mm)</th>
                <th className="text-left px-3 py-2">Y (mm)</th>
                <th className="text-left px-3 py-2">Z (mm)</th>
              </tr>
            </thead>
            <tbody>
              {data.usableOffcuts.map((offcut, idx) => (
                <tr key={`${offcut.x}-${offcut.y}-${offcut.z}-${idx}`} className="border-t border-border">
                  <td className="px-3 py-2">{offcut.x}</td>
                  <td className="px-3 py-2">{offcut.y}</td>
                  <td className="px-3 py-2">{offcut.z}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <SummaryCard label="Waste Offcut Dust" value={formatVolume(data.wasteOffcutDustM3)} />
        <SummaryCard label="Total Tool Dust" value={formatVolume(data.totalToolDustM3)} />
        <SummaryCard label="Total Drill Dust" value={formatVolume(data.totalDrillDustM3)} />
        <SummaryCard label="Total Sheet Dust" value={formatVolume(data.sheetTotalDustM3)} />
      </div>
    </div>
  );
}

function AggregatedContent({ data, jobKeys }: { data: AggregatedValidationDataRes; jobKeys: string[] }) {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-sm font-semibold">Jobs Included</p>
        <div className="rounded border p-3 text-sm max-h-32 overflow-y-auto">
          <ul className="space-y-1">
            {jobKeys.map((key) => (
              <li key={key} className="text-muted-foreground">{key}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <SummaryCard label="Total Runtime" value={formatSeconds(data.totalNcEstRuntime)} />
        <SummaryCard label="Avg Yield" value={`${formatNumber(data.avgYieldPercentage, 2)} %`} />
        <SummaryCard label="Total Cutting Distance" value={`${formatNumber(data.totalCuttingDistanceMeters, 2)} m`} />
        <SummaryCard label="Total Waste Offcut" value={`${formatNumber(data.totalWasteOffcutM2, 2)} m²`} />
      </div>

      {data.toolUsage?.length ? (
        <div className="space-y-2">
          <p className="text-sm font-semibold">Aggregated Tool Usage</p>
          <table className="w-full text-sm border border-border rounded">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-3 py-2">#</th>
                <th className="text-left px-3 py-2">Tool</th>
                <th className="text-left px-3 py-2">Total Distance (m)</th>
                <th className="text-left px-3 py-2">Total Dust</th>
              </tr>
            </thead>
            <tbody>
              {data.toolUsage.map((tool, idx) => {
                const dust = formatVolumeForTable(tool.toolDustM3);
                return (
                  <tr key={`${tool.toolNumber}-${idx}`} className="border-t border-border">
                    <td className="px-3 py-2">{tool.toolNumber}</td>
                    <td className="px-3 py-2">{tool.toolName}</td>
                    <td className="px-3 py-2">{formatNumber(tool.cuttingDistanceMeters, 2)}</td>
                    <td className="px-3 py-2">{dust.value} {dust.unit}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {data.drillUsage?.length ? (
        <div className="space-y-2">
          <p className="text-sm font-semibold">Aggregated Drill Usage</p>
          <table className="w-full text-sm border border-border rounded">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-3 py-2">#</th>
                <th className="text-left px-3 py-2">Drill</th>
                <th className="text-left px-3 py-2">Total Holes</th>
                <th className="text-left px-3 py-2">Total Distance (m)</th>
                <th className="text-left px-3 py-2">Total Dust</th>
              </tr>
            </thead>
            <tbody>
              {data.drillUsage.map((drill, idx) => {
                const dust = formatVolumeForTable(drill.drillDustM3);
                return (
                  <tr key={`${drill.drillNumber}-${idx}`} className="border-t border-border">
                    <td className="px-3 py-2">{drill.drillNumber}</td>
                    <td className="px-3 py-2">{drill.drillName}</td>
                    <td className="px-3 py-2">{drill.holeCount}</td>
                    <td className="px-3 py-2">{formatNumber(drill.drillDistanceMeters, 2)}</td>
                    <td className="px-3 py-2">{dust.value} {dust.unit}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="space-y-2">
        <p className="text-sm font-semibold">NestPick Summary</p>
        <div className="rounded border p-3 text-sm space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">All parts pickable:</span>
            <Badge
              variant={data.allPartsPickable ? 'default' : 'destructive'}
              className={data.allPartsPickable ? 'bg-green-600 hover:bg-green-600/80' : ''}
            >
              {data.allPartsPickable ? 'Yes' : 'No'}
            </Badge>
          </div>
          <div>
            <span className="font-medium">Total Pallet Adjusted Volume:</span>{' '}
            {formatNumber(data.totalPalletAdjustedVolumeM3, 5)} m³
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <SummaryCard label="Total Waste Offcut Dust" value={formatVolume(data.totalWasteOffcutDustM3)} />
        <SummaryCard label="Total Tool Dust" value={formatVolume(data.totalToolDustM3)} />
        <SummaryCard label="Total Drill Dust" value={formatVolume(data.totalDrillDustM3)} />
        <SummaryCard label="Total Sheet Dust" value={formatVolume(data.totalSheetDustM3)} />
      </div>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border bg-muted/30 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}
