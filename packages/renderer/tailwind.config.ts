import type { Config } from 'tailwindcss';

export default {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      // Modern professional font stack
      fontFamily: {
        sans: ['"Geist Variable"', 'Geist', 'Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace']
      },

      // Design system colors mapped to CSS variables (hex values)
      colors: {
        // Semantic colors
        border: 'var(--border)',
        ring: 'var(--ring)',
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        primary: {
          DEFAULT: 'var(--primary)',
          foreground: 'var(--primary-foreground)',
        },
        secondary: {
          DEFAULT: 'var(--secondary)',
          foreground: 'var(--secondary-foreground)',
        },
        muted: {
          DEFAULT: 'var(--muted)',
          foreground: 'var(--muted-foreground)'
        },
        accent: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--accent-foreground)'
        },
        destructive: {
          DEFAULT: 'var(--destructive)',
          foreground: 'var(--destructive-foreground)'
        },
        card: {
          DEFAULT: 'var(--card)',
          foreground: 'var(--card-foreground)'
        },
        popover: {
          DEFAULT: 'var(--popover)',
          foreground: 'var(--popover-foreground)'
        },
        sidebar: {
          DEFAULT: 'var(--sidebar)',
          foreground: 'var(--sidebar-foreground)',
        },

        // Status colors (mapped to the tokens we actually have in theme.css)
        success: 'var(--status-success-text)',
        warning: 'var(--tone-warning)',

      },
    },

    // Border radius using design tokens
    borderRadius: {
      lg: 'var(--radius)',
      md: 'calc(var(--radius) - 2px)',
      sm: 'calc(var(--radius) - 4px)',
    },

    // Shadows using design tokens
    boxShadow: {
      sm: 'var(--shadow-sm)',
      DEFAULT: 'var(--shadow-base)',
      md: 'var(--shadow-md)',
      lg: 'var(--shadow-lg)',
      xl: 'var(--shadow-xl)',
      '2xl': 'var(--shadow-2xl)',
    },

    // Typography scale
    fontSize: {
      xs: ['var(--text-xs)', { lineHeight: 'var(--leading-tight)' }],
      sm: ['var(--text-sm)', { lineHeight: 'var(--leading-normal)' }],
      base: ['var(--text-base)', { lineHeight: 'var(--leading-normal)' }],
      lg: ['var(--text-lg)', { lineHeight: 'var(--leading-normal)' }],
      xl: ['var(--text-xl)', { lineHeight: 'var(--leading-snug)' }],
      '2xl': ['var(--text-2xl)', { lineHeight: 'var(--leading-snug)' }],
      '3xl': ['var(--text-3xl)', { lineHeight: 'var(--leading-tight)' }],
      '4xl': ['var(--text-4xl)', { lineHeight: 'var(--leading-tight)' }],
    },

    // Spacing using design tokens
    spacing: {
      '0': 'var(--spacing-0)',
      '1': 'var(--spacing-1)',
      '2': 'var(--spacing-2)',
      '3': 'var(--spacing-3)',
      '4': 'var(--spacing-4)',
      '5': 'var(--spacing-5)',
      '6': 'var(--spacing-6)',
      '8': 'var(--spacing-8)',
      '10': 'var(--spacing-10)',
      '12': 'var(--spacing-12)',
      '16': 'var(--spacing-16)',
    },

    // Animation and transitions
    transitionDuration: {
      fast: 'var(--transition-fast)',
      normal: 'var(--transition-normal)',
      slow: 'var(--transition-slow)',
    },

    // Z-index scale
    zIndex: {
      dropdown: 'var(--z-dropdown)',
      sticky: 'var(--z-sticky)',
      fixed: 'var(--z-fixed)',
      'modal-backdrop': 'var(--z-modal-backdrop)',
      modal: 'var(--z-modal)',
      popover: 'var(--z-popover)',
      tooltip: 'var(--z-tooltip)',
    },

    animation: {
      pulse: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      spin: 'spin 1s linear infinite',
    },
  },
  plugins: [],
} satisfies Config;
