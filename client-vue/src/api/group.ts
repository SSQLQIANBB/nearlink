import { http } from '@/utils/request';
import type { User } from './auth';

export interface Group {
  id: number;
  name: string;
  description?: string;
  avatar?: string;
  ownerId: number;
  role?: 'owner' | 'admin' | 'member';
  canSpeak?: boolean;
  memberCount?: number;
}

export interface GroupMember extends User {
  role: 'owner' | 'admin' | 'member';
  canSpeak: boolean;
}

export interface GroupDetail {
  group: Group;
  members: GroupMember[];
  myRole: 'owner' | 'admin' | 'member';
  myCanSpeak: boolean;
}

/**
 * 创建群组
 */
export function createGroup(data: { name: string; description?: string; avatar?: string }) {
  return http.post<{ group: Group; message: string }>('/api/groups', data);
}

/**
 * 获取我的群组列表
 */
export function getMyGroups() {
  return http.get<{ groups: Group[] }>('/api/groups/my');
}

/**
 * 获取群组详情
 */
export function getGroupDetail(groupId: number) {
  return http.get<GroupDetail>(`/api/groups/${groupId}`);
}

/**
 * 更新群组信息
 */
export function updateGroup(
  groupId: number,
  data: { name?: string; description?: string; avatar?: string },
) {
  return http.put<{ group: Group; message: string }>(`/api/groups/${groupId}`, data);
}

/**
 * 邀请用户加入群组
 */
export function inviteToGroup(groupId: number, userIds: number[]) {
  return http.post<{ message: string; results: any[] }>(`/api/groups/${groupId}/invite`, {
    userIds,
  });
}

/**
 * 设置成员权限
 */
export function setMemberPermission(groupId: number, targetUserId: number, canSpeak: boolean) {
  return http.post<{ message: string }>(`/api/groups/${groupId}/permission`, {
    targetUserId,
    canSpeak,
  });
}

/**
 * 退出群组
 */
export function leaveGroup(groupId: number) {
  return http.delete<{ message: string }>(`/api/groups/${groupId}/leave`);
}

/**
 * 删除群组（仅群主）
 */
export function deleteGroup(groupId: number) {
  return http.delete<{ message: string }>(`/api/groups/${groupId}`);
}
