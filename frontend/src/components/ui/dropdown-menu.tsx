'use client';

import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

interface MenuContextValue {
  close: () => void;
}
const MenuContext = createContext<MenuContextValue | null>(null);

interface DropdownMenuProps {
  /** Visible content of the trigger button. */
  trigger: ReactNode;
  /** Accessible name for the trigger. */
  label: string;
  /** Tailwind classes for the trigger (use `buttonVariants` for consistency). */
  triggerClassName?: string;
  align?: 'start' | 'end';
  /** Extra classes for the menu panel (for example a wider min-width). */
  menuClassName?: string;
  children: ReactNode;
}

/** Accessible dropdown: click-outside, Escape, and arrow/Home/End keyboard navigation. */
export function DropdownMenu({ trigger, label, triggerClassName, align = 'end', menuClassName, children }: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = (): void => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const rect = trigger.getBoundingClientRect();
      const gap = 6;
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      let top = rect.bottom + gap;
      if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - gap - height);
      let left = align === 'end' ? rect.right - width : rect.left;
      left = Math.min(Math.max(8, left), Math.max(8, window.innerWidth - width - 8));
      setPos({ top, left });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (!(event.target instanceof Node)) return;
      if (rootRef.current?.contains(event.target) || menuRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
    const index = items.findIndex((el) => el === document.activeElement);
    const focusAt = (i: number): void => {
      event.preventDefault();
      items[(i + items.length) % items.length]?.focus();
    };
    switch (event.key) {
      case 'ArrowDown': focusAt(index + 1); break;
      case 'ArrowUp': focusAt(index - 1); break;
      case 'Home': focusAt(0); break;
      case 'End': focusAt(items.length - 1); break;
      case 'Escape': event.preventDefault(); close(true); break;
      case 'Tab': close(); break;
      default: break;
    }
  }

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open && createPortal(
        <MenuContext.Provider value={{ close: () => close(true) }}>
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={label}
            onKeyDown={onMenuKeyDown}
            style={{ position: 'fixed', top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
            className={cn(
              'z-50 min-w-[13rem] animate-fade-in rounded-lg border bg-card p-1 shadow-lg',
              menuClassName,
            )}
          >
            {children}
          </div>
        </MenuContext.Provider>,
        document.body,
      )}
    </div>
  );
}

interface DropdownMenuItemProps {
  onSelect: () => void;
  children: ReactNode;
  icon?: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
}

export function DropdownMenuItem({ onSelect, children, icon, destructive, disabled }: DropdownMenuItemProps) {
  const ctx = useContext(MenuContext);
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        onSelect();
        ctx?.close();
      }}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm outline-none transition-colors hover:bg-muted focus:bg-muted disabled:opacity-50',
        destructive && 'text-destructive hover:bg-destructive/15 focus:bg-destructive/15',
      )}
    >
      {icon && <span className="flex h-4 w-4 items-center justify-center text-muted-foreground" aria-hidden>{icon}</span>}
      {children}
    </button>
  );
}

export function DropdownMenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 py-2 text-xs text-muted-foreground">{children}</div>;
}

export function DropdownMenuSeparator() {
  return <div role="separator" className="-mx-1 my-1 h-px bg-border" />;
}
