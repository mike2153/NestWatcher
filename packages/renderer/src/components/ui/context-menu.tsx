import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/utils/cn';

type Position = { x: number; y: number } | null;

type Ctx = {
  open: boolean;
  setOpen: (v: boolean) => void;
  position: Position;
  setPosition: (p: Position) => void;
};

const MenuContext = React.createContext<Ctx | null>(null);

function ContextMenuRoot({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position>(null);
  const value = useMemo(() => ({ open, setOpen, position, setPosition }), [open, position]);
  return <MenuContext.Provider value={value}>{children}</MenuContext.Provider>;
}

function ContextMenuTriggerBase({ asChild = false, children }: { asChild?: boolean; children: React.ReactElement | React.ReactNode }) {
  const ctx = useContext(MenuContext);
  if (!ctx) return <>{children}</>;

  const onContextMenu = (e: React.MouseEvent) => {
    // Prevent native menu so our menu stays open
    e.preventDefault();
    ctx.setPosition({ x: e.clientX, y: e.clientY });
    ctx.setOpen(true);
  };

  if (asChild && React.isValidElement(children)) {
    const prev = (children as React.ReactElement).props.onContextMenu as ((e: React.MouseEvent) => void) | undefined;
    return React.cloneElement(children as React.ReactElement, {
      onContextMenu: (e: React.MouseEvent) => {
        prev?.(e);
        onContextMenu(e);
      }
    });
  }
  return <div onContextMenu={onContextMenu}>{children}</div>;
}

function ContextMenuContentBase({ children, className }: { children: React.ReactNode; className?: string }) {
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

  if (!ctx || !ctx.open || !ctx.position) return null;
  const style: React.CSSProperties = {
    position: 'fixed',
    top: Math.min(ctx.position.y, window.innerHeight - 240),
    left: Math.min(ctx.position.x, window.innerWidth - 260),
    zIndex: 50
  };
  return (
    <div className="fixed inset-0 z-50">
      <div
        ref={contentRef}
        className={cn(
          'z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
          'bg-white dark:bg-neutral-900',
          className
        )}
        style={style}
      >
        {children}
      </div>
    </div>
  );
}

function ContextMenuItemBase({
  children,
  inset,
  disabled,
  onSelect,
  className,
  onMouseEnter,
  onMouseLeave
}: {
  children: React.ReactNode;
  inset?: boolean;
  disabled?: boolean;
  className?: string;
  onSelect?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
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
        'relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none',
        'hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:pointer-events-none',
        inset && 'pl-8',
        className
      )}
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children}
    </button>
  );
}

function ContextMenuSeparatorBase() {
  return <div className="my-1 border-t" />;
}

function ContextMenuLabelBase({ children }: { children: React.ReactNode }) {
  return <div className="px-2 pt-1 pb-0.5 text-xs uppercase text-muted-foreground">{children}</div>;
}

// Shortcut (right-aligned hint)
function ContextMenuShortcutBase({ children }: { children: React.ReactNode }) {
  return <span className="ml-auto text-xs tracking-widest opacity-60">{children}</span>;
}

// Checkbox item
function ContextMenuCheckboxItemBase({ checked = false, children, inset, onSelect }: { checked?: boolean; inset?: boolean; children: React.ReactNode; onSelect?: () => void }) {
  return (
    <ContextMenuItemBase inset={inset} onSelect={onSelect}>
      <span className={cn('mr-2 inline-flex h-3 w-3 items-center justify-center rounded-[2px] border', checked ? 'bg-primary border-primary' : 'border-muted')}></span>
      <span>{children}</span>
    </ContextMenuItemBase>
  );
}

