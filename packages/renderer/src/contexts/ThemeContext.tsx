import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Theme = 'dark' | 'sunset' | 'forest' | 'supabase' | 'nccat-light';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void; 
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const THEME_STORAGE_KEY = 'woodtron-theme';

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    // Check localStorage for saved preference
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      if (['dark', 'sunset', 'forest', 'supabase', 'nccat-light'].includes(saved as string)) {
        return saved as Theme;
      }
    }
    return 'dark'; // Default to dark theme
  });

  useEffect(() => {
    // Apply theme class to document
    const root = document.documentElement;
    root.classList.remove('dark', 'sunset', 'forest', 'supabase', 'nccat-light');
    root.classList.add(theme);
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const toggleTheme = () => {
    setThemeState((prev) => {
      // Flip between Light and the default dark theme.
      if (prev === 'dark') return 'nccat-light';
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
