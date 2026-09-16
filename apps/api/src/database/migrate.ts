/**
 * Database Migration Script
 * 
 * Ensures all collection schemas, compound indexes, and sequence counters are
 * created and synchronized across the database.
 * 
 * Safe to run idempotently against clean or existing databases.
 */
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import mongoose from 'mongoose';
import { OrganizationMemberSchema } from '../organization-members/schemas/organization-member.schema';
import { OrganizationSchema } from '../organizations/schemas/organization.schema';
import { ProjectMemberSchema } from '../project-members/schemas/project-member.schema';
import { ProjectSchema } from '../projects/schemas/project.schema';
import { TaskSchema } from '../tasks/schemas/task.schema';
import { CommentSchema } from '../comments/schemas/comment.schema';
import { UserSchema } from '../users/schemas/user.schema';
import { TaskActivitySchema } from '../tasks/schemas/task-activity.schema';
import { ProjectCounterSchema } from '../tasks/schemas/project-counter.schema';

loadEnv({ path: resolve(__dirname, '../../../../.env'), quiet: true });
loadEnv({ quiet: true });

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/projectflow';

const User = mongoose.model('User', UserSchema);
const Organization = mongoose.model('Organization', OrganizationSchema);
const OrganizationMember = mongoose.model('OrganizationMember', OrganizationMemberSchema);
const Project = mongoose.model('Project', ProjectSchema);
const ProjectMember = mongoose.model('ProjectMember', ProjectMemberSchema);
const Task = mongoose.model('Task', TaskSchema);
const Comment = mongoose.model('Comment', CommentSchema);
const TaskActivity = mongoose.model('TaskActivity', TaskActivitySchema);
const ProjectCounter = mongoose.model('ProjectCounter', ProjectCounterSchema);

const MODELS = [
  { name: 'User', model: User },
  { name: 'Organization', model: Organization },
  { name: 'OrganizationMember', model: OrganizationMember },
  { name: 'Project', model: Project },
  { name: 'ProjectMember', model: ProjectMember },
  { name: 'Task', model: Task },
  { name: 'Comment', model: Comment },
  { name: 'TaskActivity', model: TaskActivity },
  { name: 'ProjectCounter', model: ProjectCounter },
];

export async function migrate(): Promise<void> {
  console.log(`\n🔄 [Migration] Connecting to MongoDB: ${MONGODB_URI}`);
  await mongoose.connect(MONGODB_URI);

  console.log('📌 [Migration 1/3] Synchronizing compound indexes across all collections...');
  for (const { name, model } of MODELS) {
    try {
      await model.syncIndexes();
      console.log(`  ✓ Indexes synced for collection: ${model.collection.name} (${name})`);
    } catch (err: any) {
      console.warn(`  ⚠️ Warning syncing indexes for ${name}: ${err.message}`);
    }
  }

  console.log('\n📌 [Migration 2/3] Initializing and synchronizing ProjectCounter sequences...');
  const projects = await Project.find({}).lean();
  let countersUpdated = 0;

  for (const project of projects) {
    // Find the current highest task number in this project
    const latestTask = await Task.findOne({ projectId: project._id })
      .sort({ number: -1 })
      .select('number')
      .lean();

    const currentMax = latestTask?.number ?? 0;

    await ProjectCounter.findOneAndUpdate(
      { projectId: project._id },
      { $max: { seq: currentMax } },
      { upsert: true, new: true },
    );
    countersUpdated++;
  }
  console.log(`  ✓ Synchronized atomic counters for ${countersUpdated} project(s).`);

  console.log('\n📌 [Migration 3/3] Backfilling legacy task fields...');
  const backfillResult = await Task.updateMany(
    { assigneeId: { $exists: false } },
    { $set: { assigneeId: null } },
  );
  console.log(`  ✓ Backfilled assigneeId on ${backfillResult.modifiedCount} legacy task(s).`);

  console.log('\n✅ [Migration Complete] Database schema and indexes are up to date.\n');
  await mongoose.disconnect();
}

if (require.main === module) {
  migrate().catch(async (error: unknown) => {
    console.error('❌ Migration failed:', error);
    await mongoose.disconnect().catch(() => undefined);
    process.exit(1);
  });
}
