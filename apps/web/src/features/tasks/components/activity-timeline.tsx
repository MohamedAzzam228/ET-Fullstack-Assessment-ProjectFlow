'use client';

import { useState } from 'react';
import { ClockCounterClockwiseIcon, UserCircleIcon, UserSwitchIcon } from '@phosphor-icons/react/dist/ssr';
import type { TaskActivity } from '@projectflow/shared';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import { useTaskActivity } from '../hooks';

interface ActivityTimelineProps {
  taskId: string;
}

export function ActivityTimeline({ taskId }: ActivityTimelineProps) {
  const [pageSize, setPageSize] = useState(10);
  const { data, isLoading, isError, error } = useTaskActivity(taskId, 1, pageSize);

  const activities = data?.items ?? [];
  const total = data?.total ?? 0;
  const hasMore = total > activities.length;

  return (
    <section aria-label="Task Activity History" className="space-y-4 pt-6 border-t border-border">
      <div className="flex items-center gap-2">
        <ClockCounterClockwiseIcon size={16} className="text-muted-foreground" />
        <h2 className="text-sm font-semibold text-foreground">Activity History</h2>
        {total > 0 && (
          <span className="rounded-sm bg-surface-strong px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {total}
          </span>
        )}
      </div>

      {isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}

      {isError && (
        <p className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-[12px] text-danger">
          {error.message || 'Failed to load activity history'}
        </p>
      )}

      {!isLoading && !isError && activities.length === 0 && (
        <p className="text-[13px] italic text-subtle-foreground">
          No activity recorded yet for this task.
        </p>
      )}

      {!isLoading && !isError && activities.length > 0 && (
        <div className="relative pl-6 space-y-4 before:absolute before:left-2.5 before:top-2 before:bottom-2 before:w-px before:bg-border">
          {activities.map((activity) => (
            <ActivityItem key={activity.id} activity={activity} />
          ))}

          {hasMore && (
            <div className="pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPageSize((prev) => prev + 10)}
                className="text-[12px] text-muted-foreground hover:text-foreground"
              >
                Load older activity ({total - activities.length} remaining)
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ActivityItem({ activity }: { activity: TaskActivity }) {
  const { actor, metadata, createdAt } = activity;
  const from = metadata?.from;
  const to = metadata?.to;

  const renderDescription = () => {
    if (!from && to) {
      return (
        <span>
          assigned this task to <strong className="font-medium text-foreground">{to.name}</strong>
        </span>
      );
    }
    if (from && to) {
      return (
        <span>
          changed assignee from <strong className="font-medium text-foreground">{from.name}</strong> to{' '}
          <strong className="font-medium text-foreground">{to.name}</strong>
        </span>
      );
    }
    if (from && !to) {
      return (
        <span>
          removed assignee (previously <strong className="font-medium text-foreground">{from.name}</strong>)
        </span>
      );
    }
    return <span>updated task assignment</span>;
  };

  return (
    <div className="relative flex items-start gap-3 text-[13px] leading-snug">
      {/* Node indicator */}
      <span className="absolute -left-6 mt-1 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground">
        <UserSwitchIcon size={11} />
      </span>

      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
          <span className="flex items-center gap-1 font-medium text-foreground">
            <Avatar user={actor} size="sm" className="h-4 w-4 text-[9px]" />
            {actor.name}
          </span>
          {renderDescription()}
        </div>
        <time
          dateTime={createdAt}
          title={formatDateTime(createdAt)}
          className="text-[11px] text-subtle-foreground"
        >
          {formatRelativeTime(createdAt)}
        </time>
      </div>
    </div>
  );
}
