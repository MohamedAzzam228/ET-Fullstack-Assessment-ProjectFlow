# Production Bug Report: Missing Authorization on Task Status Update

## 1. Executive Summary

- **Vulnerability Type:** Broken Object Level Authorization (BOLA / IDOR) — OWASP API Security Top 10 (API1:2023)
- **Component Affected:** `apps/api/src/tasks/tasks.service.ts` & `apps/api/src/tasks/tasks.controller.ts`
- **Severity:** High / Critical
- **Date Discovered:** 2026-09-15
- **Status:** Resolved & Verified

---

## 2. Root Cause Analysis

In `TasksController.updateStatus`:
```typescript
// BEFORE:
@Patch('tasks/:taskId/status')
updateStatus(
  @Param('taskId') taskId: string,
  @Body() dto: UpdateTaskStatusDto,
): Promise<TaskDetail> {
  return this.tasksService.updateStatus(toObjectId(taskId, 'task id'), dto);
}
```

In `TasksService.updateStatus`:
```typescript
// BEFORE:
async updateStatus(taskId: Types.ObjectId, dto: UpdateTaskStatusDto): Promise<TaskDetail> {
  const task = await this.findTaskOrFail(taskId);

  task.status = dto.status;
  await task.save();

  return this.toDetail(task);
}
```

Unlike `findOne()`, `update()`, and `remove()`, which properly consult `ProjectAccessService` via `assertCanView` or `assertCanManage`, the `updateStatus` method only fetched the task by ID and immediately persisted the requested status without inspecting who made the request.

---

## 3. Impact Assessment

- **Unauthorized State Mutation:** Any authenticated user on the platform who knew or enumerated a valid MongoDB `taskId` could change that task's status to any value (e.g., `TODO`, `IN_PROGRESS`, `IN_REVIEW`, `DONE`).
- **Cross-Tenant Breach:** A user belonging to Organization A could manipulate tasks belonging to Organization B without having any membership or permissions in Organization B or the underlying project.
- **Workflow Sabotage:** Sprint tracking, burn-down metrics, and automated workflows could be silently disrupted.

---

## 4. Reproduction Steps

1. User A (Org A, Project A) creates a task `task_123` with status `TODO`.
2. User B (Org B, with zero affiliation to Project A or Org A) logs in and obtains a JWT token.
3. User B issues an HTTP request:
   ```http
   PATCH /tasks/task_123/status HTTP/1.1
   Host: api.projectflow.local
   Authorization: Bearer <User_B_JWT>
   Content-Type: application/json

   {
     "status": "DONE"
   }
   ```
4. **Result before fix:** HTTP 200 OK — `task_123` status changed to `DONE`.
5. **Expected result:** HTTP 403 Forbidden — access denied.

---

## 5. Remediation

### Backend Changes

1. **Controller (`apps/api/src/tasks/tasks.controller.ts`):**
   Injected the authenticated user ID via `@CurrentUser('id')` and passed it to `tasksService.updateStatus()`.

2. **Service (`apps/api/src/tasks/tasks.service.ts`):**
   Updated `updateStatus` signature to accept `userId: Types.ObjectId` and added access assertion:
   ```typescript
   async updateStatus(
     taskId: Types.ObjectId,
     userId: Types.ObjectId,
     dto: UpdateTaskStatusDto,
   ): Promise<TaskDetail> {
     const task = await this.findTaskOrFail(taskId);
     const { project } = await this.projectAccessService.assertCanView(task.projectId, userId);

     task.status = dto.status;
     await task.save();

     return this.toDetail(task, project);
   }
   ```

---

## 6. Regression Testing & Prevention

1. **Automated E2E Test:**
   Added in `apps/api/test/task-assignment.e2e.spec.ts` (Test Case #8):
   - Confirms that an unauthorized user outside the project attempting `PATCH /tasks/:taskId/status` receives an HTTP `403 Forbidden`.
   - Verifies that the task's status in the database remains unchanged.
2. **Preventative Recommendations:**
   - **Architectural Guardrails:** Implement a reusable NestJS Guard / Interceptor (`@RequireProjectAccess()`) or a domain-level repository wrapper that mandates project access resolution for every mutation.
   - **Static Analysis & Lint Rules:** Enforce through code review checklists that no mutating service method accepts an entity ID without also taking and validating the acting `userId`.
