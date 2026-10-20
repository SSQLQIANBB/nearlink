import {
  createGroup,
  updateGroup,
  getGroupDetail,
  inviteToGroup,
  setMemberPermission,
  deleteGroup,
  type Group,
} from '@/api/group';
import { getUserList } from '@/api/auth';
import { useSocketStore } from '@/stores/socket';
import { groupSessionState } from './groupSessionState';
import { useDesktopDialogs } from './desktopDialogWindows';

export function useGroupDialogWindows(onChanged: () => unknown) {
  const open = useDesktopDialogs();
  async function invite(group: Group) {
    return open({
      kind: 'group-invite',
      key: `group-invite-${group.id}`,
      title: '邀请新成员',
      actions: {
        people: async () => {
          const [detail, { users }] = await Promise.all([getGroupDetail(group.id), getUserList()]);
          const members = new Set(detail.members.map((member) => member.id));
          return users
            .filter((user) => !members.has(user.id))
            .map((user) => ({
              key: String(user.id),
              id: user.id,
              name: user.nickname || user.username,
              avatar: user.avatar,
            }));
        },
        send: ({ selected }: { selected: string[] }) =>
          inviteToGroup(group.id, selected.map(Number)),
      },
    });
  }
  return async (mode: 'create' | 'edit' | 'detail', group?: Group) => {
    const changed = await open({
      kind: `group-${mode}`,
      key: `group-${mode}${group ? `-${group.id}` : ''}`,
      title: mode === 'create' ? '创建群组' : mode === 'edit' ? '编辑群组' : group!.name,
      data: group,
      height: mode === 'detail' ? 640 : 450,
      actions:
        mode === 'create'
          ? { save: createGroup }
          : mode === 'edit'
            ? {
                save: (value) => updateGroup(group!.id, value),
              }
            : {
                detail: () => getGroupDetail(group!.id),
                invite: () => invite(group!),
                permission: ({ id, canSpeak }: { id: number; canSpeak: boolean }) =>
                  setMemberPermission(group!.id, id, canSpeak),
                delete: async () => {
                  await deleteGroup(group!.id);
                  groupSessionState.clearGroup(group!.id);
                  useSocketStore().leaveGroup(group!.id);
                },
              },
    });
    if (changed) await onChanged();
  };
}
