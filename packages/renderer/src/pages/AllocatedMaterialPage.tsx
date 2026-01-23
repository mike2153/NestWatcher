import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getCoreRowModel,
  getExpandedRowModel,
  getSortedRowModel,
  useReactTable
} from '@tanstack/react-table';
import type { ColumnDef, SortingState, ExpandedState } from '@tanstack/react-table';
import { GlobalTable } from '@/components/table/GlobalTable';
import { Button } from '@/components/ui/button';

import type { AllocatedMaterialRow } from '../../../shared/src';
import { ChevronRight, ChevronDown } from 'lucide-react';

const numberFormatter = new Intl.NumberFormat(undefined, { useGrouping: false });

// Hierarchical row types: Material → Folder → NC File
type MaterialGroupRow = {
  _type: 'material';
  material: string;
  typeData: number | null;
  customerId: string | null;
  preReservedCount: number;
  lockedCount: number;
  stock: number | null;
  stockAvailable: number | null;
  subRows: FolderGroupRow[];
};

type FolderGroupRow = {
  _type: 'folder';
  folder: string;
  material: string;
  preReservedCount: number;
  lockedCount: number;
  subRows: NCFileRow[];
};

type NCFileRow = {
  _type: 'ncfile';
  jobKey: string;
  ncfile: string;
  folder: string;
  material: string;
  preReserved: boolean;
  locked: boolean;
  allocatedAt: string | null;
};

type TableRow = MaterialGroupRow | FolderGroupRow | NCFileRow;

function isMaterialGroupRow(row: TableRow): row is MaterialGroupRow {
  return row._type === 'material';
}

function isFolderGroupRow(row: TableRow): row is FolderGroupRow {
  return row._type === 'folder';
}

function isNCFileRow(row: TableRow): row is NCFileRow {
  return row._type === 'ncfile';
}

const ALLOCATED_COL_PCT = {
  material: 25,
  status: 10,
  stock: 10,
  stockAvailable: 12,
  qtyAllocated: 10,
  allocatedAt: 18,
} as const;

function formatNumber(value: number | null | undefined): string {
  if (value == null) return '';
  return numberFormatter.format(value);
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const day = d.getDate();
  const mon = months[d.getMonth()];
  const year = d.getFullYear();
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12;
  if (h === 0) h = 12;
  return `${day} ${mon} ${year} ${h}:${m}${ampm}`;
}

