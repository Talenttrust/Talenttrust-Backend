import pathToRegexp = require('path-to-regexp');
import { RequestHandler, Request, Response, NextFunction } from 'express';
import { config, explorerUrl } from './config';
import { docsHtml, openapi } from './openapi';
import { EscrowStore, HttpError } from './store';

/** HTTP methods the registry can advertise and register. */
export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** A route handler. Returned objects are serialized as JSON by {@link wrap}. */
export type RouteHandler = (req: Request, res: Response) => unknown;

/**
 * A single entry in the route registry.
 *
 * The same list is used to register Express handlers and to generate the
 * `endpoints` array exposed by `GET /`, so the two can never drift.
 */
export interface RouteDefinition {
  method: HttpMethod;
  /** Full path, including the `/api/v1` prefix where applicable. */
  path: string;
  handler: RouteHandler;
  /**
   * Whether the route appears in the `GET /` endpoint list. Defaults to true;
   * the root route is registered but omitted to keep the documented list
   * stable.
   */
  listed?: boolean;
}

/** Prefix for the versioned API router. */
export const API_PREFIX = '/api/v1';

/** Canonical ordering for `Allow` headers. */
const METHOD_ORDER: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];

const isApiRoute = (route: RouteDefinition) =>
  route.path === API_PREFIX || route.path.startsWith(`${API_PREFIX}/`);

const id = (req: Request) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'invalid_id', 'id must be a positive integer');
  return n;
};

/**
 * Wraps a handler so returned values are sent as JSON and thrown errors reach
 * the Express error middleware.
 */
export const wrap =
  (fn: RouteHandler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const out = fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      next(err);
    }
  };

/**
 * Builds the route registry for an escrow store.
 *
 * Keep this list in the order routes should be matched and displayed.
 *
 * @param store backing escrow store
 * @param startedAt epoch milliseconds when the process started (for `/health`)
 */
export function buildRoutes(store: EscrowStore, startedAt: number): RouteDefinition[] {
  const routes: RouteDefinition[] = [
    {
      method: 'get',
      path: '/',
      listed: false,
      handler: () => ({
        name: 'TalentTrust API',
        version: config.version,
        description: 'Milestone-based freelancer escrow API backed by a Soroban contract on Stellar.',
        docs: '/docs',
        openapi: '/openapi.json',
        website: config.frontendUrl,
        chain: { network: config.network, contractId: config.contractId, explorer: explorerUrl() },
        endpoints: endpointList(routes),
      }),
    },
    {
      method: 'get',
      path: '/health',
      handler: () => ({
        status: 'ok',
        version: config.version,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        storage: 'in-memory',
        timestamp: new Date().toISOString(),
      }),
    },
    { method: 'get', path: '/docs', handler: (_req, res) => {
      res.type('html').send(docsHtml);
    } },
    { method: 'get', path: '/openapi.json', handler: () => openapi },
    {
      method: 'get',
      path: `${API_PREFIX}/chain`,
      handler: () => ({
        network: config.network,
        rpcUrl: config.rpcUrl,
        contractId: config.contractId,
        explorer: explorerUrl(),
      }),
    },
    { method: 'get', path: `${API_PREFIX}/stats`, handler: () => store.stats() },
    {
      method: 'get',
      path: `${API_PREFIX}/contracts`,
      handler: (req) => ({
        data: store.list({
          status: typeof req.query.status === 'string' ? req.query.status : undefined,
          party: typeof req.query.party === 'string' ? req.query.party : undefined,
        }),
      }),
    },
    {
      method: 'post',
      path: `${API_PREFIX}/contracts`,
      handler: (req, res) => {
        res.status(201).json(store.create(req.body ?? {}));
      },
    },
    { method: 'get', path: `${API_PREFIX}/contracts/:id`, handler: (req) => store.get(id(req)) },
    {
      method: 'post',
      path: `${API_PREFIX}/contracts/:id/deposit`,
      handler: (req) => store.deposit(id(req), req.body?.amount),
    },
    {
      method: 'post',
      path: `${API_PREFIX}/contracts/:id/milestones/:index/release`,
      handler: (req) => store.release(id(req), Number(req.params.index)),
    },
    {
      method: 'post',
      path: `${API_PREFIX}/contracts/:id/dispute`,
      handler: (req) => store.openDispute(id(req), req.body?.raisedBy, req.body?.reason),
    },
    {
      method: 'post',
      path: `${API_PREFIX}/contracts/:id/resolve`,
      handler: (req) => store.resolveDispute(id(req), req.body?.freelancerBps),
    },
    {
      method: 'post',
      path: `${API_PREFIX}/contracts/:id/cancel`,
      handler: (req) => store.cancel(id(req)),
    },
    {
      method: 'post',
      path: `${API_PREFIX}/contracts/:id/reputation`,
      handler: (req) => store.rate(id(req), req.body?.rating),
    },
    {
      method: 'get',
      path: `${API_PREFIX}/reputation/:address`,
      handler: (req) => store.getReputation(req.params.address),
    },
  ];
  return routes;
}

