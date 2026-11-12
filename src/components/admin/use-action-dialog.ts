"use client";

import { useCallback, useState } from "react";
import { errorMessage } from "./format";

/**
 * State for one confirm/reason dialog at a time: which target it is open for, whether the action
 * is running and the error to show. `run()` keeps the dialog open with the error on failure and
 * closes it on success.
 */
export function useActionDialog<T>() {
  const [target, setTarget] = useState<T | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback((t: T) => {
    setTarget(t);
    setError(null);
    setBusy(false);
  }, []);

  const close = useCallback(() => {
    setTarget(null);
    setError(null);
    setBusy(false);
  }, []);

  const run = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await action();
        close();
      } catch (err) {
        setBusy(false);
        setError(errorMessage(err, "Action failed"));
      }
    },
    [close]
  );

  return { target, busy, error, open, close, run };
}
