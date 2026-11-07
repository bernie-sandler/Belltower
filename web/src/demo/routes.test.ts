// Keeps the demo's routes in step with the Fastify server: every route registered in
// server/src/http/routes must have a demo handler, and the demo must not answer routes the server
// doesn't have. The response types are checked by `npm run typecheck` (see DemoApi in routes.ts).

import { describe, expect, it } from 'vitest';
import { matchRoute, routes } from './server/routes';

const sources = import.meta.glob('../../../server/src/http/routes/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** "METHOD /path" for every /api route a server route file registers. */
function serverRoutes(): string[] {
  const out = new Set<string>();
  for (const src of Object.values(sources)) {
    for (const m of src.matchAll(/app\.(get|post|put|patch|delete)\(\s*'(\/api[^']*)'/g)) {
      out.add(`${m[1]!.toUpperCase()} ${m[2]}`);
    }
    // Routes registered in a loop: for (const [path, run] of [['/api/ai/draft', …], …]) app.post(path, …)
    const loop = /app\.(get|post|put|patch|delete)\(\s*path\b/.exec(src);
    if (loop) {
      for (const m of src.matchAll(/\[\s*'(\/api[^']*)'\s*,\s*\w+\s*\]/g)) out.add(`${loop[1]!.toUpperCase()} ${m[1]}`);
    }
  }
  return [...out].sort();
}

describe('demo routes', () => {
  it('reads the server route files', () => {
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(9);
    expect(serverRoutes()).toContain('GET /api/board');
    expect(serverRoutes()).toContain('POST /api/ai/draft-many');
  });

  it('has a handler for every server route, and nothing more', () => {
    const demo = Object.keys(routes).sort();
    const server = serverRoutes();
    expect(server.filter((r) => !demo.includes(r)), 'server routes with no demo handler (add them to web/src/demo/server/routes.ts)').toEqual([]);
    expect(demo.filter((r) => !server.includes(r)), 'demo routes the server no longer has').toEqual([]);
  });

  it('prefers static routes over parametric ones, like Fastify', () => {
    expect(matchRoute('PUT', '/api/request-types/order')?.key).toBe('PUT /api/request-types/order');
    expect(matchRoute('PUT', '/api/request-types/3')).toEqual({ key: 'PUT /api/request-types/:id', params: { id: '3' } });
    expect(matchRoute('POST', '/api/cards/move-many')?.key).toBe('POST /api/cards/move-many');
    expect(matchRoute('POST', '/api/cards/archive-done')?.key).toBe('POST /api/cards/archive-done');
    expect(matchRoute('POST', '/api/cards/12/archive')?.params).toEqual({ id: '12' });
    expect(matchRoute('GET', '/api/nope')).toBeNull();
  });
});