/** Serializes a route into the `GET /` endpoint list format. */
export function formatEndpoint(route: RouteDefinition): string {
  return `${route.method.toUpperCase().padEnd(4)} ${route.path}`;
}

/** The endpoint list shown by `GET /`, derived from the registry. */
export function endpointList(routes: RouteDefinition[]): string[] {
  return routes.filter((route) => route.listed !== false).map(formatEndpoint);
}

/** Routes registered on the versioned API router. */
export function apiRoutes(routes: RouteDefinition[]): RouteDefinition[] {
  return routes.filter(isApiRoute);
}

/** Routes registered on the Express app itself. */
export function topLevelRoutes(routes: RouteDefinition[]): RouteDefinition[] {
  return routes.filter((route) => !isApiRoute(route));
}

/**
 * Minimal interface shared by an Express app and a router, so the same
 * registration helper works for both.
 */
export interface RouteTarget {
  get(path: string, handler: RequestHandler): unknown;
  post(path: string, handler: RequestHandler): unknown;
  put(path: string, handler: RequestHandler): unknown;
  patch(path: string, handler: RequestHandler): unknown;
  delete(path: string, handler: RequestHandler): unknown;
}

/**
 * Registers a single registry entry on an Express app or router.
 *
 * @param target Express app or router
 * @param route registry entry
 * @param prefix path prefix already stripped by the mount point
 */
export function registerRoute(target: RouteTarget, route: RouteDefinition, prefix = ''): void {
  const path = prefix ? route.path.slice(prefix.length) || '/' : route.path;
  const handler = wrap(route.handler);
  switch (route.method) {
    case 'get':
      target.get(path, handler);
      break;
    case 'post':
      target.post(path, handler);
      break;
    case 'put':
      target.put(path, handler);
      break;
    case 'patch':
      target.patch(path, handler);
      break;
    case 'delete':
      target.delete(path, handler);
      break;
  }
}

const compiledPaths = new Map<string, RegExp>();

function matchesPath(pattern: string, pathname: string): boolean {
  let matcher = compiledPaths.get(pattern);
  if (!matcher) {
    // Mirror Express defaults: case-insensitive and trailing-slash tolerant.
    matcher = pathToRegexp(pattern, [], { sensitive: false, strict: false });
    compiledPaths.set(pattern, matcher);
  }
  return matcher.test(pathname);
}

/**
 * Returns the methods a known path supports, in canonical `Allow` order.
 *
 * `HEAD` is implicit for every `GET` route, matching Express' default
 * behaviour. An empty result means the path is unknown.
 */
export function allowedMethods(routes: RouteDefinition[], pathname: string): string[] {
  const allowed = new Set<HttpMethod>();
  for (const route of routes) {
    if (matchesPath(route.path, pathname)) allowed.add(route.method);
  }
  const names: string[] = [];
  for (const method of METHOD_ORDER) {
    if (!allowed.has(method)) continue;
    names.push(method.toUpperCase());
    if (method === 'get') names.push('HEAD');
  }
  return names;
}
