import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types } from 'mongoose';

export type TaskActivityDocument = HydratedDocument<TaskActivity>;

export const TASK_ACTIVITY_TYPES = ['TASK_ASSIGNEE_CHANGED'] as const;
export type TaskActivityType = (typeof TASK_ACTIVITY_TYPES)[number];

@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'task_activities' })
export class TaskActivity {
  @Prop({ type: Types.ObjectId, ref: 'Task', required: true, index: true })
  taskId: Types.ObjectId;

  @Prop({ type: String, enum: TASK_ACTIVITY_TYPES, required: true })
  type: TaskActivityType;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  actorId: Types.ObjectId;

  /**
   * For TASK_ASSIGNEE_CHANGED:
   * { fromId: ObjectId | null, toId: ObjectId | null }
   */
  @Prop({ type: Object, required: true })
  metadata: {
    fromId: Types.ObjectId | null;
    toId: Types.ObjectId | null;
  };

  createdAt: Date;
}

export const TaskActivitySchema = SchemaFactory.createForClass(TaskActivity);

// Compound index for paginated activity feed (newest first per task)
TaskActivitySchema.index({ taskId: 1, createdAt: -1 });
