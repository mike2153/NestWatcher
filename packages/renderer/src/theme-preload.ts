/**
 * Apply the persisted theme class before the UI mounts to prevent flicker.
 */
try {
  const stored = window.localStorage.getItem('woodtron-theme');
  const validThemes = ['light', 'sunset', 'dark-teal', 'dark-green', 'dark-charcoal'] as const;
  const theme = validThemes.includes(stored as (typeof validThemes)[number]) ? stored : 'dark-teal';
  const root = document.documentElement;

  // Remove any existing theme classes
  root.classList.remove('dark', ...validThemes);

  // Add the theme class
  root.classList.add(theme as string);

  // Add Tailwind's dark-mode marker class for all dark variants.
  const isDarkTheme = theme === 'dark-teal' || theme === 'dark-green' || theme === 'dark-charcoal';
  if (isDarkTheme) root.classList.add('dark');
} catch (error) {
  console.warn('Failed to apply stored theme preference', error);
}
