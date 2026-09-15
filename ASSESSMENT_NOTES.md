# ProjectFlow — Engineering Assessment Notes

**Candidate:** Mohamed Hany Ahmed Mohamed Azzam  
**Position:** Full-Stack Developer Intern  
**Company:** Engtechno  
**Date:** September 2026  

---

## 1. System Architecture Overview

### 1.1 How is the application structured, and what are the major modules?
ProjectFlow is structured as an enterprise-grade TypeScript monorepo managed via **Turborepo** and **pnpm workspaces**:

- **`apps/api` (Backend):** Built with **NestJS**, leveraging a modular domain-driven structure:
  - `AuthModule`: Handles user registration, JWT generation, password hashing via `bcrypt`, and global `JwtAuthGuard`.
  - `UsersModule`: Manages user accounts, profile retrieval, and batch user queries (`findManyByIds`).
  - `OrganizationsModule`: Manages multi-tenant organizations and organization-level membership roles (`OWNER`, `ADMIN`, `MEMBER`).
  - `ProjectsModule`: Manages project lifecycles, project keys (e.g., `ENG`), and project membership rosters (`ProjectMembersService`).
  - `TasksModule`: Core task domain managing task lifecycles, assignment, comments, activity audit logging (`TaskActivity`), and counter sequencing (`ProjectCounter`).
  - `CommonModule`: Shared filters, exception decorators, and MongoDB ObjectId validation utilities (`toObjectId`).

- **`apps/web` (Frontend):** Built with **Next.js 16** (App Router, React 19) and **Tailwind CSS v4**:
  - `features/auth`: Login, registration, and persistent session management.
  - `features/organizations`: Organization switcher and member administration.
  - `features/projects`: Project dashboards, settings, and member rosters.
  - `features/tasks`: Kanban board, task creation dialogs, task detail views, `AssigneeSelector`, and `ActivityTimeline`.
  - `components/ui`: Radix UI accessible primitives styled with Tailwind CSS.

- **`packages/shared` (Contracts):** Shared package (`@projectflow/shared`) exposing shared TypeScript interfaces, enums (`TaskStatus`, `TaskPriority`, `ProjectRole`, `OrganizationRole`, `ActivityType`), and API DTO contracts, eliminating type drift between backend and frontend.

---

### 1.2 Where does business logic live?
Business logic is strictly decoupled across a three-tier architecture:
1. **Controllers (`apps/api/src/**/*.controller.ts`):** Strictly thin adapters responsible only for HTTP route binding, parameter extraction, and DTO validation pipes.
2. **Domain Services (`TasksService`, `ProjectsService`, etc.):** Encapsulate all core business workflows, data mutations, and transaction coordination.
3. **Authorization Engine (`ProjectAccessService`):** Dedicated, centralized service that acts as the single source of truth for authorization, ensuring consistent access rules across all project and task operations.

---

### 1.3 How does the frontend talk to the backend, and how is server state handled?
- **HTTP Transport:** The frontend communicates with the NestJS REST API using a centralized HTTP client (`apps/web/src/lib/api-client.ts`) that automatically attaches Bearer JWT authentication tokens and normalizes API error responses into structured application errors.
- **Server State Management:** Managed entirely via **TanStack React Query v5**:
  - **Query Key Hierarchy:** Centralized in `apps/web/src/lib/query-keys.ts` (`projects`, `tasks`, `taskActivity`, `projectMembers`).
  - **Optimistic UI Updates:** Task assignment and status mutations immediately reflect in the UI with instant cache manipulation. If a network or authorization error occurs, the cache rolls back to the previous snapshot, and an error toast is surfaced.
  - **Automatic Cache Invalidation:** Successful mutations trigger targeted query invalidations, ensuring eventual consistency with zero manual refetching logic.

---

### 1.4 How are authentication and authorization implemented?
1. **Authentication:**
   - Stateless JWT tokens signed with `JWT_SECRET`.
   - Applied globally via NestJS `APP_GUARD` (`JwtAuthGuard`), allowing public access only to routes explicitly annotated with `@Public()`.
   - The authenticated user payload is extracted via a custom `@CurrentUser()` decorator.

2. **Authorization Model (Multi-Tenant Two-Tier RBAC):**
   - **Organization Tier:** Roles are `OWNER`, `ADMIN`, and `MEMBER`. Organization `OWNER`s and `ADMIN`s hold administrative authority over all projects within that organization.
   - **Project Tier:** Explicit project memberships with roles: `PROJECT_MANAGER` and `MEMBER`.
   - **Access Resolution Flow:**
     ```
     Incoming Request ──▶ JwtAuthGuard (Valid JWT?)
                              │
                              ▼
                     ProjectAccessService
                              │
             ┌────────────────┴────────────────┐
             ▼                                 ▼
      Org OWNER / ADMIN?             Active Project Member?
      (Full Project Access)          (Role: PROJECT_MANAGER vs MEMBER)
     ```
   - **Task Assignment Authorization Rules:**
     - **Rule 1 (Project Membership):** Assignees must be active members of the task's project.
     - **Rule 2 (Manager vs. Self-Assignment):** Org `OWNER`/`ADMIN` and `PROJECT_MANAGER` can assign any project member or unassign tasks. Regular `MEMBER`s can only assign tasks to themselves.
     - **Rule 3 (Unassignment):** Only authorized managers can remove an assignee.

