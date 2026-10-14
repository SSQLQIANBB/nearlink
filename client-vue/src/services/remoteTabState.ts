import type { LocationQueryValue } from 'vue-router';

export type RemoteTab = 'users' | 'groups';

export function parseRemoteTab(
  value: LocationQueryValue | LocationQueryValue[] | undefined,
): RemoteTab {
  return value === 'groups' ? 'groups' : 'users';
}

export function getRemoteTabQuery(tab: RemoteTab) {
  return tab === 'groups' ? { tab: 'groups' } : {};
}
