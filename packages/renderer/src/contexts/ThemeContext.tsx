import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Theme = 'light' | 'sunset' | 'dark-teal' | 'dark-green' | 'dark-charcoal';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const THEME_STORAGE_KEY = 'woodtron-theme';

const VALID_THEMES: Theme[] = ['light', 'sunset', 'dark-teal', 'dark-green', 'dark-charcoal'];

function normalizeStoredTheme(stored: string | null): Theme {
  if (!stored) return 'dark-teal';
  return (VALID_THEMES as readonly string[]).includes(stored) ? (stored as Theme) : 'dark-teal';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    // Check localStorage for saved preference
    if (typeof window !== 'undefined') {
      return normalizeStoredTheme(localStorage.getItem(THEME_STORAGE_KEY));
    }
    return 'dark-teal'; // Default to dark theme
  });

  useEffect(() => {
    // Apply theme class to document
    const root = document.documentElement;
    root.classList.remove('dark', ...VALID_THEMES);
    root.classList.add(theme);

    // Add Tailwind's dark-mode marker class for all dark variants.
    const isDarkTheme = theme === 'dark-teal' || theme === 'dark-green' || theme === 'dark-charcoal';
    if (isDarkTheme) root.classList.add('dark');

    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const toggleTheme = () => {
    setThemeState((prev) => {
      // Flip between Light and the default dark theme.
      if (prev === 'dark-teal') return 'light';
      return 'dark-teal';
    });
  };

  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme);
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
