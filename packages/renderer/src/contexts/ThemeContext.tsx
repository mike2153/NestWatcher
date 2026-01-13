import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Theme = 'dark' | 'light' | 'sunset' | 'forest' | 'classic' | 'supabase' | 'nccat' | 'nccat-light';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void; // Keeps the toggle for cycling or legacy support, but we'll prioritize direct setting
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const THEME_STORAGE_KEY = 'woodtron-theme';

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    // Check localStorage for saved preference
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      if (['light', 'dark', 'sunset', 'forest', 'classic', 'supabase', 'nccat', 'nccat-light'].includes(saved as string)) {
        return saved as Theme;
      }
    }
    return 'dark'; // Default to dark theme
  });

  useEffect(() => {
    // Apply theme class to document
    const root = document.documentElement;
    root.classList.remove('light', 'dark', 'sunset', 'forest', 'classic', 'supabase', 'nccat', 'nccat-light');
    root.classList.add(theme);

    // Persist to localStorage
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const toggleTheme = () => {
    setThemeState((prev) => {
      // Simple cycle or just toggle logic if we kept it simple, but let's cycle for now or flip default
      if (prev === 'dark') return 'light';
      return 'dark';
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
