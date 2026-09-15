'use client';

import { useState } from 'react';
import { CaretDownIcon, CheckIcon, MagnifyingGlassIcon, UserCircleIcon, XIcon } from '@phosphor-icons/react/dist/ssr';
import { toast } from 'sonner';
import { OrganizationRole, ProjectRole, type UserSummary } from '@projectflow/shared';
import { Avatar } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useCurrentUser } from '@/features/auth/hooks';
import { useProject, useProjectMembers } from '@/features/projects/hooks';
import { cn } from '@/lib/utils';
import { useAssignTask } from '../hooks';

interface AssigneeSelectorProps {
  taskId: string;
  projectId: string;
  assignee: UserSummary | null;
}

export function AssigneeSelector({ taskId, projectId, assignee }: AssigneeSelectorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const { data: currentUser } = useCurrentUser();
  const { data: project } = useProject(projectId);
  const { data: members = [], isLoading: membersLoading, isError: membersError } = useProjectMembers(projectId);

  const assignTaskMutation = useAssignTask(taskId, projectId);

  // Determine permissions
  const isElevated = currentUser?.organizations?.some(
    (org) =>
      org.id === project?.organizationId &&
      (org.role === OrganizationRole.OWNER || org.role === OrganizationRole.ADMIN),
  ) ?? false;

  const currentMember = members.find((m) => m.user.id === currentUser?.id);
  const isProjectManager = currentMember?.role === ProjectRole.PROJECT_MANAGER;
  const canManage = isElevated || isProjectManager;
  const isProjectMember = Boolean(currentMember);

  // If user is neither a manager nor a project member, or if they are a regular member and task is already self-assigned, they cannot make further changes
  const canAssignAtAll = canManage || (isProjectMember && assignee?.id !== currentUser?.id);

  const handleAssign = (userId: string | null) => {
    assignTaskMutation.mutate(userId, {
      onSuccess: () => {
        setOpen(false);
        setSearch('');
        toast.success(userId ? 'Task assigned' : 'Task unassigned');
      },
      onError: (err) => {
        toast.error(err.message || 'Failed to update assignee');
      },
    });
  };

  const filteredMembers = members.filter((member) => {
    const term = search.toLowerCase().trim();
    if (!term) return true;
    return (
      member.user.name.toLowerCase().includes(term) ||
      member.user.email.toLowerCase().includes(term)
    );
  });

  return (
    <div className="space-y-1">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={!canAssignAtAll || assignTaskMutation.isPending}
            className={cn(
              'inline-flex h-8 w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-2.5 text-[13px] text-foreground',
              'hover:bg-surface-strong focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary',
              'disabled:cursor-not-allowed disabled:opacity-60',
            )}
            aria-label="Select assignee"
          >
            <div className="flex min-w-0 items-center gap-2">
              {assignee ? (
                <>
                  <Avatar user={assignee} size="sm" />
                  <span className="truncate">{assignee.name}</span>
                </>
              ) : (
                <>
                  <UserCircleIcon size={16} className="text-subtle-foreground shrink-0" />
                  <span className="text-subtle-foreground">Unassigned</span>
                </>
              )}
            </div>
            <CaretDownIcon size={12} weight="bold" className="shrink-0 text-subtle-foreground" />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="w-64 p-1.5 shadow-lg">
          {/* Search bar */}
          <div className="relative mb-1 px-1">
            <MagnifyingGlassIcon
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle-foreground"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search members..."
              className="w-full rounded border border-border bg-surface px-2 py-1 pl-6 text-[12px] text-foreground placeholder:text-subtle-foreground focus:border-primary focus:outline-none"
              autoFocus
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-subtle-foreground hover:text-foreground"
              >
                <XIcon size={11} />
              </button>
            )}
          </div>

          <div className="max-h-60 overflow-y-auto space-y-0.5">
            {/* Unassign option (only if user has permission to unassign) */}
            {canManage && (
              <button
                type="button"
                onClick={() => handleAssign(null)}
                className={cn(
                  'flex w-full cursor-pointer items-center justify-between rounded-sm px-2 py-1.5 text-[13px] hover:bg-surface-strong',
                  assignee === null ? 'bg-surface-strong font-medium text-primary' : 'text-muted-foreground',
                )}
              >
                <div className="flex items-center gap-2">
                  <UserCircleIcon size={16} className="text-subtle-foreground" />
                  <span>Unassigned</span>
                </div>
                {assignee === null && <CheckIcon size={13} weight="bold" />}
              </button>
            )}

            {/* Quick "Assign to me" option for regular members if not assigned to them */}
            {!canManage && isProjectMember && assignee?.id !== currentUser?.id && currentUser && (
              <button
                type="button"
                onClick={() => handleAssign(currentUser.id)}
                className="flex w-full cursor-pointer items-center justify-between rounded-sm px-2 py-1.5 text-[13px] text-primary hover:bg-surface-strong font-medium"
              >
                <div className="flex items-center gap-2">
                  <Avatar user={currentUser} size="sm" />
                  <span>Assign to me</span>
                </div>
              </button>
            )}

            {/* Loading state */}
            {membersLoading && (
              <p className="px-2 py-3 text-center text-[12px] text-subtle-foreground">
                Loading members...
              </p>
            )}

            {/* Error state */}
            {membersError && (
              <p className="px-2 py-2 text-center text-[12px] text-danger">
                Failed to load members
              </p>
            )}

            {/* Members list */}
            {!membersLoading && !membersError && filteredMembers.length === 0 && (
              <p className="px-2 py-3 text-center text-[12px] text-subtle-foreground">
                {search ? 'No matching members found' : 'No project members'}
              </p>
            )}

            {!membersLoading &&
              !membersError &&
              filteredMembers.map((member) => {
                const isSelected = assignee?.id === member.user.id;
                const isSelf = member.user.id === currentUser?.id;
                // A non-manager can ONLY select themselves
                const isItemDisabled = !canManage && !isSelf;

                return (
                  <button
                    key={member.id}
                    type="button"
                    disabled={isItemDisabled}
                    onClick={() => handleAssign(member.user.id)}
                    title={isItemDisabled ? 'Only managers can assign other members' : undefined}
                    className={cn(
                      'flex w-full cursor-pointer items-center justify-between rounded-sm px-2 py-1.5 text-left text-[13px]',
                      'hover:bg-surface-strong focus:bg-surface-strong focus:outline-none',
                      isSelected ? 'bg-surface-strong font-medium text-foreground' : 'text-foreground',
                      isItemDisabled && 'cursor-not-allowed opacity-40 hover:bg-transparent',
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <Avatar user={member.user} size="sm" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate">{member.user.name}</span>
                          {isSelf && (
                            <span className="rounded bg-surface px-1 text-[10px] text-muted-foreground">
                              You
                            </span>
                          )}
                        </div>
                        <p className="truncate text-[11px] text-subtle-foreground">
                          {member.user.email}
                        </p>
                      </div>
                    </div>
                    {isSelected && (
                      <CheckIcon size={14} weight="bold" className="shrink-0 text-primary" />
                    )}
                  </button>
                );
              })}
          </div>

          {!canManage && isProjectMember && (
            <div className="mt-1 border-t border-border pt-1 px-1">
              <p className="text-[10px] text-subtle-foreground">
                Members may only assign tasks to themselves.
              </p>
            </div>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {!canAssignAtAll && (
        <p className="text-[11px] text-subtle-foreground">
          {!isProjectMember
            ? 'Only project members can update assignments.'
            : 'You cannot reassign this task.'}
        </p>
      )}
    </div>
  );
}
