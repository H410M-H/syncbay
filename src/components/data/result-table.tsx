"use client";

import styles from "./data.module.css";
import { cellText } from "./format";

/** Read-only rows (Query Studio result) as an accessible table. */
export function ResultTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: Array<{ name: string; type?: string }>;
  rows: Array<Record<string, unknown>>;
}) {
  if (rows.length === 0) return <p className={styles.muted}>No rows.</p>;
  const names = columns.length ? columns.map((c) => c.name) : Object.keys(rows[0] ?? {});
  return (
    <div className={`table-wrapper ${styles.tableScroll}`}>
      <table>
        <caption className={styles.srOnly}>{caption}</caption>
        <thead>
          <tr>
            {names.map((n) => (
              <th key={n} scope="col">
                {n}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {names.map((n) => {
                const { text, isNull } = cellText(row[n]);
                return (
                  <td key={n} className={`${styles.cell} ${isNull ? styles.cellNull : ""}`} title={isNull ? undefined : text}>
                    {text}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