---

### 1.5 How are the main entities related?
```
User (1) ───< (N) OrganizationMember (N) >─── (1) Organization
                                                      │ (1)
                                                      │
                                                      ▼ (N)
User (1) ───< (N) ProjectMember (N) >────────── (1) Project
                                                      │ (1)
                                                      ├─────── (1) ProjectCounter
                                                      │
                                                      ▼ (N)
User (assignee) ───┐                                 Task
User (creator)  ───┼───────────────────────────────────┤ (1)
                   │                                   ├───< (N) Comment >─── User (author)
                   │                                   │
                   └───────────────────────────────────└───< (N) TaskActivity >─── User (actor)
```

- **Organization ➔ Project:** 1-to-N. Projects are strictly scoped to a single organization.
- **Project ➔ Task:** 1-to-N. Tasks belong to a single project and carry an incremental sequence number scoped to that project.
- **Task ➔ Assignee / Creator:** 1-to-1 relations referencing the `User` collection.
- **Task ➔ TaskActivity:** 1-to-N audit log recording assignment changes, status updates, and comments.

---

## 2. Identified System Risks & Weaknesses (Observations)

### Risk 1: Concurrency Race Condition in Sequential Task Numbering
- **What I Noticed:** In `TasksService.create()`, the original code calculated sequential task numbers using:
  ```typescript
  const count = await this.taskModel.countDocuments({ projectId });
  const taskNumber = count + 1;
  ```
- **Why It Could Be a Problem:** Under concurrent requests (e.g., two users creating tasks simultaneously in the same project), both requests read the exact same count and generate identical task numbers (e.g., two `ENG-5` tasks). This triggers MongoDB duplicate key violations (`E11000`) or leaves corrupt sequential identifiers.
- **Decision:** **Fixed Now.**
- **Why:** Data corruption in primary entity keys is a critical defect. I created an atomic `ProjectCounter` collection using MongoDB's `$inc` operator with `findOneAndUpdate({ projectId }, { $inc: { seq: 1 } }, { upsert: true, new: true })`. This guarantees atomic O(1) sequential numbering with zero race conditions.

---

### Risk 2: Broken Object Level Authorization (BOLA) in Task Status Updating
- **What I Noticed:** In `TasksController.updateStatus` and `TasksService.updateStatus`, the endpoint accepted `taskId` and directly updated `task.status` without verifying whether the requesting user had access to the underlying project.
- **Why It Could Be a Problem:** Any authenticated user across any organization could change the status of any task across the entire system simply by guessing or knowing its `taskId` (OWASP API Security Top 10 - API1:2023).
- **Decision:** **Fixed Now.**
- **Why:** This was a severe cross-tenant security vulnerability. I updated the endpoint to extract the authenticated user ID and enforced `this.projectAccessService.assertCanView(task.projectId, userId)` before allowing the mutation. Full details and reproduction steps are documented in `BUG_REPORT.md`.

---

### Risk 3: Cross-Platform Environment Variable Syntax in Monorepo Dev Scripts
- **What I Noticed:** `apps/web/package.json` used bash-specific parameter expansion for port binding: `"dev": "next dev -p ${WEB_PORT:-3742}"`.
- **Why It Could Be a Problem:** On Windows environments (PowerShell or CMD), this syntax fails with a parsing error, preventing the web development server from starting and violating the evaluation principle of reproducible developer experience.
- **Decision:** **Fixed Now.**
- **Why:** Any engineer evaluating the repository should be able to run `pnpm dev` immediately on any operating system (macOS, Linux, Windows) without troubleshooting command line scripts.
- **Remediation:** Configured the default port directly to `3742` in `apps/web/package.json`.

---

### Risk 4: Missing Cross-Collection Transactions on Cascading Deletions
- **What I Noticed:** When tasks or projects are deleted, associated comments and activities are deleted via sequential, uncoordinated queries:
  ```typescript
  await this.commentModel.deleteMany({ taskId });
  await this.taskActivityModel.deleteMany({ taskId });
  await this.taskModel.findByIdAndDelete(taskId);
  ```
- **Why It Could Be a Problem:** If the server crashes or MongoDB encounters an error halfway through execution, orphaned records remain permanently in the database, leading to wasted storage and corrupt analytics.
- **Decision:** **Fix Later.**
- **Why:** MongoDB multi-document transactions require replica sets, which are typically absent in local single-node development databases. Introducing transactions locally would break development without Docker/Atlas. This should be implemented when deploying to production replica-set clusters.

---

