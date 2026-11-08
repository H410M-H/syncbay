"use client";

/**
 * Accessible dropdown menu (menu button pattern): a trigger button plus a `role="menu"` list.
 * - Opens on click, Enter, Space or ArrowDown (focus on the first item) / ArrowUp (last item).
 * - ArrowUp / ArrowDown / Home / End move between items, Escape closes and returns focus to the
 *   trigger, Tab closes, and a pointer press outside closes.
 * - The list is rendered in a portal with fixed positioning, so cards and scroll containers
 *   (which create their own stacking contexts) never clip or cover it.
 */

import Link from "next/link";
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface ActionMenuItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  /** Runs after the menu closes. */
  onSelect?: () => void;
  /** Renders a link instead of a button (internal routes use next/link). */
  href?: string;
  external?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /** Tooltip, e.g. why an item is disabled. */
  title?: string;
  separatorBefore?: boolean;
}

interface ActionMenuProps {
  /** Falsy entries are skipped, so items can be listed conditionally. */
  items: Array<ActionMenuItem | false | null | undefined | "">;
  /** Accessible name of the trigger and the menu, e.g. "Actions for project web". */
  label: string;
  /** Visible trigger content (default "⋯"). */
  trigger?: ReactNode;
  triggerClassName?: string;
  triggerStyle?: CSSProperties;
  minWidth?: number;
  align?: "left" | "right";
}

const GAP = 6;

export function ActionMenu({
  items,
  label,
  trigger = "⋯",
  triggerClassName = "btn btn-ghost btn-sm",
  triggerStyle,
  minWidth = 200,
  align = "right",
}: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef<"first" | "last">("first");
  const menuId = useId();
  const visible = items.filter(Boolean) as ActionMenuItem[];

  const itemElements = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const openMenu = (focus: "first" | "last") => {
    focusOnOpen.current = focus;
    setOpen(true);
  };

  // Place the menu under (or, without room, above) the trigger, aligned to its edge.
  const place = useCallback(() => {
    const t = triggerRef.current?.getBoundingClientRect();
    const m = menuRef.current;
    if (!t || !m) return;
    const height = m.offsetHeight;
    const width = Math.max(m.offsetWidth, minWidth);
    const below = t.bottom + GAP + height <= window.innerHeight || t.top - GAP - height < 0;
    const top = below ? t.bottom + GAP : t.top - GAP - height;
    const rawLeft = align === "right" ? t.right - width : t.left;
    const left = Math.min(Math.max(8, rawLeft), Math.max(8, window.innerWidth - width - 8));
    m.style.top = `${top}px`;
    m.style.left = `${left}px`;
    m.style.opacity = "1";
  }, [align, minWidth]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const els = itemElements();
    (focusOnOpen.current === "last" ? els[els.length - 1] : els[0])?.focus({ preventScroll: true });
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      close(false);
    };
    const onViewportChange = () => place();
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [open, close, place]);

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openMenu("first");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      openMenu("last");
    }
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const els = itemElements();
    const index = els.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      e.preventDefault();
      els[(to + els.length) % els.length]?.focus();
    };
    switch (e.key) {
      case "ArrowDown":
        return move(index + 1);
      case "ArrowUp":
        return move(index < 0 ? els.length - 1 : index - 1);
      case "Home":
        return move(0);
      case "End":
        return move(els.length - 1);
      case "Escape":
        e.preventDefault();
        return close(true);
      case "Tab":
        return close(false);
      case " ":
        // Space activates links too (buttons already handle it)
        if (document.activeElement instanceof HTMLAnchorElement) {
          e.preventDefault();
          document.activeElement.click();
        }
        return;
    }
  };

  const select = (item: ActionMenuItem) => {
    if (item.disabled) return;
    close(!item.href);
    item.onSelect?.();
  };

  const itemStyle = (item: ActionMenuItem): CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: "8px",
    width: "100%",
    textAlign: "left",
    justifyContent: "flex-start",
    color: item.danger ? "#f87171" : undefined,
    fontWeight: item.danger ? 600 : undefined,
    opacity: item.disabled ? 0.45 : 1,
    cursor: item.disabled ? "not-allowed" : "pointer",
  });

  const renderItem = (item: ActionMenuItem) => {
    const content = (
      <>
        {item.icon !== undefined && <span aria-hidden="true" style={{ width: "18px", textAlign: "center" }}>{item.icon}</span>}
        <span>{item.label}</span>
        {item.external && <span aria-hidden="true" style={{ marginLeft: "auto", fontSize: "10px" }}>↗</span>}
      </>
    );
    const common = {
      role: "menuitem" as const,
      tabIndex: -1,
      title: item.title,
      "aria-disabled": item.disabled || undefined,
      className: "btn btn-ghost btn-sm",
      style: itemStyle(item),
    };
    if (item.href && !item.disabled) {
      if (item.external) {
        return (
          <a key={item.key} {...common} href={item.href} target="_blank" rel="noopener noreferrer" onClick={() => select(item)}>
            {content}
          </a>
        );
      }
      return (
        <Link key={item.key} {...common} href={item.href} onClick={() => select(item)}>
          {content}
        </Link>
      );
    }
    return (
      <button key={item.key} type="button" {...common} onClick={() => select(item)}>
        {content}
      </button>
    );
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        style={triggerStyle}
        aria-label={typeof trigger === "string" && trigger.trim() === "⋯" ? label : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (open) close(false);
          else openMenu("first");
        }}
        onKeyDown={onTriggerKeyDown}
      >
        {trigger}
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={label}
            onKeyDown={onMenuKeyDown}
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              // Transparent (not visibility: hidden, which items would inherit through their
              // `.btn` transition and stay unfocusable for 0.2 s) until place() positions it.
              opacity: 0,
              zIndex: 1000,
              minWidth: `${minWidth}px`,
              padding: "6px",
              border: "1px solid var(--border-default)",
              borderRadius: "12px",
              background: "var(--bg-elevated)",
              boxShadow: "0 12px 32px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.08)",
              display: "flex",
              flexDirection: "column",
              gap: "2px",
            }}
          >
            {visible.map((item) => (
              <Fragment key={item.key}>
                {item.separatorBefore && (
                  <hr role="separator" style={{ border: "none", borderTop: "1px solid var(--border-subtle)", margin: "4px 0", width: "100%" }} />
                )}
                {renderItem(item)}
              </Fragment>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
