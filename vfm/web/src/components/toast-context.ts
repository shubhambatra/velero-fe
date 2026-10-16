import { createContext, useContext } from 'react';

export interface Follow {
  orgId: string;
  clusterId: string;
  commandId: string;
  /** What was asked, e.g. "Create backup nightly-1". */
  title: string;
}

export const ToastContext = createContext<{ follow: (toast: Follow) => void }>({
  follow: () => undefined,
});

/** Follow a command until it ends and say how it went, wherever the user navigates meanwhile. */
export const useToasts = () => useContext(ToastContext);
