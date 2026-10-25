/**
 * Method handling derived from the routes actually registered on the Express
 * app (including mounted routers), so it can never drift from the handlers:
 *
 * - `allowedMethods(app, path)` lists the methods a known path supports
 *   (HEAD is implied by GET), sorted;
 * - `optionsHandler` answers OPTIONS on a known path with 204 + `Allow`;
 * - `methodNotAllowed` turns a known path with an unsupported method into 405.
 */
import type { Application, NextFunction, Request, Response } from 'express';
import { HttpError } from './amount-error';

interface Layer {
  route?: { methods: Record<string, boolean> };
  name?: string;
  path?: string;
  handle: { stack?: Layer[] };
  match(path: string): boolean;
}

function collect(stack: Layer[] | undefined, path: string, out: Set<string>): void {
  for (const layer of stack ?? []) {
    if (layer.route) {
      if (layer.match(path)) {
        for (const [method, enabled] of Object.entries(layer.route.methods)) {
          if (enabled && method !== '_all') out.add(method.toUpperCase());
        }
      }
    } else if (layer.name === 'router' && layer.handle.stack && layer.match(path)) {
      // Express sets layer.path to the matched mount prefix.
      const rest = path.slice((layer.path ?? '').length) || '/';
      collect(layer.handle.stack, rest.startsWith('/') ? rest : `/${rest}`, out);
    }
  }
}

export function allowedMethods(app: Application, path: string): string[] {
  const out = new Set<string>();
  collect((app as unknown as { _router?: { stack: Layer[] } })._router?.stack, path, out);
  if (out.has('GET')) out.add('HEAD');
  out.delete('OPTIONS');
  return [...out].sort();
}

export const optionsHandler = (app: Application) => (req: Request, res: Response, next: NextFunction) => {
  if (req.method !== 'OPTIONS') return next();
  const allowed = allowedMethods(app, req.path);
  if (allowed.length === 0) return next();
  res.set('Allow', allowed.join(', '));
  res.status(204).end();
};

export const methodNotAllowed = (app: Application) => (req: Request, res: Response, next: NextFunction) => {
  const allowed = allowedMethods(app, req.path);
  if (allowed.length === 0 || allowed.includes(req.method)) return next();
  res.set('Allow', allowed.join(', '));
  next(new HttpError(405, 'method_not_allowed', `Method ${req.method} is not allowed for ${req.path}`, { allowed }));
};
