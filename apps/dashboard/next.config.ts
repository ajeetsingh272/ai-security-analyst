import type { NextConfig } from 'next';

// Every browser request for /api/* is proxied server-side to the real
// control-plane API (apps/api) rather than the browser ever talking to a
// second origin directly. This is what makes the session cookie "just
// work" with no CORS configuration anywhere: the browser only ever sees
// one origin (this Next.js app's own), and Next's rewrite forwards the
// request/response — Set-Cookie included — to and from the real backend
// behind the scenes. API_BASE_URL defaults to apps/api's own default dev
// port (server.ts's API_PORT default).
const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  // @sentinel/ui and @sentinel/design-tokens are consumed as raw TypeScript
  // source (their package.json "exports" point straight at src/*.ts, no
  // build step) — pnpm's workspace symlink puts them under node_modules,
  // which Next excludes from compilation by default on the assumption
  // anything there is already-built JS. Without this, importing @sentinel/ui
  // fails with a syntax error on the first JSX it hits.
  transpilePackages: ['@sentinel/ui', '@sentinel/design-tokens'],
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_BASE_URL}/:path*` }];
  },
  // The repo-wide convention is relative imports with an explicit `.js`
  // extension pointing at a sibling `.ts`/`.tsx` file (e.g.
  // packages/ui/src/index.ts importing './Button.js', which is actually
  // Button.tsx) — standard for `moduleResolution: "bundler"` under tsc,
  // which treats that as "resolve this specifier, then look for the
  // source file" rather than a literal filename. Webpack's own resolver
  // has no equivalent built in: given an already-`.js`-suffixed specifier
  // it looks for that exact file and nothing else, so every @sentinel/ui
  // import fails with "Module not found" without this. `extensionAlias`
  // is webpack 5's own mechanism for the same TS-source-package pattern.
  webpack(config) {
    config.resolve.extensionAlias = {
      '.js': ['.js', '.ts', '.tsx'],
    };
    return config;
  },
};

export default nextConfig;
