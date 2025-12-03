import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/utils/cn';

type Ctx = {
  open: boolean;
  setOpen: (v: boolean) => void;
};

const MenuContext = React.createContext<Ctx | null>(null);

function DropdownMenuRoot({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const value = useMemo(() => ({ open, setOpen }), [open]);
  return <MenuContext.Provider value={value}>{children}</MenuContext.Provider>;
}

function DropdownMenuTriggerBase({ asChild = false, children }: { asChild?: boolean; children: React.ReactElement | React.ReactNode }) {
  const ctx = useContext(MenuContext);
  if (!ctx) return <>{children}</>;

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    ctx.setOpen(!ctx.open);
  };

  if (asChild && React.isValidElement(children)) {
    const prev = (children as React.ReactElement).props.onClick as ((e: React.MouseEvent) => void) | undefined;
    return React.cloneElement(children as React.ReactElement, {
      onClick: (e: React.MouseEvent) => {
        prev?.(e);
        onClick(e);
      }
    });
  }
  return <button type="button" onClick={onClick}>{children}</button>;
}

function DropdownMenuContentBase({ children, className, align = 'end' }: { children: React.ReactNode; className?: string; align?: 'start' | 'end' }) {
  const ctx = useContext(MenuContext);
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ctx) return;
    if (!ctx.open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') ctx!.setOpen(false);
    }
    function onMouse(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (contentRef.current && target && contentRef.current.contains(target)) return;
      ctx!.setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onMouse);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onMouse);
    };
  }, [ctx]);

  if (!ctx || !ctx.open) return null;

  return (
    <div
      ref={contentRef}
      className={cn(
        'absolute mt-1 z-50 min-w-[8rem] overflow-hidden rounded-md border p-1 shadow-lg',
        'bg-[var(--popover)] text-[var(--popover-foreground)] border-[var(--border)]',
        align === 'end' ? 'right-0' : 'left-0',
        className
      )}
    >
      {children}
    </div>
  );
}

function DropdownMenuItemBase({
  children,
  disabled,
  onSelect,
  className
}: {
  children: React.ReactNode;
  disabled?: boolean;
  className?: string;
  onSelect?: () => void;
}) {
  const ctx = useContext(MenuContext);
  const onClick = useCallback(() => {
    if (disabled) return;
    onSelect?.();
    ctx?.setOpen(false);
  }, [disabled, onSelect, ctx]);

  return (
    <button
      type="button"
      className={cn(
        'relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-all duration-150',
        'text-[var(--popover-foreground)] hover:bg-[var(--accent-blue-subtle)] hover:text-[var(--accent-foreground)]',
        'hover:pl-3 hover:border-l-2 hover:border-l-[var(--accent-blue)]',
        'disabled:opacity-50 disabled:pointer-events-none',
        className
      )}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function DropdownMenuSeparatorBase() {
  return <div className="my-1 border-t border-[var(--border)]" />;
}

export const DropdownMenu = DropdownMenuRoot;
export const DropdownMenuTrigger = DropdownMenuTriggerBase;
export const DropdownMenuContent = DropdownMenuContentBase;
export const DropdownMenuItem = DropdownMenuItemBase;
export const DropdownMenuSeparator = DropdownMenuSeparatorBase;
