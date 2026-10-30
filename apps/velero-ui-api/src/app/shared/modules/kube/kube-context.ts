import { AsyncLocalStorage } from 'async_hooks';
import { NextFunction, Request, Response } from 'express';

/** Request header (and socket handshake field) that selects the target cluster context. */
export const KUBE_CONTEXT_HEADER = 'x-kube-context';

const store = new AsyncLocalStorage<string | undefined>();

/** The context selected for the request being handled, undefined means the default one. */
export const currentKubeContext = (): string | undefined => store.getStore();

export const runInKubeContext = <T>(context: string | undefined, fn: () => T): T =>
  store.run(context || undefined, fn);

export function kubeContextMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const value = req.headers[KUBE_CONTEXT_HEADER];
  runInKubeContext(typeof value === 'string' ? value : undefined, next);
}
