/**
 * The real control-plane API's own origin, for server-side fetches (Server
 * Components, Route Handlers) that talk to it directly rather than through
 * the browser-facing `/api/*` rewrite in next.config.ts. Must match that
 * rewrite's own default — see its comment for why a rewrite exists at all.
 */
export const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:4000';
