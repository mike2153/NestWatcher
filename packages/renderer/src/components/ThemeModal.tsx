import { X, Check } from 'lucide-react';
import { useTheme, type Theme } from '@/contexts/ThemeContext';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/cn';

interface ThemeModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const themes: { value: Theme; label: string; color: string; description: string }[] = [
  {
    value: 'light',
    label: 'Light',
    color: 'bg-[hsl(40,20%,98%)]',
    description: 'Bright, clean surfaces with strong contrast text.'
  },
  {
    value: 'sunset',
    label: 'Sunset',
    color: 'bg-[#d6d3c4]',
    description: 'Warm stone background with high contrast cards.'
  },
  {
    value: 'dark-teal',
    label: 'Dark (Teal)',
    color: 'bg-slate-900',
    description: 'Dark theme with teal accents.'
  },
  {
    value: 'dark-green',
    label: 'Dark (Green)',
    color: 'bg-emerald-900',
    description: 'Dark theme with natural greens.'
  },
  {
    value: 'dark-charcoal',
    label: 'Dark (Charcoal)',
    color: 'bg-[#1c1c1c]',
    description: 'Charcoal dark theme with subtle green accents.'
  }
];

export function ThemeModal({ isOpen, onClose }: ThemeModalProps) {
  const { theme, setTheme } = useTheme();

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-none animate-in fade-in duration-200">
      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl shadow-2xl w-[450px] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
        <div className="px-8 h-[72px] flex items-center justify-between border-b border-[var(--border)] bg-[var(--card)] shrink-0">
          <div>
            <h2 className="text-xl font-bold text-[var(--foreground)] tracking-tight">Theme Preference</h2>
            <p className="text-sm text-[var(--muted-foreground)]">Choose your workspace appearance</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="rounded-full hover:bg-[var(--muted)]"
          >
            <X className="size-5" />
          </Button>
        </div>

        <div className="p-8 bg-[var(--background-subtle)] space-y-4">
          <div className="grid gap-3">
            {themes.map((t) => (
              <button
                key={t.value}
                onClick={() => setTheme(t.value)}
                className={cn(
                  'flex items-center gap-4 p-4 rounded-lg border text-left transition-all duration-200 group relative overflow-hidden',
                  theme === t.value
                    ? 'bg-[var(--sidebar-accent)] border-[var(--primary)] shadow-sm ring-1 ring-[var(--primary)]'
                    : 'bg-[var(--card)] border-[var(--border)] hover:bg-[var(--sidebar-accent)]/50 hover:border-[var(--border)]'
                )}
              >
                <div
                  className={cn(
                    'size-12 rounded-full border-2 border-[var(--border)] shadow-sm shrink-0',
                    t.color
                  )}
                />

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-base text-[var(--foreground)]">{t.label}</span>
                    {theme === t.value && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-[var(--primary)] text-[var(--primary-foreground)]">
                        Active
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-[var(--muted-foreground)] mt-0.5 truncate">{t.description}</p>
                </div>

                {theme === t.value && (
                  <div className="text-[var(--primary)]">
                    <Check className="size-6" />
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="p-6 border-t border-[var(--border)] bg-[var(--card)] flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </div>
  );
}
