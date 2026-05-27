# Pagination

All list endpoints in TalentTrust Backend share a common pagination helper found in
`src/utils/pagination.ts`. This document covers the design decisions, public API, and
the bounds/rejection policy that every endpoint must follow.

---

## Bounds and Defaults

| Parameter | Default | Minimum | Maximum |
|-----------|---------|---------|---------|
| `page`    | `1`     | `1`     | *(unlimited)* |
| `limit`   | `20`    | `1`     | `100`   |

The constants are exported so they can be referenced in tests and documentation without
hardcoding magic numbers:

```ts
import { MAX_PAGE_LIMIT, DEFAULT_PAGE_LIMIT } from '../utils/pagination';
```

---

## Rejection Policy

The shared `paginationQuerySchema` and `parsePaginationQuery` helper use a **strict
rejection** approach rather than silent clamping:

| Input           | Outcome                          |
|-----------------|----------------------------------|
| Missing param   | Default value applied (safe)     |
| `page=1`        | Accepted                         |
| `page=0`        | **400 Bad Request** — rejected   |
| `page=-1`       | **400 Bad Request** — rejected   |
| `page=abc`      | **400 Bad Request** — rejected   |
| `page=1.5`      | **400 Bad Request** — rejected   |
| `limit=100`     | Accepted (at max)                |
| `limit=101`     | **400 Bad Request** — rejected   |
| `limit=0`       | **400 Bad Request** — rejected   |
| `limit=-5`      | **400 Bad Request** — rejected   |

**Rationale**: Silent clamping hides client misconfiguration and can silently return
wrong result sets. Explicit rejection surfaces bugs early and keeps API behaviour
predictable for all callers.

A legacy `getPaginationOptions` helper (clamping variant) is retained for backward
compatibility with internal tooling, but new endpoints must use `parsePaginationQuery`.

---

## Shared API

### `paginationQuerySchema`

Zod schema for `page` and `limit` query parameters. Designed to be extended by
module-specific schemas:

```ts
import { paginationQuerySchema } from '../../utils/pagination';

// Add module-specific filter fields while inheriting the shared bounds policy
export const myListSchema = paginationQuerySchema.extend({
  status: z.enum(['active', 'archived']).optional(),
});
```

### `parsePaginationQuery(query)`

Use in controller handlers to obtain validated, typed pagination options:

```ts
import { parsePaginationQuery } from '../utils/pagination';

const pagination = parsePaginationQuery(req.query as Record<string, unknown>);
if (!pagination.ok) {
  return res.status(400).json({ error: pagination.error });
}

const { page, limit, offset } = pagination.value;
```

Returns a discriminated union so the error path is always explicit — no exceptions
to catch.

### `applyPagination<T>(items, options)`

Slice an in-memory array using validated pagination options:

```ts
const allItems = await service.getAll();
const page = applyPagination(allItems, pagination.value);
```

For database-backed endpoints, pass `offset` and `limit` directly to the query
layer instead of loading all records first.

### `getPaginationMetadata(totalItems, options, itemCount)`

Build a standard metadata object to include in list responses:

```ts
const meta = getPaginationMetadata(total, pagination.value, page.length);
// { totalItems, itemCount, itemsPerPage, totalPages, currentPage }
```

---

## Response Shape

List endpoints should return pagination metadata alongside the data:

```json
{
  "status": "success",
  "data": [ /* current page items */ ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 42,
    "totalPages": 3
  }
}
```

---

## Enforcing the Limit in Routes

Apply the shared Zod schema as a `validateQuery` middleware **before** the controller
handler so invalid requests are rejected before any business logic runs:

```ts
import { validateQuery } from '../middleware/validation';
import { paginationQuerySchema } from '../utils/pagination';

router.get('/', validateQuery(paginationQuerySchema), MyController.list);
```

---

## Adding Pagination to a New Endpoint

1. Add `validateQuery(paginationQuerySchema)` (or an extended variant) to the route.
2. Call `parsePaginationQuery(req.query)` in the controller.
3. If the data source is in-memory, use `applyPagination`; otherwise pass `offset`
   and `limit` to your SQL/ORM query.
4. Return the `pagination` envelope in the response body.
