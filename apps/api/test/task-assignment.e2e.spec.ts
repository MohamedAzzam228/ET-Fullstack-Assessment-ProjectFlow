import type { INestApplication } from '@nestjs/common';
import type { Connection } from 'mongoose';
import request from 'supertest';
import { OrganizationRole, ProjectRole, TaskPriority, TaskStatus } from '@projectflow/shared';
import { createTestApp, resetDatabase } from './utils/test-app';
import {
  addOrganizationMember,
  addProjectMember,
  authHeader,
  createOrganization,
  createProject,
  registerUser,
  type TestUser,
} from './utils/fixtures';

describe('Task Assignment & Activity & Concurrency (Assessment Requirements)', () => {
  let app: INestApplication;
  let connection: Connection;

  let owner: TestUser;
  let projectManager: TestUser;
  let member1: TestUser;
  let member2: TestUser;
  let outsider: TestUser;
  let projectId: string;
  let taskId: string;

  beforeAll(async () => {
    ({ app, connection } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(connection);

    owner = await registerUser(app, 'Owner User', 'owner@example.com');
    projectManager = await registerUser(app, 'PM User', 'pm@example.com');
    member1 = await registerUser(app, 'Member One', 'member1@example.com');
    member2 = await registerUser(app, 'Member Two', 'member2@example.com');
    outsider = await registerUser(app, 'Outsider User', 'outsider@example.com');

    const organizationId = await createOrganization(
      connection,
      'Assessment Org',
      'assessment-org',
      owner.id,
    );

    await addOrganizationMember(connection, organizationId, owner.id, OrganizationRole.OWNER);
    await addOrganizationMember(connection, organizationId, projectManager.id, OrganizationRole.MEMBER);
    await addOrganizationMember(connection, organizationId, member1.id, OrganizationRole.MEMBER);
    await addOrganizationMember(connection, organizationId, member2.id, OrganizationRole.MEMBER);

    projectId = await createProject(
      connection,
      organizationId,
      'Project Alpha',
      'ALPHA',
      owner.id,
    );

    await addProjectMember(connection, projectId, projectManager.id, ProjectRole.PROJECT_MANAGER);
    await addProjectMember(connection, projectId, member1.id, ProjectRole.MEMBER);
    await addProjectMember(connection, projectId, member2.id, ProjectRole.MEMBER);

    // Create an initial task
    const taskRes = await request(app.getHttpServer())
      .post(`/projects/${projectId}/tasks`)
      .set('Authorization', authHeader(owner))
      .send({
        title: 'Initial test task',
        description: 'Testing assignments and activities',
        priority: TaskPriority.HIGH,
      })
      .expect(201);

    taskId = taskRes.body.id;
  });

  // Test 1: Project member can assign themselves
  it('1. lets a project member assign a task to themselves', async () => {
    const response = await request(app.getHttpServer())
      .patch(`/tasks/${taskId}/assign`)
      .set('Authorization', authHeader(member1))
      .send({ assigneeId: member1.id })
      .expect(200);

    expect(response.body.assignee).toBeDefined();
    expect(response.body.assignee.id).toBe(member1.id);
    expect(response.body.assignee.email).toBe(member1.email);
  });

  // Test 2: OWNER/ADMIN/PM can assign any other member
  it('2. lets an OWNER, ADMIN, or Project Manager assign any other project member', async () => {
    // PM assigns member2
    const pmResponse = await request(app.getHttpServer())
      .patch(`/tasks/${taskId}/assign`)
      .set('Authorization', authHeader(projectManager))
      .send({ assigneeId: member2.id })
      .expect(200);

    expect(pmResponse.body.assignee.id).toBe(member2.id);

    // Org Owner reassigns to member1
    const ownerResponse = await request(app.getHttpServer())
      .patch(`/tasks/${taskId}/assign`)
      .set('Authorization', authHeader(owner))
      .send({ assigneeId: member1.id })
      .expect(200);

    expect(ownerResponse.body.assignee.id).toBe(member1.id);
  });

  // Test 3: Regular member cannot assign someone else
  it('3. forbids a regular project member from assigning a task to another member', async () => {
    const response = await request(app.getHttpServer())
      .patch(`/tasks/${taskId}/assign`)
      .set('Authorization', authHeader(member1))
      .send({ assigneeId: member2.id })
      .expect(403);

    expect(response.body.message).toMatch(/Only project managers and organization admins/i);
  });

  // Test 4: User outside project cannot be assigned
  it('4. refuses to assign a user who is not a member of the project', async () => {
    const response = await request(app.getHttpServer())
      .patch(`/tasks/${taskId}/assign`)
      .set('Authorization', authHeader(owner))
      .send({ assigneeId: outsider.id })
      .expect(400);

    expect(response.body.message).toMatch(/The assignee must be a member of the project/i);
  });

  // Test 5: Unauthorized users cannot view task activity
  it('5. forbids unauthorized users outside the project from viewing task activity', async () => {
    await request(app.getHttpServer())
      .get(`/tasks/${taskId}/activity`)
      .set('Authorization', authHeader(outsider))
      .expect(403);
  });

  // Test 6: Assigning task creates an activity record
  it('6. creates an activity record when a task is assigned', async () => {
    // Member1 assigns to self
    await request(app.getHttpServer())
      .patch(`/tasks/${taskId}/assign`)
      .set('Authorization', authHeader(member1))
      .send({ assigneeId: member1.id })
      .expect(200);

    // Query activity
    const activityRes = await request(app.getHttpServer())
      .get(`/tasks/${taskId}/activity`)
      .set('Authorization', authHeader(member1))
      .expect(200);

    expect(activityRes.body.total).toBe(1);
    const item = activityRes.body.items[0];
    expect(item.type).toBe('TASK_ASSIGNEE_CHANGED');
    expect(item.actor.id).toBe(member1.id);
    expect(item.metadata.from).toBeNull();
    expect(item.metadata.to.id).toBe(member1.id);
  });

  // Test 7: Unassigning task creates proper activity record
  it('7. creates an appropriate activity record when unassigning a task', async () => {
    // First, assign to member1
    await request(app.getHttpServer())
      .patch(`/tasks/${taskId}/assign`)
      .set('Authorization', authHeader(owner))
      .send({ assigneeId: member1.id })
      .expect(200);

    // Then, unassign by passing assigneeId: null
    await request(app.getHttpServer())
      .patch(`/tasks/${taskId}/assign`)
      .set('Authorization', authHeader(owner))
      .send({ assigneeId: null })
      .expect(200);

    // Check activity records (newest first)
    const activityRes = await request(app.getHttpServer())
      .get(`/tasks/${taskId}/activity`)
      .set('Authorization', authHeader(owner))
      .expect(200);

    expect(activityRes.body.total).toBe(2);
    const latest = activityRes.body.items[0];
    expect(latest.type).toBe('TASK_ASSIGNEE_CHANGED');
    expect(latest.actor.id).toBe(owner.id);
    expect(latest.metadata.from.id).toBe(member1.id);
    expect(latest.metadata.to).toBeNull();
  });

  // Test 8: Unauthorized users cannot modify tasks in other projects (Regression test for production bug)
  it('8. prevents unauthorized users from modifying task status across projects (Bug Fix Regression)', async () => {
    // Outsider tries to update status of a task in a project they are not part of
    await request(app.getHttpServer())
      .patch(`/tasks/${taskId}/status`)
      .set('Authorization', authHeader(outsider))
      .send({ status: TaskStatus.DONE })
      .expect(403);

    // Verify task status was NOT changed
    const verifyRes = await request(app.getHttpServer())
      .get(`/tasks/${taskId}`)
      .set('Authorization', authHeader(owner))
      .expect(200);

    expect(verifyRes.body.status).toBe(TaskStatus.TODO);
  });

  // Test 9: Concurrent creation does not duplicate task identifier
  it('9. ensures concurrent task creation generates sequential and unique task identifiers', async () => {
    const NUM_CONCURRENT = 10;
    const taskPromises = Array.from({ length: NUM_CONCURRENT }).map((_, i) =>
      request(app.getHttpServer())
        .post(`/projects/${projectId}/tasks`)
        .set('Authorization', authHeader(member1))
        .send({ title: `Concurrent Task ${i + 1}` }),
    );

    const responses = await Promise.all(taskPromises);
    for (const res of responses) {
      expect(res.status).toBe(201);
    }

    const keys = responses.map((r) => r.body.key);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(NUM_CONCURRENT);

    // Check that task numbers are strictly unique and sequential
    const numbers = responses.map((r) => r.body.number).sort((a, b) => a - b);
    expect(numbers).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
});
