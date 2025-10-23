import { useMemo } from 'react';
import type { MouseEvent } from 'react';
import { flexRender } from '@tanstack/react-table';
import type { Row, RowData, Table as TableInstance } from '@tanstack/react-table';
import { cn } from '@/utils/cn';

const DEFAULT_ROW_HEIGHT = 50;
const DEFAULT_HEADER_HEIGHT = 40;
const DEFAULT_VIEWPORT_PADDING = 30;

type GlobalTableProps<TData extends RowData> = {
  table: TableInstance<TData>;
  className?: string;
  tableClassName?: string;
  maxHeight?: string;
  stickyHeader?: boolean;
  fillEmptyRows?: boolean;
  minVisibleRows?: number;
  rowHeight?: number;
  headerHeight?: number;
  viewportPadding?: number;
  interactiveRows?: boolean;
  toggleRowSelectionOnClick?: boolean;
  preventContextMenuDefault?: boolean;
  density?: 'normal' | 'compact';
  headerHoverAlways?: boolean;
  onRowClick?: (row: Row<TData>, event: MouseEvent<HTMLTableRowElement>) => void;
  onRowContextMenu?: (row: Row<TData>, event: MouseEvent<HTMLTableRowElement>) => void;
  getRowClassName?: (row: Row<TData>) => string | undefined;
};

export function GlobalTable<TData extends RowData>({
  table,
  className,
  tableClassName,
  maxHeight = 'calc(100vh - 200px)',
  stickyHeader = true,
  fillEmptyRows = true,
  minVisibleRows,
  rowHeight = DEFAULT_ROW_HEIGHT,
  headerHeight = DEFAULT_HEADER_HEIGHT,
  viewportPadding = DEFAULT_VIEWPORT_PADDING,
  interactiveRows = true,
  toggleRowSelectionOnClick = true,
  preventContextMenuDefault = true,
  density = 'normal',
  headerHoverAlways = false,
  onRowClick,
  onRowContextMenu,
  getRowClassName
}: GlobalTableProps<TData>) {
  const rows = table.getRowModel().rows;

  function getWidthClass(meta: unknown): string | undefined {
    return (meta as { widthClass?: string } | undefined)?.widthClass;
  }

  const effectiveMinVisibleRows = useMemo(() => {
    if (!fillEmptyRows) return 0;
    if (typeof minVisibleRows === 'number') {
      return Math.max(0, Math.floor(minVisibleRows));
    }
    if (typeof window === 'undefined') return 0;
    const availableHeight = window.innerHeight - viewportPadding;
    if (availableHeight <= 0) return 0;
    const visible = Math.floor((availableHeight - headerHeight) / rowHeight);
    return visible > 0 ? visible : 0;
  }, [fillEmptyRows, minVisibleRows, rowHeight, headerHeight, viewportPadding]);

  const emptyRowCount = fillEmptyRows ? Math.max(0, effectiveMinVisibleRows - rows.length) : 0;

  const tableStyle = {
    width: '100%',
    tableLayout: 'fixed' as const
  };

  return (
    <div
      className={cn(
        'overflow-auto bg-table text-[var(--table-text)] border border-[var(--table-border)] rounded-lg',
        className
      )}
      style={{ maxHeight }}
    >
      <table className={cn('text-sm table-text', tableClassName)} style={tableStyle}>
        <thead
          className={cn(
            'text-[var(--table-text)] group',
            stickyHeader && 'sticky top-0 z-10'
          )}
          style={{ background: 'var(--table-header-bg)' }}
        >
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id} className="border-b-0 transition-colors group-hover:[background:var(--table-hover-bg)]">
              {headerGroup.headers.map((header) => {
                const dir = header.column.getIsSorted();
                const canSort = header.column.getCanSort();
                return (
                  <th
                    key={header.id}
                    className={cn(
                      'relative text-left align-middle font-medium whitespace-nowrap text-[var(--table-text)] overflow-hidden',
                      density === 'compact' ? 'h-9 px-2 py-1' : 'h-10 px-4 py-2',
                      (headerHoverAlways || canSort) && 'cursor-pointer select-none',
                      header.column.columnDef.meta && getWidthClass(header.column.columnDef.meta)
                    )}
                    onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="truncate font-medium">
                        {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                      </span>
                      {dir === 'asc' && <span className="text-xs text-primary">{'▲'}</span>}
                      {dir === 'desc' && <span className="text-xs text-primary">{'▼'}</span>}
                    </div>
                    {header.column.getCanResize() && (
                      <div
                        onMouseDown={header.getResizeHandler()}
                        onTouchStart={header.getResizeHandler()}
                        className={cn(
                          'absolute right-0 top-0 h-full w-1 cursor-col-resize select-none hover:bg-[var(--primary-a20)] transition-colors',
                          header.column.getIsResizing() && 'bg-primary'
                        )}
                      />
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className={cn(
                'border-b border-[var(--table-row-border)] hover:[background:var(--table-hover-bg)] transition-colors',
                interactiveRows && 'cursor-pointer',
                row.getIsSelected() && '[background:var(--table-selected-bg)] data-[state=selected]:[background:var(--table-selected-bg)]',
                getRowClassName?.(row)
              )}
              onClick={(event) => {
                if (toggleRowSelectionOnClick) {
                  row.toggleSelected();
                }
                onRowClick?.(row, event);
              }}
              onContextMenu={(event) => {
                if (preventContextMenuDefault) {
                  event.preventDefault();
                }
                onRowContextMenu?.(row, event);
              }}
            >
              {row.getVisibleCells().map((cell) => (
                <td
                  key={cell.id}
                  className={cn(
                    'align-middle whitespace-nowrap font-medium overflow-hidden',
                    density === 'compact' ? 'px-2 py-1' : 'px-4 py-2',
                    cell.column.columnDef.meta && getWidthClass(cell.column.columnDef.meta)
                  )}
                >
                  <div className="min-w-0 truncate overflow-hidden text-ellipsis">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </div>
                </td>
              ))}
            </tr>
          ))}
          {Array.from({ length: emptyRowCount }).map((_, index) => (
            <tr key={`empty-${index}`} className="border-b border-[var(--table-row-border)]">
              {table.getVisibleFlatColumns().map((column) => (
                <td
                  key={column.id}
                  className={cn('px-4 py-3 align-middle whitespace-nowrap overflow-hidden', getWidthClass(column.columnDef.meta))}
                >
                  &nbsp;
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
