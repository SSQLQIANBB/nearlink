import type { LocationQueryValue } from 'vue-router';

export type RemoteTab = 'users' | 'groups';

/** 旧版 ?tab=groups 深链由主路由迁移到群聊工作区。 */
export function parseRemoteTab(value: LocationQueryValue | LocationQueryValue[] | undefined): RemoteTab {
  return value === 'groups' ? 'groups' : 'users';
}

export function getRemoteTabQuery(tab: RemoteTab) {
  return tab === 'groups' ? { tab: 'groups' } : {};
}