export function AllocatedMaterialPage() {
  const [rows, setRows] = useState<AllocatedMaterialRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'material', desc: false }]);
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const lastRefreshRef = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await window.api.allocatedMaterial.list();
    if (!res.ok) {
      alert(`Failed to load allocated material: ${res.error.message}`);
      setRows([]);
      setLoading(false);
      return;
    }
    setRows(res.value.items);
    lastRefreshRef.current = Date.now();
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const MIN_GAP_MS = 2_000;
    const unsubscribe = window.api.allocatedMaterial.subscribe(() => {
      const now = Date.now();
      if (now - lastRefreshRef.current < MIN_GAP_MS) {
        return;
      }
      lastRefreshRef.current = now;
      void load();
    });
    return unsubscribe;
  }, [load]);

  // Build hierarchical data structure: Material → Folder → NC File
  const hierarchicalData = useMemo<MaterialGroupRow[]>(() => {
    // Group by material
    const materialMap = new Map<string, {
      typeData: number | null;
      customerId: string | null;
      stock: number | null;
      stockAvailable: number | null;
      folders: Map<string, AllocatedMaterialRow[]>;
    }>();

    for (const row of rows) {
      const materialKey = row.material?.trim() || '__UNKNOWN__';
      if (!materialMap.has(materialKey)) {
        materialMap.set(materialKey, {
          typeData: row.typeData,
          customerId: row.customerId,
          stock: row.stock,
          stockAvailable: row.stockAvailable,
          folders: new Map()
        });
      }

      const materialData = materialMap.get(materialKey)!;
      const folderKey = row.folder?.trim() || '__UNKNOWN__';

      if (!materialData.folders.has(folderKey)) {
        materialData.folders.set(folderKey, []);
      }
      materialData.folders.get(folderKey)!.push(row);
    }

    // Convert to hierarchical structure
    const result: MaterialGroupRow[] = [];

    for (const [material, materialData] of materialMap.entries()) {
      const folderGroups: FolderGroupRow[] = [];
      let materialPreReservedCount = 0;
      let materialLockedCount = 0;

      for (const [folder, folderRows] of materialData.folders.entries()) {
        const ncFiles: NCFileRow[] = folderRows.map(r => ({
          _type: 'ncfile' as const,
          jobKey: r.jobKey,
          ncfile: r.ncfile || 'N/A',
          folder: r.folder || 'N/A',
          material: r.material || 'N/A',
          preReserved: r.jobPreReserved,
          locked: r.jobLocked,
          allocatedAt: r.allocatedAt
        }));

        const folderPreReservedCount = ncFiles.filter(f => f.preReserved).length;
        const folderLockedCount = ncFiles.filter(f => f.locked).length;

        materialPreReservedCount += folderPreReservedCount;
        materialLockedCount += folderLockedCount;

        folderGroups.push({
          _type: 'folder' as const,
          folder,
          material,
          preReservedCount: folderPreReservedCount,
          lockedCount: folderLockedCount,
          subRows: ncFiles
        });
      }

      result.push({
        _type: 'material' as const,
        material,
        typeData: materialData.typeData,
        customerId: materialData.customerId,
        preReservedCount: materialPreReservedCount,
        lockedCount: materialLockedCount,
        stock: materialData.stock,
        stockAvailable: materialData.stockAvailable,
        subRows: folderGroups
      });
    }

    return result;
  }, [rows]);

  const columns = useMemo<ColumnDef<TableRow>[]>(() => [
    {
      id: 'material',
      header: 'Material / Folder / NC File',
      cell: ({ row }) => {
        const original = row.original;
        const depth = row.depth;
        const indent = depth * 24;

        if (isMaterialGroupRow(original)) {
          const label = original.typeData != null
            ? `${original.typeData}${original.customerId ? ` (${original.customerId})` : ''}`
            : original.customerId || 'Unknown';

          return (
            <div style={{ paddingLeft: `${indent}px` }} className="flex items-center gap-2">
              {row.getCanExpand() ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    row.toggleExpanded();
                  }}
                  className="cursor-pointer"
                >
                  {row.getIsExpanded() ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </button>
              ) : null}
              <span className="font-semibold">{label}</span>
            </div>
          );
        }

        if (isFolderGroupRow(original)) {
          return (
            <div style={{ paddingLeft: `${indent}px` }} className="flex items-center gap-2">
              {row.getCanExpand() ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    row.toggleExpanded();
                  }}
                  className="cursor-pointer"
                >
                  {row.getIsExpanded() ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </button>
              ) : null}
              <span className="font-medium">{original.folder}</span>
            </div>
          );
        }

        if (isNCFileRow(original)) {
          return (
            <div style={{ paddingLeft: `${indent}px` }} className="flex items-center gap-2">
              <span className="ml-6">{original.ncfile}</span>
            </div>
          );
        }

        return '';
      },
      meta: { widthPercent: ALLOCATED_COL_PCT.material, minWidthPx: 250 }
    },
    {
      id: 'status',
      header: 'Status',
      cell: ({ row }) => {
        const original = row.original;
        if (isNCFileRow(original)) {
          return original.locked ? 'Locked' : 'Pre-Reserved';
        }
        return '';
      },
      meta: { widthPercent: ALLOCATED_COL_PCT.status, minWidthPx: 120 }
    },
    {
      id: 'stock',
      header: 'Stock',
      cell: ({ row }) => {
        const original = row.original;
        if (isMaterialGroupRow(original)) {
          return formatNumber(original.stock);
        }
        return '';
      },
      meta: { widthPercent: ALLOCATED_COL_PCT.stock, minWidthPx: 80 }
    },
    {
      id: 'stockAvailable',
      header: 'Stock Available',
      cell: ({ row }) => {
        const original = row.original;
        if (isMaterialGroupRow(original)) {
          const total = (original.preReservedCount + original.lockedCount) || 0;
          const stock = original.stock ?? 0;
          const available = stock - total;

          return (
            <span className={available < 0 ? 'text-red-600 font-semibold' : ''}>
              {formatNumber(available)}
            </span>
          );
        }
        return '';
      },
      meta: { widthPercent: ALLOCATED_COL_PCT.stockAvailable, minWidthPx: 120 }
    },
    {
      id: 'qtyAllocated',
      header: 'Qty Allocated',
      cell: ({ row }) => {
        const original = row.original;

        if (isMaterialGroupRow(original)) {
          // For material group rows, show total count
          const total = original.preReservedCount + original.lockedCount;
          return total > 0 ? (
            <span className="font-semibold">{formatNumber(total)}</span>
          ) : '';
        }

        if (isFolderGroupRow(original)) {
          // For folder group rows, show folder total
          const total = original.preReservedCount + original.lockedCount;
          return total > 0 ? (
            <span className="font-medium">{formatNumber(total)}</span>
          ) : '';
        }

        // Don't show quantity for individual NC file rows
        return '';
      },
      meta: { widthPercent: ALLOCATED_COL_PCT.qtyAllocated, minWidthPx: 100 }
    },
    {
      id: 'allocatedAt',
      header: 'Allocated Date',
      cell: ({ row }) => {
        const original = row.original;
        if (isNCFileRow(original)) {
          return formatTimestamp(original.allocatedAt);
        }
        return '';
      },
      meta: { widthPercent: ALLOCATED_COL_PCT.allocatedAt, minWidthPx: 180 }
    }
  ], []);

  const table = useReactTable({
    data: hierarchicalData,
    columns,
    state: { sorting, expanded },
    onSortingChange: setSorting,
    onExpandedChange: setExpanded,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getSubRows: (row) => {
      if (isMaterialGroupRow(row)) return row.subRows;
      if (isFolderGroupRow(row)) return row.subRows;
      return undefined;
    },
    enableRowSelection: false,
    enableColumnResizing: false
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          Showing {rows.length} allocated job{rows.length !== 1 ? 's' : ''} (PENDING status only)
        </div>
        <Button
          type="button"
          size="sm"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </Button>
      </div>

      {hierarchicalData.length === 0 ? (
        <div className="rounded-lg border border-[var(--table-border)] bg-[var(--table-bg)] px-6 py-10 text-center text-muted-foreground">
          {loading ? 'Loading allocated material...' : 'No allocated material found.'}
        </div>
      ) : (
        <GlobalTable
          table={table}
          className="bg-[var(--table-bg)]"
          toggleRowSelectionOnClick={false}
          onRowClick={(row) => {
            if (!row.getCanExpand()) return;
            row.toggleExpanded();
          }}
        />
      )}
    </div>
  );
}
