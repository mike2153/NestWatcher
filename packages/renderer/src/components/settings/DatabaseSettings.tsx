import { useEffect, useState, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { DbSettings, DbStatus } from '../../../../shared/src';

const schema = z.object({
  host: z.string().default(''),
  port: z.coerce.number().int().min(1).max(65535).default(5432),
  database: z.string().default(''),
  user: z.string().default(''),
  password: z.string().default(''),
  sslMode: z.enum(['disable', 'require', 'verify-ca', 'verify-full']).default('disable'),
  statementTimeoutMs: z.coerce.number().int().min(0).max(600000).default(30000)
});

type FormValues = z.infer<typeof schema>;

export function DatabaseSettings() {
  const { register, handleSubmit, reset, formState: { isSubmitting } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      host: '',
      port: 5432,
      database: '',
      user: '',
      password: '',
      sslMode: 'disable',
      statementTimeoutMs: 30000
    }
  });

  const [dbStatus, setDbStatus] = useState<DbStatus | null>(null);
  const [testResult, setTestResult] = useState<{ status: 'idle' | 'testing' | 'ok' | 'error'; message: string }>({
    status: 'idle',
    message: ''
  });

  const statusLabel = useMemo(() => {
    if (!dbStatus) return 'Checking...';
    return dbStatus.online ? 'Online' : dbStatus.error ? 'Offline' : 'Checking...';
  }, [dbStatus]);

  const statusClass = useMemo(() => {
    if (dbStatus?.online) return 'text-success';
    if (dbStatus?.error) return 'text-destructive';
    return 'text-warning';
  }, [dbStatus]);

  useEffect(() => {
    // Load current settings
    (async () => {
      const res = await window.api.settings.get();
      if (res.ok && res.value.db) {
        reset(res.value.db);
      }
    })();

    // Subscribe to database status
    let cancelled = false;
    window.api.db.getStatus()
      .then((res) => {
        if (!cancelled && res.ok) {
          setDbStatus(res.value);
        }
      })
      .catch(() => {});

    const unsubscribe = window.api.db.subscribeStatus((status) => setDbStatus(status));

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [reset]);

  const onTest = async (values: FormValues) => {
    setTestResult({ status: 'testing', message: 'Testing connection...' });
    const res = await window.api.db.testConnection(values as DbSettings);

    if (res.ok) {
      if (res.value.ok) {
        setTestResult({ status: 'ok', message: 'Connection successful' });
      } else {
        setTestResult({ status: 'error', message: res.value.error || 'Connection failed' });
      }
    } else {
      setTestResult({ status: 'error', message: 'Failed to test connection' });
    }
  };

  const onSave = async (values: FormValues) => {
    const currentSettings = await window.api.settings.get();
    if (!currentSettings.ok) {
      alert('Failed to load current settings');
      return;
    }

    const updatedSettings = {
      ...currentSettings.value,
      db: values as DbSettings
    };

    const saved = await window.api.settings.save(updatedSettings);
    if (saved.ok) {
      setTestResult({ status: 'ok', message: 'Settings saved successfully' });
      setTimeout(() => setTestResult({ status: 'idle', message: '' }), 3000);
    } else {
      alert('Failed to save settings');
    }
  };

  return (
    <form onSubmit={handleSubmit(onSave)} className="space-y-6">
      {/* Status Bar */}
      {dbStatus && (
        <div className="flex items-center gap-2 p-3 bg-muted/30 rounded-md">
          <div className={`w-2 h-2 rounded-full ${dbStatus.online ? 'bg-success' : 'bg-destructive'}`} />
          <span className={`text-sm font-medium ${statusClass}`}>{statusLabel}</span>
          {dbStatus.online && dbStatus.latencyMs !== undefined && (
            <span className="text-sm text-muted-foreground">({dbStatus.latencyMs}ms)</span>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">Host</label>
          <input
            className="w-full px-3 py-2 border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
            placeholder="localhost"
            {...register('host')}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Port</label>
          <input
            className="w-full px-3 py-2 border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
            type="number"
            placeholder="5432"
            {...register('port', { valueAsNumber: true })}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Database</label>
          <input
            className="w-full px-3 py-2 border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
            placeholder="database_name"
            {...register('database')}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">User</label>
          <input
            className="w-full px-3 py-2 border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
            placeholder="username"
            {...register('user')}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Password</label>
          <input
            className="w-full px-3 py-2 border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
            type="password"
            autoComplete="off"
            {...register('password')}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">SSL Mode</label>
          <select
            className="w-full px-3 py-2 border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
            {...register('sslMode')}
          >
            <option value="disable">Disable</option>
            <option value="require">Require</option>
            <option value="verify-ca">Verify CA</option>
            <option value="verify-full">Verify Full</option>
          </select>
        </div>

        <div className="col-span-2">
          <label className="block text-sm font-medium mb-1">Statement Timeout (ms)</label>
          <input
            className="w-full px-3 py-2 border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
            type="number"
            placeholder="30000"
            {...register('statementTimeoutMs', { valueAsNumber: true })}
          />
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSubmit(onTest)}
          disabled={isSubmitting || testResult.status === 'testing'}
          className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md hover:bg-secondary/80 transition-colors disabled:opacity-50"
        >
          Test Connection
        </button>

        <button
          type="submit"
          disabled={isSubmitting}
          className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          Save Changes
        </button>

        {testResult.status !== 'idle' && (
          <span className={`text-sm ${
            testResult.status === 'ok' ? 'text-success' :
            testResult.status === 'error' ? 'text-destructive' :
            'text-warning'
          }`}>
            {testResult.message}
          </span>
        )}
      </div>
    </form>
  );
}