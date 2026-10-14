/// <reference types="vite/client" />

/**
 * Typed build-time configuration.
 *
 * Vite's own `ImportMetaEnv` carries an `[key: string]: any` index signature,
 * so every `import.meta.env.X` read would otherwise be `any` — which the
 * workspace lint config rejects outright (`no-unsafe-assignment`). Declaring
 * each variable here makes the read `string | undefined` and forces the call
 * site to handle a missing value.
 *
 * Everything prefixed `VITE_` is inlined into the client bundle and is public
 * by construction. No secret may ever be added here (PLAN.md §12.1).
 */
interface ImportMetaEnv {
  /** Base URL of the control plane REST API. Defaults to `/api/v1`. */
  readonly VITE_API_BASE_URL?: string;
}
