import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import {
  JOB_COLUMN_LABELS,
  ROUTER_COLUMN_LABELS,
  TABLE_VIEW_PREFS_UPDATED_EVENT,
  createDefaultJobsTableColumns,
  createDefaultRouterTableColumns,
  emitTableViewPrefsUpdated,
  loadTableViewPrefsForUser,
  saveTableViewPrefsForUser,
  type JobsTableColumnKey,
  type JobsTableColumns,
  type RouterTableColumnKey,
  type RouterTableColumns,
  type UserTableViewPrefs
} from '@/lib/tableViewPrefs';

type ColumnPref = { visible: boolean; order: number };

function normalizeLocalOrders<T extends string>(
  columns: Record<T, ColumnPref>,
  keys: readonly T[]
): Record<T, ColumnPref> {
  const next = { ...columns } as Record<T, ColumnPref>;

  const visible = keys
    .filter((key) => next[key].visible)
    .sort((a, b) => {
      const orderDiff = next[a].order - next[b].order;
      if (orderDiff !== 0) return orderDiff;
      return keys.indexOf(a) - keys.indexOf(b);
    });
  const hidden = keys.filter((key) => !next[key].visible);

  let order = 1;
  for (const key of visible) {
    next[key] = { ...next[key], order: order++ };
  }
  for (const key of hidden) {
    next[key] = { ...next[key], order: order++ };
  }

  return next;
}

function usePerUserTablePrefs() {
  const { session } = useAuth();
  const userId = session?.userId ?? null;
  const [prefs, setPrefs] = useState<UserTableViewPrefs | null>(null);

  useEffect(() => {
    if (userId == null) {
      setPrefs(null);
      return;
    }

    const reload = () => setPrefs(loadTableViewPrefsForUser(userId));

    const onPrefsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: number }>).detail;
      if (!detail || detail.userId == null || detail.userId === userId) {
        reload();
      }
    };

    reload();
    window.addEventListener(TABLE_VIEW_PREFS_UPDATED_EVENT, onPrefsUpdated);
    return () => {
      window.removeEventListener(TABLE_VIEW_PREFS_UPDATED_EVENT, onPrefsUpdated);
    };
  }, [userId]);

  return { userId, prefs, setPrefs };
}

