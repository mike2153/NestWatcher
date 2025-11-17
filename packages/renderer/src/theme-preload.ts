/**
 * Apply the persisted theme class before the UI mounts to prevent flicker.
 */
try {
  const stored = window.localStorage.getItem('ui:theme') ?? 'system';
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const root = document.documentElement;
  const isDark = stored === 'dark' || (stored === 'system' && prefersDark);

  if (isDark) {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
} catch (error) {
  console.warn('Failed to apply stored theme preference', error);
}
