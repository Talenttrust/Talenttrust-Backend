/**
 * Domain types for the TalentTrust persistence layer.
 *
 * These interfaces are the canonical shapes stored in — and returned from — the
 * database.  Route handlers and repositories both consume these types so that
 * the rest of the codebase never needs to import driver-specific types.
 */

/** Status values that a contract can hold during its lifecycle. */
export type ContractStatus =
  | "draft"
  | "active"
  | "completed"
  | "disputed"
  | "cancelled";

/**
 * A freelancer escrow contract recorded on the platform.
 *
 * @field id          - UUID primary key
 * @field title       - Human-readable title for the engagement
 * @field clientId    - ID of the client user
 * @field freelancerId- ID of the freelancer user
 * @field amount      - Contract value in stroops (1 XLM = 10_000_000 stroops)
 * @field status      - Current lifecycle status
 * @field createdAt   - ISO-8601 creation timestamp
 */
export interface Contract {
  id: string;
  title: string;
  clientId: string;
  freelancerId: string;
  amount: number;
  status: ContractStatus;
  createdAt: string;
}

/** Role a user may hold on the platform. */
export type UserRole = "client" | "freelancer" | "both";

/**
 * A registered platform user.
 *
 * @field id         - UUID primary key
 * @field username   - Unique display name
 * @field email      - Unique email address
 * @field role       - Platform role
 * @field createdAt  - ISO-8601 creation timestamp
 */
export interface User {
  id: string;
  username: string;
  email: string;
  role: UserRole;
  createdAt: string;
}
