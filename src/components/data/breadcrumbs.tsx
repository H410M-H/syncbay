"use client";

import styles from "./data.module.css";

/**
 * Folder breadcrumbs: root + one button per segment; the last one is the current location.
 * `onNavigate(depth)` gets the number of segments to keep (0 = root).
 */
export function Breadcrumbs({
  rootLabel,
  segments,
  onNavigate,
  label,
}: {
  rootLabel: string;
  segments: string[];
  onNavigate: (depth: number) => void;
  label: string;
}) {
  const crumbs = [rootLabel, ...segments];
  return (
    <nav aria-label={label}>
      <ol className={styles.breadcrumbs}>
        {crumbs.map((name, depth) => {
          const current = depth === crumbs.length - 1;
          return (
            <li key={`${depth}:${name}`} className={styles.crumbItem}>
              {depth > 0 && (
                <span aria-hidden="true" className={styles.crumbSep}>
                  /
                </span>
              )}
              {current ? (
                <span className={styles.crumbCurrent} aria-current="location">
                  {name}
                </span>
              ) : (
                <button type="button" className={styles.crumb} onClick={() => onNavigate(depth)}>
                  {name}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
