import { useState } from 'react';
import { Palette, ChevronsUpDown } from 'lucide-react';
import { useTheme } from '@/contexts/ThemeContext';
import { ThemeModal } from './ThemeModal';

export function ThemeSwitcher() {
    const [isModalOpen, setIsModalOpen] = useState(false);
    const { theme } = useTheme();

    // Map theme to readable label
    const themeLabels: Record<string, string> = {
        'dark': 'Soft Ocean (Dark)',
        'light': 'Soft Ocean (Light)',
        'classic': 'Classic Light',
        'sunset': 'Sunset Drift',
        'forest': 'Nordic Forest',
        'supabase': 'Supabase',
        'nccat': 'NC-Catalyst (Dark)',
        'nccat-light': 'NC-Catalyst (Light)'
    };

    return (
        <>
            <button
                onClick={() => setIsModalOpen(true)}
                className="flex h-10 w-full items-center gap-3 overflow-hidden rounded-lg pl-4 pr-3 text-left text-base font-medium transition-all duration-200 text-[var(--sidebar-foreground)] hover:bg-[var(--sidebar-accent)]/50 hover:text-[var(--sidebar-foreground)] outline-none group"
                title="Change theme"
            >
                <Palette className="size-4 shrink-0 transition-colors" />
                <span className="ml-2 flex-1 truncate text-base font-medium">
                    {themeLabels[theme] || 'Theme'}
                </span>
                <ChevronsUpDown className="ml-auto size-4 opacity-50" />
            </button>

            <ThemeModal
                isOpen={isModalOpen}
                onClose={() => setIsModalOpen(false)}
            />
        </>
    );
}

