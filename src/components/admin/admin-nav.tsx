"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./admin.module.css";

export interface AdminNavItem {
  href: string;
  label: string;
  icon: string;
}

/** Staff console navigation: a sidebar on desktop, a horizontal scroll bar on phones. */
export function AdminNav({ items }: { items: AdminNavItem[] }) {
  const pathname = usePathname();
  const isActive = (href: string) => (href === "/admin" ? pathname === "/admin" : pathname === href || pathname.startsWith(`${href}/`));

  return (
    <nav className={styles.nav} aria-label="Staff console">
      {items.map((item) => {
        const active = isActive(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`${styles.navLink} ${active ? styles.navLinkActive : ""}`}
            aria-current={active ? "page" : undefined}
          >
            <span aria-hidden="true">{item.icon}</span>
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
