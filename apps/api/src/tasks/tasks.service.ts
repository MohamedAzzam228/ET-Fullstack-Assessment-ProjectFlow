import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type FilterQuery, Model, Types } from 'mongoose';
import type {
  Paginated,
  TaskActivity as TaskActivityDto,
  TaskDetail,
  TaskSummary,
} from '@projectflow/shared';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { toObjectId } from '../common/utils/object-id';
import { toUserSummary } from '../common/utils/serialize';
import { Comment, type CommentDocument } from '../comments/schemas/comment.schema';
import { ProjectMembersService } from '../project-members/project-members.service';
import { canManage, ProjectAccessService } from '../projects/project-access.service';
import { Project, type ProjectDocument } from '../projects/schemas/project.schema';
import { UsersService } from '../users/users.service';
import type { AssignTaskDto } from './dto/assign-task.dto';
import type { CreateTaskDto } from './dto/create-task.dto';
import type { ListTasksQueryDto } from './dto/list-tasks.dto';
import type { UpdateTaskDto } from './dto/update-task.dto';
import type { UpdateTaskStatusDto } from './dto/update-task-status.dto';
import { ProjectCounter, type ProjectCounterDocument } from './schemas/project-counter.schema';
import { TaskActivity, type TaskActivityDocument } from './schemas/task-activity.schema';
import { Task, type TaskDocument } from './schemas/task.schema';

@Injectable()
export class TasksService {
  constructor(
    @InjectModel(Task.name) private readonly taskModel: Model<TaskDocument>,
    @InjectModel(Project.name) private readonly projectModel: Model<ProjectDocument>,
    @InjectModel(Comment.name) private readonly commentModel: Model<CommentDocument>,
    @InjectModel(TaskActivity.name) private readonly taskActivityModel: Model<TaskActivityDocument>,
    @InjectModel(ProjectCounter.name)
    private readonly projectCounterModel: Model<ProjectCounterDocument>,
    private readonly projectAccessService: ProjectAccessService,
    private readonly projectMembersService: ProjectMembersService,
    private readonly usersService: UsersService,
  ) {}