// Radio group
type RadioCtx = { value: string; setValue: (v: string) => void };
const RadioContext = React.createContext<RadioCtx | null>(null);
function ContextMenuRadioGroupBase({ value, onValueChange, children }: { value: string; onValueChange?: (v: string) => void; children: React.ReactNode }) {
  const [val, setVal] = useState(value);
  useEffect(() => setVal(value), [value]);
  const ctx = useMemo(() => ({ value: val, setValue: (v: string) => { setVal(v); onValueChange?.(v); } }), [val, onValueChange]);
  return <RadioContext.Provider value={ctx}>{children}</RadioContext.Provider>;
}
function ContextMenuRadioItemBase({ value, children, inset, onSelect }: { value: string; children: React.ReactNode; inset?: boolean; onSelect?: () => void }) {
  const rctx = useContext(RadioContext);
  const selected = rctx?.value === value;
  return (
    <ContextMenuItemBase inset={inset} onSelect={() => { rctx?.setValue(value); onSelect?.(); }}>
      <span className={cn('mr-2 inline-flex h-3 w-3 items-center justify-center rounded-full border', selected ? 'border-primary' : 'border-muted')}>
        {selected ? <span className="h-2 w-2 rounded-full bg-primary" /> : null}
      </span>
      <span>{children}</span>
    </ContextMenuItemBase>
  );
}

// Submenu
type SubCtx = { open: boolean; setOpen: (v: boolean) => void; anchorRef: React.MutableRefObject<HTMLElement | null> };
const SubContext = React.createContext<SubCtx | null>(null);
function ContextMenuSubBase({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLElement | null>(null);
  const ctx = useMemo(() => ({ open, setOpen, anchorRef }), [open]);
  return <SubContext.Provider value={ctx}>{children}</SubContext.Provider>;
}
function ContextMenuSubTriggerBase({ children, inset }: { children: React.ReactNode; inset?: boolean }) {
  const sctx = useContext(SubContext);
  return (
    <ContextMenuItemBase
      inset={inset}
      className="justify-between"
      onSelect={() => sctx?.setOpen(true)}
      onMouseEnter={() => sctx?.setOpen(true)}
    >
      <span ref={(el) => { if (el) sctx!.anchorRef.current = el; }}>{children}</span>
      <span className="ml-6 text-xs opacity-60">›</span>
    </ContextMenuItemBase>
  );
}
function ContextMenuSubContentBase({ children, className }: { children: React.ReactNode; className?: string }) {
  const mctx = useContext(MenuContext);
  const sctx = useContext(SubContext);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (!sctx?.open) return;
    const anchor = sctx.anchorRef.current;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    setPos({ top: Math.min(r.top, window.innerHeight - 240), left: Math.min(r.right + 16, window.innerWidth - 200) });
  }, [sctx]);
  if (!mctx?.open || !sctx?.open || !pos) return null;
  return (
    <div className="fixed inset-0 z-50 pointer-events-none">
      <div
        className={cn('pointer-events-auto z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md bg-white dark:bg-neutral-900', className)}
        style={{ position: 'fixed', top: pos.top, left: pos.left }}
        onMouseLeave={() => sctx.setOpen(false)}
      >
        {children}
      </div>
    </div>
  );
}

// Simple inline submenu imitation using label and indented items.
export const ContextMenu = Object.assign(ContextMenuRoot as React.FC<{ children: React.ReactNode }>, {
  Trigger: ContextMenuTriggerBase,
  Content: ContextMenuContentBase,
  Item: ContextMenuItemBase,
  Separator: ContextMenuSeparatorBase,
  Label: ContextMenuLabelBase,
  Shortcut: ContextMenuShortcutBase,
  CheckboxItem: ContextMenuCheckboxItemBase,
  RadioGroup: ContextMenuRadioGroupBase,
  RadioItem: ContextMenuRadioItemBase,
  Sub: ContextMenuSubBase,
  SubTrigger: ContextMenuSubTriggerBase,
  SubContent: ContextMenuSubContentBase
});

export const ContextMenuTrigger = ContextMenuTriggerBase;
export const ContextMenuContent = ContextMenuContentBase;
export const ContextMenuItem = ContextMenuItemBase;
export const ContextMenuSeparator = ContextMenuSeparatorBase;
export const ContextMenuLabel = ContextMenuLabelBase;
export const ContextMenuShortcut = ContextMenuShortcutBase;
export const ContextMenuCheckboxItem = ContextMenuCheckboxItemBase;
export const ContextMenuRadioGroup = ContextMenuRadioGroupBase;
export const ContextMenuRadioItem = ContextMenuRadioItemBase;
export const ContextMenuSub = ContextMenuSubBase;
export const ContextMenuSubTrigger = ContextMenuSubTriggerBase;
export const ContextMenuSubContent = ContextMenuSubContentBase;
