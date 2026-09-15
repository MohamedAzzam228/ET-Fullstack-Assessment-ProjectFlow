import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types } from 'mongoose';

export type ProjectCounterDocument = HydratedDocument<ProjectCounter>;

@Schema({ collection: 'project_counters', timestamps: false })
export class ProjectCounter {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true, unique: true })
  projectId: Types.ObjectId;

  @Prop({ type: Number, required: true, default: 0 })
  seq: number;
}

export const ProjectCounterSchema = SchemaFactory.createForClass(ProjectCounter);
