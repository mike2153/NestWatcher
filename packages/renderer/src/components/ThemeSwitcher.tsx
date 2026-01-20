import { useState } from 'react';
import { Palette, ChevronsUpDown } from 'lucide-react';
import { useTheme } from '@/contexts/ThemeContext';
import { ThemeModal } from './ThemeModal';
import { cn } from '@/utils/cn';

export function ThemeSwitcher() {
    const [isModalOpen, setIsModalOpen] = useState(false);
    const { theme } = useTheme();

    // Map theme to readable label
    const themeLabels: Record<string, string> = {
        'nccat-light': 'Light',
        'sunset': 'Sunset',
        'dark': 'Dark (Teal)',
        'forest': 'Dark (Green)',
        'supabase': 'Dark (Charcoal)'
    };

    return (
        <>
            <button
                onClick={() => setIsModalOpen(true)}
                className={cn(
                    'flex h-10 w-full items-center gap-3 overflow-hidden rounded-md pl-4 pr-3 text-left text-sm font-medium transition-colors font-sans [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0',
                    'text-[var(--muted-foreground)] hover:bg-[var(--accent-blue-subtle)] hover:text-[var(--foreground)]',
                    'group-data-[collapsible=icon]/sidebar-wrapper:justify-center group-data-[collapsible=icon]/sidebar-wrapper:px-2'
                )}
                title="Change theme"
            >
                <Palette className="transition-colors" />
                <span className="flex-1 truncate group-data-[collapsible=icon]/sidebar-wrapper:hidden">
                    {themeLabels[theme] || 'Theme'}
                </span>
                <ChevronsUpDown className="ml-auto group-data-[collapsible=icon]/sidebar-wrapper:hidden" />
            </button>

            <ThemeModal
                isOpen={isModalOpen}
                onClose={() => setIsModalOpen(false)}
            />
        </>
    );
}