### Risk 5: Unbounded Offset Pagination in Activity & Task History
- **What I Noticed:** `getActivity` and task lists rely on offset pagination (`skip(page * pageSize).limit(pageSize)`).
- **Why It Could Be a Problem:** In MongoDB, `skip()` scans every preceding document B-tree index entry. For large collections (e.g. 500,000+ activity events), queries with large skip values cause high CPU spikes and query latencies exceeding 2 seconds.
- **Decision:** **Fix Later.**
- **Why:** For the current dataset size, offset pagination is fast and matches the simple frontend pagination UI. Migrating to cursor-based pagination (`_id` / `createdAt` cursor tokens) should be scheduled as part of the 50K+ scaling milestone.

---

## 3. Code Review Exercise

### Provided Code Snippet
```typescript
async assignTask(taskId: string, assigneeId: string, userId: string) {
  const task = await this.taskModel.findById(taskId);
  if (!task) { throw new NotFoundException(); }
  const user = await this.userModel.findById(assigneeId);
  if (!user) { throw new NotFoundException(); }
  task.assignee = user._id;
  await task.save();
  return task;
}
```

### Review Feedback

| Issue | Severity | Analysis & Remediation |
|---|---|---|
| **Broken Object Level Authorization (BOLA)** | 🔴 Critical | The method accepts `userId` but never checks if `userId` is authorized to modify the task or project. Any authenticated user could reassign any task. Must call `ProjectAccessService.assertCanView/Manage`. |
| **Missing Project Membership Validation** | 🔴 Critical | The method verifies that `assigneeId` exists in the `users` collection, but fails to check if that user is an active member of `task.projectId`. A user from an external organization could be assigned to a private project. |
| **No Activity Audit Logging** | 🟠 High | Changing task assignment is a critical project event. This implementation creates no `TaskActivity` record, breaking auditability. |
| **No Support for Unassignment** | 🟠 High | `assigneeId: string` fails or throws if `null`/`undefined` is passed to unassign a task. Assignment systems must support clearing assignees. |
| **Mongoose CastError Handling** | 🟡 Medium | Passing invalid ObjectId strings to `findById` causes Mongoose to throw a raw `CastError` (resulting in an unhandled 500 error) instead of an HTTP 400 Bad Request. |
| **Unsanitized Entity Return** | 🟡 Medium | Directly returning the Mongoose document leaks internal metadata (`__v`, schema internals) rather than returning a serialized `TaskDetail` DTO. |

---

## 4. Scaling Strategy: 5,000 to 500,000 Active Users

Scaling from 5K to 500K users requires strategic architectural evolution:

1. **Database Indexing & Sharding:**
   - Maintain targeted compound indexes: `{ taskId: 1, createdAt: -1 }` on `task_activities`, `{ projectId: 1, status: 1 }` on `tasks`.
   - Shard the MongoDB cluster using `organizationId` or `projectId` as the shard key, ensuring multi-tenant data locality and parallel query execution.
2. **Keyset (Cursor-Based) Pagination:**
   - Replace `skip`/`limit` with cursor pagination using `_id` / `createdAt` tokens. Keyset pagination ensures O(1) query time regardless of page depth.
3. **Asynchronous Activity Processing:**
   - Decouple audit logging from the synchronous HTTP request cycle using a background worker (e.g. BullMQ / Redis). Task assignment completes immediately (<15ms), while activity persistence is processed reliably via background queues.
4. **Caching Strategy:**
   - Cache project access permissions and project membership rosters in Redis with TTLs (e.g. 15 minutes) and event-driven invalidation on membership updates.
5. **Real-Time Delivery via WebSockets / SSE:**
   - Replace client-side polling with NestJS WebSocket gateways or Server-Sent Events, pushing task updates and activity items directly to active project board viewers.
6. **Data Tiering & Archival:**
   - Activity logs older than 12 months can be moved to cold storage (e.g. Amazon S3 Glacier / BigQuery) or a secondary archive collection, keeping the active working set small and memory-resident.

---

## 5. If I Had Two More Days

Given additional time, the prioritized improvements would be:

1. **Live Collaboration & WebSocket Subscriptions:** Implement real-time live cursors and instant task state updates across connected browser sessions without requiring page refreshes.
2. **Interactive Drag-and-Drop Board:** Add `@dnd-kit` drag-and-drop to the Kanban board (`apps/web/src/features/tasks/components/task-board.tsx`), allowing intuitive task status changes.
3. **Full End-to-End Playwright Test Suite:** Complement the existing API E2E tests with browser tests validating the Assignee Selector UI, optimistic updates, and toast notifications under simulated network latency.
4. **Granular Role-Based Access Control (RBAC):** Extend roles to allow project managers to define custom permissions (e.g., restricting task deletion, enabling external guest reviewers).
5. **Rate Limiting & Security Hardening:** Add `@nestjs/throttler` rate limiting on mutating endpoints and configure Content Security Policy (CSP) headers.