  async findByProject(
    projectId: Types.ObjectId,
    userId: Types.ObjectId,
    query: ListTasksQueryDto,
  ): Promise<Paginated<TaskSummary>> {
    await this.projectAccessService.assertCanView(projectId, userId);

    const filter: FilterQuery<TaskDocument> = { projectId };
    if (query.status) {
      filter.status = query.status;
    }
    if (query.priority) {
      filter.priority = query.priority;
    }

    const [tasks, total] = await Promise.all([
      this.taskModel.find(filter).sort({ number: 1 }).skip(query.skip).limit(query.pageSize).exec(),
      this.taskModel.countDocuments(filter),
    ]);

    return {
      items: await this.toSummaries(tasks),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async create(
    projectId: Types.ObjectId,
    userId: Types.ObjectId,
    dto: CreateTaskDto,
  ): Promise<TaskDetail> {
    const { project } = await this.projectAccessService.assertCanView(projectId, userId);

    let counter = await this.projectCounterModel
      .findOneAndUpdate({ projectId }, { $inc: { seq: 1 } }, { new: true })
      .exec();

    if (!counter) {
      const lastTask = await this.taskModel
        .findOne({ projectId })
        .sort({ number: -1 })
        .select('number')
        .exec();
      const base = lastTask ? lastTask.number : 0;

      try {
        counter = await this.projectCounterModel
          .findOneAndUpdate(
            { projectId },
            { $setOnInsert: { seq: base + 1 } },
            { upsert: true, new: true },
          )
          .exec();
      } catch {
        counter = await this.projectCounterModel
          .findOneAndUpdate({ projectId }, { $inc: { seq: 1 } }, { new: true })
          .exec();
      }
    }

    const number = counter?.seq ?? 1;

    const task = await this.taskModel.create({
      projectId,
      number,
      key: `${project.key}-${number}`,
      title: dto.title,
      description: dto.description ?? null,
      status: dto.status,
      priority: dto.priority,
      assigneeId: null,
      createdBy: userId,
    });

    return this.toDetail(task, project);
  }

  async findOne(taskId: Types.ObjectId, userId: Types.ObjectId): Promise<TaskDetail> {
    const task = await this.findTaskOrFail(taskId);
    const { project } = await this.projectAccessService.assertCanView(task.projectId, userId);

    return this.toDetail(task, project);
  }

  async update(
    taskId: Types.ObjectId,
    userId: Types.ObjectId,
    dto: UpdateTaskDto,
  ): Promise<TaskDetail> {
    const task = await this.findTaskOrFail(taskId);
    const access = await this.projectAccessService.assertCanView(task.projectId, userId);

    const isCreator = task.createdBy.equals(userId);
    if (!canManage(access) && !isCreator) {
      throw new ForbiddenException('You do not have permission to edit this task');
    }

    if (dto.title !== undefined) {
      task.title = dto.title;
    }
    if (dto.description !== undefined) {
      task.description = dto.description;
    }
    if (dto.status !== undefined) {
      task.status = dto.status;
    }
    if (dto.priority !== undefined) {
      task.priority = dto.priority;
    }

    await task.save();

    return this.toDetail(task, access.project);
  }

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

  async assignTask(
    taskId: Types.ObjectId,
    userId: Types.ObjectId,
    dto: AssignTaskDto,
  ): Promise<TaskDetail> {
    const task = await this.findTaskOrFail(taskId);
    const access = await this.projectAccessService.assertCanView(task.projectId, userId);

    const newAssigneeId = dto.assigneeId ? toObjectId(dto.assigneeId, 'assignee id') : null;
    const oldAssigneeId = task.assigneeId ?? null;

    // Rule #1: If an assignee is provided, they must be a project member
    if (newAssigneeId) {
      const isMember = await this.projectMembersService.findRole(task.projectId, newAssigneeId);
      if (!isMember) {
        throw new BadRequestException('The assignee must be a member of the project');
      }
    }

    // Rule #2 & #3: Assignment permissions
    // OWNER, ADMIN, and PROJECT_MANAGER can assign any member or unassign.
    // Regular project members may only assign tasks to themselves.
    const isManager = canManage(access);
    const isSelfAssign = newAssigneeId !== null && newAssigneeId.equals(userId);

    if (!isManager && !isSelfAssign) {
      throw new ForbiddenException(
        'Only project managers and organization admins can assign tasks to other members or unassign tasks',
      );
    }

    const isChanged =
      (oldAssigneeId === null && newAssigneeId !== null) ||
      (oldAssigneeId !== null && newAssigneeId === null) ||
      (oldAssigneeId !== null && newAssigneeId !== null && !oldAssigneeId.equals(newAssigneeId));

    if (isChanged) {
      task.assigneeId = newAssigneeId;
      await task.save();

      await this.taskActivityModel.create({
        taskId: task._id,
        type: 'TASK_ASSIGNEE_CHANGED',
        actorId: userId,
        metadata: {
          fromId: oldAssigneeId,
          toId: newAssigneeId,
        },
      });
    }

    return this.toDetail(task, access.project);
  }

  async getActivity(
    taskId: Types.ObjectId,
    userId: Types.ObjectId,
    query: PaginationQueryDto,
  ): Promise<Paginated<TaskActivityDto>> {
    const task = await this.findTaskOrFail(taskId);
    await this.projectAccessService.assertCanView(task.projectId, userId);

    const filter: FilterQuery<TaskActivityDocument> = { taskId };

    const [activities, total] = await Promise.all([
      this.taskActivityModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(query.skip)
        .limit(query.pageSize)
        .exec(),
      this.taskActivityModel.countDocuments(filter),
    ]);

    if (activities.length === 0) {
      return {
        items: [],
        total,
        page: query.page,
        pageSize: query.pageSize,
      };
    }

    // Collect all referenced user IDs for a single bulk query (prevent N+1 queries)
    const userIdsToFetch = new Set<string>();
    for (const act of activities) {
      userIdsToFetch.add(act.actorId.toString());
      if (act.metadata?.fromId) {
        userIdsToFetch.add(act.metadata.fromId.toString());
      }
      if (act.metadata?.toId) {
        userIdsToFetch.add(act.metadata.toId.toString());
      }
    }

    const users = await this.usersService.findManyByIds(
      Array.from(userIdsToFetch).map((id) => new Types.ObjectId(id)),
    );
    const usersById = new Map(users.map((u) => [u._id.toString(), u]));

    const items: TaskActivityDto[] = activities.map((act) => {
      const actorUser = usersById.get(act.actorId.toString());
      const fromUser = act.metadata?.fromId
        ? usersById.get(act.metadata.fromId.toString())
        : null;
      const toUser = act.metadata?.toId
        ? usersById.get(act.metadata.toId.toString())
        : null;

      return {
        id: act._id.toString(),
        type: act.type,
        actor: toCreatorSummary(actorUser),
        taskId: act.taskId.toString(),
        metadata: {
          from: fromUser ? toUserSummary(fromUser) : null,
          to: toUser ? toUserSummary(toUser) : null,
        },
        createdAt: act.createdAt.toISOString(),
      };
    });

    return {
      items,
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async remove(taskId: Types.ObjectId, userId: Types.ObjectId): Promise<void> {
    const task = await this.findTaskOrFail(taskId);
    await this.projectAccessService.assertCanManage(task.projectId, userId);

    await Promise.all([
      this.commentModel.deleteMany({ taskId: task._id }),
      this.taskActivityModel.deleteMany({ taskId: task._id }),
      task.deleteOne(),
    ]);
  }

  async findTaskOrFail(taskId: Types.ObjectId): Promise<TaskDocument> {
    const task = await this.taskModel.findById(taskId).exec();
    if (!task) {
      throw new NotFoundException('Task not found');
    }
    return task;
  }

  private async toSummaries(tasks: TaskDocument[]): Promise<TaskSummary[]> {
    if (tasks.length === 0) {
      return [];
    }

    const userIdsToFetch: Types.ObjectId[] = [];
    for (const task of tasks) {
      userIdsToFetch.push(task.createdBy);
      if (task.assigneeId) {
        userIdsToFetch.push(task.assigneeId);
      }
    }

    const [users, commentRows] = await Promise.all([
      this.usersService.findManyByIds(userIdsToFetch),
      this.commentModel
        .aggregate<{
          _id: Types.ObjectId;
          count: number;
        }>([
          { $match: { taskId: { $in: tasks.map((task) => task._id) } } },
          { $group: { _id: '$taskId', count: { $sum: 1 } } },
        ])
        .exec(),
    ]);

    const usersById = new Map(users.map((user) => [user._id.toString(), user]));
    const commentCounts = new Map(commentRows.map((row) => [row._id.toString(), row.count]));

    return tasks.map((task) => {
      const assigneeUser = task.assigneeId ? usersById.get(task.assigneeId.toString()) : null;

      return {
        id: task._id.toString(),
        projectId: task.projectId.toString(),
        number: task.number,
        key: task.key,
        title: task.title,
        status: task.status,
        priority: task.priority,
        commentCount: commentCounts.get(task._id.toString()) ?? 0,
        assignee: assigneeUser ? toUserSummary(assigneeUser) : null,
        createdBy: toCreatorSummary(usersById.get(task.createdBy.toString())),
        createdAt: task.createdAt.toISOString(),
        updatedAt: task.updatedAt.toISOString(),
      };
    });
  }

  private async toDetail(task: TaskDocument, project?: ProjectDocument): Promise<TaskDetail> {
    const [summary] = await this.toSummaries([task]);
    const resolvedProject = project ?? (await this.projectModel.findById(task.projectId).exec());

    if (!resolvedProject) {
      throw new NotFoundException('Project not found');
    }

    return {
      ...summary!,
      description: task.description ?? null,
      project: {
        id: resolvedProject._id.toString(),
        name: resolvedProject.name,
        key: resolvedProject.key,
      },
    };
  }
}

const DELETED_USER = {
  id: '',
  name: 'Unknown user',
  email: '',
  avatarUrl: null,
};

function toCreatorSummary(user: Parameters<typeof toUserSummary>[0] | undefined) {
  return user ? toUserSummary(user) : DELETED_USER;
}
