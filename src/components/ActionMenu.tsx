import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { MoreVertical } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface ActionMenuItem {
  key: string;
  label: string;
  icon?: LucideIcon;
  /** danger → alert-fg text: a destructive claim, always visible in the open menu (§6). */
  tone?: 'default' | 'danger';
  disabled?: boolean;
  hidden?: boolean;
  onSelect: () => void;
}

const GAP = 4;          // px between trigger and menu
const VIEWPORT_PAD = 8; // px the menu keeps from the viewport edge

/**
 * Shared row-actions menu: a MoreVertical ghost trigger opening a portal menu.
 *
 * Portal because DataTable wraps its content in overflow-hidden / overflow-x-auto containers
 * that would clip an absolutely-positioned dropdown. Position is computed from the trigger's
 * rect with LOGICAL intent — the menu's inline-end edge aligns to the trigger's inline-end
 * edge — and only then resolved to physical left/top for the fixed-position style (the one
 * place physical values are legitimate, because they are derived from the document direction,
 * never hardcoded).
 *
 * Closes on outside pointerdown, Escape (focus returns to the trigger), scroll/resize (no
 * repositioning — closing is honest and cheap), and after selection. Full menu keyboard
 * pattern: ArrowUp/ArrowDown cycle, Home/End, Enter/Space activate; disabled items are
 * skipped and inert.
 */
export function ActionMenu({ items, label = 'פעולות' }: { items: ActionMenuItem[]; label?: string }) {
  const visible = items.filter((i) => !i.hidden);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback((focusTrigger = false) => {
    setOpen(false);
    setPos(null);
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  // Measure after the (hidden) menu renders, then place it: below the trigger, or above when
  // the viewport has no room below. Inline position aligns end edges — derived once from the
  // document direction, not from a hardcoded physical side.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const rect = trigger.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const rtl = document.documentElement.dir === 'rtl';
    // end-edge alignment: in RTL the inline-end edge is the physical left one.
    let left = rtl ? rect.left : rect.right - mw;
    left = Math.min(Math.max(left, VIEWPORT_PAD), window.innerWidth - mw - VIEWPORT_PAD);
    let top = rect.bottom + GAP;
    if (top + mh > window.innerHeight - VIEWPORT_PAD && rect.top - mh - GAP >= VIEWPORT_PAD) {
      top = rect.top - mh - GAP;
    }
    setPos({ top, left });
  }, [open]);

  // Focus the first enabled item once positioned — the roving-focus anchor for the arrow keys.
  useLayoutEffect(() => {
    if (!open || !pos) return;
    menuRef.current
      ?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')
      ?.focus();
  }, [open, pos]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation(); // an open menu consumes Escape — a Modal underneath must not also close
      close(true);
    };
    const onDismiss = () => close(); // scroll/resize: the anchor moved — just close
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onDismiss, true);
    window.addEventListener('resize', onDismiss);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onDismiss, true);
      window.removeEventListener('resize', onDismiss);
    };
  }, [open, close]);

  if (visible.length === 0) return null;

  const enabledItems = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []);

  const onMenuKeyDown = (e: ReactKeyboardEvent) => {
    const nodes = enabledItems();
    if (!nodes.length) return;
    const idx = nodes.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); nodes[(idx + 1) % nodes.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); nodes[(idx - 1 + nodes.length) % nodes.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); nodes[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); nodes[nodes.length - 1].focus(); }
    else if (e.key === 'Tab') { e.preventDefault(); close(true); }
  };

  return (
    <>
      <button ref={triggerRef} type="button" className="btn-ghost p-1.5! min-w-10 min-h-10"
        aria-haspopup="menu" aria-expanded={open} aria-label={label}
        onClick={() => (open ? close() : setOpen(true))}>
        <MoreVertical size={16} aria-hidden="true" />
      </button>
      {open && createPortal(
        <div ref={menuRef} role="menu" aria-orientation="vertical" aria-label={label}
          onKeyDown={onMenuKeyDown}
          style={{ position: 'fixed', top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
          className="z-50 min-w-40 max-w-64 rounded-lg border border-line bg-surface py-1 shadow-menu">
          {visible.map((it) => (
            <button key={it.key} type="button" role="menuitem" tabIndex={-1}
              aria-disabled={it.disabled || undefined}
              className={`flex w-full items-center gap-2 px-3 py-2 text-sm text-start transition-colors focus:outline-none ${
                it.disabled
                  ? 'text-ink-ghost cursor-default'
                  : `${it.tone === 'danger' ? 'text-alert-fg' : 'text-ink-body'} hover:bg-surface-sunken focus:bg-surface-sunken active:bg-surface-sunken cursor-pointer`
              }`}
              onClick={() => {
                if (it.disabled) return;
                close(true); // restore focus first, so a modal the action opens records the trigger as its opener
                it.onSelect();
              }}>
              {it.icon && <it.icon size={15} className="shrink-0" aria-hidden="true" />}
              <span className="min-w-0 truncate">{it.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
