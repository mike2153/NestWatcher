import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Info, FolderOpen } from 'lucide-react';

import { cn } from '@/lib/utils';

type IconActionVariant = 'ghost' | 'outline';
type IconActionSize = 'xs' | 'sm';

type IconActionButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  icon: ReactNode;
  tooltip: string;
  variant?: IconActionVariant;
  size?: IconActionSize;
};

export function IconActionButton({
  icon,
  tooltip,
  variant = 'outline',
  size = 'sm',
  className,
  type,
  ...props
}: IconActionButtonProps) {
  const sizeClass = size === 'xs' ? 'h-6 w-6' : 'h-9 w-9';

  const variantClass =
    variant === 'ghost'
      ? 'border border-transparent bg-transparent text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] hover:border-[var(--border)]'
      : 'border border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]';

  return (
    <button
      type={type ?? 'button'}
      title={tooltip}
      aria-label={props['aria-label'] ?? tooltip}
      className={cn(
        'inline-flex items-center justify-center rounded-md',
        'p-0',
        sizeClass,
        variantClass,
        'transform-gpu transition-transform transition-shadow duration-200',
        'hover:-translate-y-0.5 hover:shadow-md',
        'active:translate-y-0 active:shadow-sm',
        'disabled:opacity-50 disabled:pointer-events-none disabled:hover:shadow-none disabled:hover:translate-y-0',
        className
      )}
      {...props}
    >
      {icon}
    </button>
  );
}

export function InfoTipIcon({ text }: { text: string }) {
  return (
    <IconActionButton
      variant="ghost"
      size="xs"
      tooltip={text}
      icon={<Info className="size-4" />}
    />
  );
}

export function FolderBrowseIconButton(props: Omit<IconActionButtonProps, 'icon' | 'tooltip' | 'variant'> & { tooltip?: string }) {
  const { tooltip, ...rest } = props;
  return (
    <IconActionButton
      {...rest}
      variant="outline"
      tooltip={tooltip ?? 'Browse for folder'}
      icon={<FolderOpen className="size-5" />}
    />
  );
}