export function JobsTableSettings() {
  const { userId, prefs, setPrefs } = usePerUserTablePrefs();
  const [saving, setSaving] = useState(false);
  const [draggingKey, setDraggingKey] = useState<JobsTableColumnKey | null>(null);

  const visibleKeys = useMemo(() => {
    if (!prefs) return [] as JobsTableColumnKey[];
    return JOB_COLUMN_LABELS
      .map((item) => item.key)
      .filter((key) => prefs.jobs[key].visible)
      .sort((a, b) => prefs.jobs[a].order - prefs.jobs[b].order);
  }, [prefs]);

  const setVisibility = (key: JobsTableColumnKey, visible: boolean, required: boolean) => {
    if (required && !visible) return;
    setPrefs((prev) => {
      if (!prev) return prev;
      const nextJobs: JobsTableColumns = { ...prev.jobs };
      const current = nextJobs[key];
      if (current.visible === visible) return prev;

      if (!visible) {
        nextJobs[key] = { ...current, visible: false };
      } else {
        const maxOrder = Math.max(0, ...JOB_COLUMN_LABELS.map((item) => (nextJobs[item.key].visible ? nextJobs[item.key].order : 0)));
        nextJobs[key] = { ...current, visible: true, order: maxOrder + 1 };
      }

      return {
        ...prev,
        jobs: normalizeLocalOrders(nextJobs, JOB_COLUMN_LABELS.map((item) => item.key))
      };
    });
  };

  const reorderByDrag = (dragKey: JobsTableColumnKey, dropKey: JobsTableColumnKey) => {
    if (dragKey === dropKey) return;
    setPrefs((prev) => {
      if (!prev) return prev;
      const ordered = JOB_COLUMN_LABELS
        .map((item) => item.key)
        .filter((key) => prev.jobs[key].visible)
        .sort((a, b) => prev.jobs[a].order - prev.jobs[b].order);

      const from = ordered.indexOf(dragKey);
      const to = ordered.indexOf(dropKey);
      if (from < 0 || to < 0) return prev;

      const moved = [...ordered];
      moved.splice(from, 1);
      moved.splice(to, 0, dragKey);

      const nextJobs: JobsTableColumns = { ...prev.jobs };
      for (let i = 0; i < moved.length; i++) {
        const key = moved[i];
        nextJobs[key] = { ...nextJobs[key], order: i + 1 };
      }

      return {
        ...prev,
        jobs: normalizeLocalOrders(nextJobs, JOB_COLUMN_LABELS.map((item) => item.key))
      };
    });
  };

  const handleSave = async () => {
    if (userId == null || !prefs) return;
    setSaving(true);
    try {
      const saved = saveTableViewPrefsForUser(userId, prefs);
      setPrefs(saved);
      emitTableViewPrefsUpdated(userId);
      alert('Jobs table settings saved successfully');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (userId == null) return;
    setPrefs((prev) => {
      const base = prev ?? loadTableViewPrefsForUser(userId);
      const next: UserTableViewPrefs = { ...base, jobs: createDefaultJobsTableColumns() };
      const saved = saveTableViewPrefsForUser(userId, next);
      emitTableViewPrefsUpdated(userId);
      return saved;
    });
  };

  if (!prefs || userId == null) {
    return <p className="text-sm text-muted-foreground">No user session loaded.</p>;
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h4 className="text-base font-semibold text-foreground/80 tracking-wide">Jobs Table Layout</h4>
        <p className="text-sm text-muted-foreground">
          Pick which columns are visible and drag visible rows to set display order.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        {JOB_COLUMN_LABELS.map((column) => (
          <label key={column.key} className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={prefs.jobs[column.key].visible}
              disabled={column.required}
              onChange={(e) => setVisibility(column.key, e.target.checked, column.required)}
              className="w-4 h-4 rounded border-border text-primary focus:ring-primary/50"
            />
            <span className="text-sm">
              {column.label}
              {column.required ? ' Required' : ''}
            </span>
          </label>
        ))}
      </div>

      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">Visible column order</p>
        <div className="flex flex-wrap gap-2 w-full">
          {visibleKeys.map((key) => {
            const label = JOB_COLUMN_LABELS.find((item) => item.key === key)?.label ?? key;
            const order = prefs.jobs[key].order;
            return (
              <div
                key={key}
                draggable
                onDragStart={() => setDraggingKey(key)}
                onDragEnd={() => setDraggingKey(null)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => {
                  if (!draggingKey) return;
                  reorderByDrag(draggingKey, key);
                  setDraggingKey(null);
                }}
                className="flex items-center gap-3 rounded-md border border-border bg-background px-3 py-2 w-[260px]"
                title="Drag to reorder"
              >
                <span className="text-muted-foreground cursor-grab select-none" aria-hidden="true">
                  ::
                </span>
                <div className="flex items-center gap-2 text-sm w-full">
                  <span className="w-6 text-muted-foreground">{order}</span>
                  <span className="flex-1">{label}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={handleReset} disabled={saving}>
          Reset Jobs Defaults
        </Button>
        <Button size="sm" onClick={handleSave} disabled={saving}>
          Save Settings
        </Button>
      </div>
    </div>
  );
}

export function RouterTableSettings() {
  const { userId, prefs, setPrefs } = usePerUserTablePrefs();
  const [saving, setSaving] = useState(false);
  const [draggingKey, setDraggingKey] = useState<RouterTableColumnKey | null>(null);

  const visibleKeys = useMemo(() => {
    if (!prefs) return [] as RouterTableColumnKey[];
    return ROUTER_COLUMN_LABELS
      .map((item) => item.key)
      .filter((key) => prefs.router[key].visible)
      .sort((a, b) => prefs.router[a].order - prefs.router[b].order);
  }, [prefs]);

  const setVisibility = (key: RouterTableColumnKey, visible: boolean, required: boolean) => {
    if (required && !visible) return;
    setPrefs((prev) => {
      if (!prev) return prev;
      const nextRouter: RouterTableColumns = { ...prev.router };
      const current = nextRouter[key];
      if (current.visible === visible) return prev;

      if (!visible) {
        nextRouter[key] = { ...current, visible: false };
      } else {
        const maxOrder = Math.max(0, ...ROUTER_COLUMN_LABELS.map((item) => (nextRouter[item.key].visible ? nextRouter[item.key].order : 0)));
        nextRouter[key] = { ...current, visible: true, order: maxOrder + 1 };
      }

      return {
        ...prev,
        router: normalizeLocalOrders(nextRouter, ROUTER_COLUMN_LABELS.map((item) => item.key))
      };
    });
  };

  const reorderByDrag = (dragKey: RouterTableColumnKey, dropKey: RouterTableColumnKey) => {
    if (dragKey === dropKey) return;
    setPrefs((prev) => {
      if (!prev) return prev;
      const ordered = ROUTER_COLUMN_LABELS
        .map((item) => item.key)
        .filter((key) => prev.router[key].visible)
        .sort((a, b) => prev.router[a].order - prev.router[b].order);

      const from = ordered.indexOf(dragKey);
      const to = ordered.indexOf(dropKey);
      if (from < 0 || to < 0) return prev;

      const moved = [...ordered];
      moved.splice(from, 1);
      moved.splice(to, 0, dragKey);

      const nextRouter: RouterTableColumns = { ...prev.router };
      for (let i = 0; i < moved.length; i++) {
        const key = moved[i];
        nextRouter[key] = { ...nextRouter[key], order: i + 1 };
      }

      return {
        ...prev,
        router: normalizeLocalOrders(nextRouter, ROUTER_COLUMN_LABELS.map((item) => item.key))
      };
    });
  };

  const handleSave = async () => {
    if (userId == null || !prefs) return;
    setSaving(true);
    try {
      const saved = saveTableViewPrefsForUser(userId, prefs);
      setPrefs(saved);
      emitTableViewPrefsUpdated(userId);
      alert('Router table settings saved successfully');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (userId == null) return;
    setPrefs((prev) => {
      const base = prev ?? loadTableViewPrefsForUser(userId);
      const next: UserTableViewPrefs = { ...base, router: createDefaultRouterTableColumns() };
      const saved = saveTableViewPrefsForUser(userId, next);
      emitTableViewPrefsUpdated(userId);
      return saved;
    });
  };

  if (!prefs || userId == null) {
    return <p className="text-sm text-muted-foreground">No user session loaded.</p>;
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h4 className="text-base font-semibold text-foreground/80 tracking-wide">Router Table Layout</h4>
        <p className="text-sm text-muted-foreground">
          Pick which columns are visible and drag visible rows to set display order.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        {ROUTER_COLUMN_LABELS.map((column) => (
          <label key={column.key} className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={prefs.router[column.key].visible}
              disabled={column.required}
              onChange={(e) => setVisibility(column.key, e.target.checked, column.required)}
              className="w-4 h-4 rounded border-border text-primary focus:ring-primary/50"
            />
            <span className="text-sm">
              {column.label}
              {column.required ? ' Required' : ''}
            </span>
          </label>
        ))}
      </div>

      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">Visible column order</p>
        <div className="flex flex-wrap gap-2 w-full">
          {visibleKeys.map((key) => {
            const label = ROUTER_COLUMN_LABELS.find((item) => item.key === key)?.label ?? key;
            const order = prefs.router[key].order;
            return (
              <div
                key={key}
                draggable
                onDragStart={() => setDraggingKey(key)}
                onDragEnd={() => setDraggingKey(null)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => {
                  if (!draggingKey) return;
                  reorderByDrag(draggingKey, key);
                  setDraggingKey(null);
                }}
                className="flex items-center gap-3 rounded-md border border-border bg-background px-3 py-2 w-[260px]"
                title="Drag to reorder"
              >
                <span className="text-muted-foreground cursor-grab select-none" aria-hidden="true">
                  ::
                </span>
                <div className="flex items-center gap-2 text-sm w-full">
                  <span className="w-6 text-muted-foreground">{order}</span>
                  <span className="flex-1">{label}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={handleReset} disabled={saving}>
          Reset Router Defaults
        </Button>
        <Button size="sm" onClick={handleSave} disabled={saving}>
          Save Settings
        </Button>
      </div>
    </div>
  );
}
