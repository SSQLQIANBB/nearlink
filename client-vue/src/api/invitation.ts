import { http } from '@/utils/request';
import type { User } from './auth';
import type { Group } from './group';

export interface GroupInvitation {
  id: number;
  groupId: number;
  inviterId: number;
  inviteeId: number;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: string;
  group: Group;
  inviter: User;
}

/**
 * 获取待处理的群组邀请
 */
export function getPendingInvitations() {
  return http.get<{ invitations: GroupInvitation[] }>('/api/invitations');
}

/**
 * 接受群组邀请
 */
export function acceptInvitation(invitationId: number) {
  return http.post<{ message: string }>(`/api/invitations/${invitationId}/accept`);
}

/**
 * 拒绝群组邀请
 */
export function rejectInvitation(invitationId: number) {
  return http.post<{ message: string }>(`/api/invitations/${invitationId}/reject`);
}
