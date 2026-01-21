/**
 * Apply the persisted theme class before the UI mounts to prevent flicker.
 */
try {
  const stored = window.localStorage.getItem('woodtron-theme');
  const validThemes = ['dark', 'sunset', 'forest', 'supabase', 'nccat-light'];
  const theme = validThemes.includes(stored as string) ? stored : 'dark';
  const root = document.documentElement;

  // Remove any existing theme classes
  root.classList.remove('dark', 'sunset', 'forest', 'supabase', 'nccat-light');

  // Add the theme class
  root.classList.add(theme as string);

  // Also add 'dark' class for dark themes so Tailwind's dark: prefix works
  // Light themes: sunset, nccat-light
  // Dark themes: dark, forest, supabase
  const isDarkTheme = theme === 'dark' || theme === 'forest' || theme === 'supabase';
  if (isDarkTheme && theme !== 'dark') {
    root.classList.add('dark');
  }
} catch (error) {
  console.warn('Failed to apply stored theme preference', error);
}
