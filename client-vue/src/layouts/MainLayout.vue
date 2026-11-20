<template>
  <div class="main-layout">
    <aside class="app-sidebar" aria-label="主导航">
      <NPopover
        v-model:show="menuOpen"
        trigger="click"
        placement="right-start"
        :show-arrow="false"
        :width="300"
        :z-index="2100"
        raw
        :style="{ maxWidth: 'calc(100vw - 80px)' }"
        @clickoutside="menuOpen = false"
      >
        <template #trigger>
          <button
            ref="avatarButton"
            type="button"
            class="sidebar-avatar"
            :class="{ 'is-open': menuOpen }"
            aria-haspopup="dialog"
            aria-controls="account-menu"
            :aria-expanded="menuOpen"
            aria-label="打开用户菜单"
          >
            <NAvatar :size="44" :src="authUser?.avatar || undefined">
              {{ avatarInitial }}
              <template #fallback>{{ avatarInitial }}</template>
            </NAvatar>
          </button>
        </template>
        <section ref="accountMenu" id="account-menu" class="user-menu" role="dialog" aria-label="用户信息与账号操作">
          <header class="user-menu-profile">
            <NAvatar :size="56" :src="authUser?.avatar || undefined">
              {{ avatarInitial }}
              <template #fallback>{{ avatarInitial }}</template>
            </NAvatar>
            <div class="user-menu-identity">
              <strong class="user-menu-name">{{ authUser?.nickname || authUser?.username }}</strong>
              <span class="user-menu-account">{{ authUser?.username }}</span>
            </div>
          </header>
          <nav class="user-menu-actions" aria-label="账号操作">
            <button type="button" @click="openProfile('basic')">
              <i class="iconfont icon-id-card" aria-hidden="true"></i>
              个人中心
            </button>
            <button type="button" @click="openProfile('security')">
              <i class="iconfont icon-settings" aria-hidden="true"></i>
              账号与设置
            </button>
            <button type="button" class="user-menu-logout" @click="confirmLogout">
              <i class="iconfont icon-logout" aria-hidden="true"></i>
              退出登录
            </button>
          </nav>
        </section>
      </NPopover>

      <nav class="sidebar-nav" aria-label="功能导航">
        <button
          v-for="item in navItems"
          :key="item.key"
          type="button"
          class="nav-item"
          :class="{ 'is-active': isActive(item.key) }"
          :aria-current="isActive(item.key) ? 'page' : undefined"
          @click="goTo(item.key)"
        >
          <span class="nav-icon-wrap">
            <i class="iconfont nav-icon" :class="item.icon" aria-hidden="true"></i>
            <span v-if="item.badge > 0" class="nav-badge" aria-label="未读消息">
              {{ item.badge > 99 ? '99+' : item.badge }}
            </span>
          </span>
          <span class="nav-label">{{ item.label }}</span>
        </button>
      </nav>
    </aside>

    <main :key="authUser?.id" class="main-content">
      <RouterView v-slot="{ Component, route: viewRoute }">
        <KeepAlive :include="['ContactsWorkspace', 'GroupChatWorkspace']">
          <component :is="Component" :key="viewRoute.name" />
        </KeepAlive>
      </RouterView>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NAvatar, NPopover } from 'naive-ui';
import { storeToRefs } from 'pinia';
import { useAuthStore } from '@/stores/auth';
import { useUnreadStore } from '@/stores/unread';
import { useWindowDialog } from '@/services/useWindowDialog';

type NavKey = 'users' | 'groups' | 'meetings' | 'remote';

const route = useRoute();
const router = useRouter();
const windowDialog = useWindowDialog();
const authStore = useAuthStore();
const { currentUser: authUser } = storeToRefs(authStore);
const unread = useUnreadStore();
const menuOpen = ref(false);
const avatarButton = ref<HTMLButtonElement | null>(null);
const accountMenu = ref<HTMLElement | null>(null);
const contactsPath = ref('/remote');
const groupPath = ref('/group-chat');

const avatarInitial = computed(() =>
  (authUser.value?.nickname || authUser.value?.username || '?').charAt(0),
);
const navItems = computed(() => [
  { key: 'users' as const, label: '联系人', icon: 'icon-contacts-line', badge: unread.privateTotal },
  { key: 'groups' as const, label: '群组', icon: 'icon-group-line', badge: unread.groupTotal },
  { key: 'meetings' as const, label: '会议', icon: 'icon-video', badge: 0 },
  { key: 'remote' as const, label: '远程控制', icon: 'icon-computer', badge: 0 },
]);

// 导航记住当前账户最近的会话 URL；页面缓存负责列表位置和输入草稿。
watch(() => authUser.value?.id, () => {
  contactsPath.value = '/remote';
  groupPath.value = '/group-chat';
  menuOpen.value = false;
});
watch(() => route.fullPath, () => {
  if (route.name === 'Remote') contactsPath.value = route.fullPath;
  if (route.name === 'GroupChat') groupPath.value = route.fullPath;
  menuOpen.value = false;
}, { immediate: true });

function isActive(key: NavKey) {
  if (key === 'users') return route.name === 'Remote';
  if (key === 'groups') return route.name === 'GroupChat' || route.name === 'Groups';
  if (key === 'meetings') return route.name === 'Meetings' || route.name === 'MeetingMinutes';
  return route.name === 'RemoteControl';
}

function goTo(key: NavKey) {
  menuOpen.value = false;
  const target = key === 'users' ? contactsPath.value
    : key === 'groups' ? groupPath.value
    : key === 'meetings' ? '/meetings' : '/remote-control';
  void router.push(target);
}

function openProfile(tab: 'basic' | 'security') {
  menuOpen.value = false;
  void router.push({ name: 'Profile', query: { tab } });
}

function confirmLogout() {
  menuOpen.value = false;
  windowDialog.info({
    positiveButtonProps: { type: 'primary' },
    title: '退出登录？',
    content: '确认退出当前账号吗？',
    positiveText: '退出登录',
    negativeText: '取消',
    onPositiveClick: () => authStore.logout({ navigate: true }),
  });
}

watch(menuOpen, async open => {
  if (!open) return;
  await nextTick();
  if (menuOpen.value) accountMenu.value?.querySelector<HTMLButtonElement>('button')?.focus();
});

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !menuOpen.value) return;
  menuOpen.value = false;
  avatarButton.value?.focus();
}
onMounted(() => document.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown));
</script>

<style scoped>
.main-layout {
  display: flex;
  height: 100dvh;
  width: 100%;
  overflow: hidden;
  background: #f1f5f9;
}
.app-sidebar {
  flex: 0 0 80px;
  width: 80px;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 16px 0 12px;
  background: #f8fafc;
  border-right: 1px solid #cbd5e1c2;
}
:global(html.desktop-macos) .app-sidebar {
  padding-top: max(16px, var(--desktop-window-inset, 0px));
}
.sidebar-avatar {
  flex: none;
  display: grid;
  place-items: center;
  border: 0;
  padding: 4px;
  background: transparent;
  cursor: pointer;
  border-radius: 14px;
  transition: box-shadow 0.15s ease;
}
.sidebar-avatar:hover,
.sidebar-avatar.is-open {
  box-shadow: 0 0 0 3px #2563eb40;
}
.sidebar-avatar:focus-visible,
.nav-item:focus-visible,
.user-menu-actions button:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}
.sidebar-nav {
  margin-top: 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  align-items: center;
  min-height: 0;
  overflow-y: auto;
}
.nav-item {
  flex: none;
  position: relative;
  width: 64px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 4px 6px;
  border: 0;
  border-radius: 12px;
  background: transparent;
  cursor: pointer;
  color: #64748b;
  transition: background 0.15s ease, color 0.15s ease;
}
.nav-item:hover { background: #e2e8f09e; color: #334155; }
.nav-item.is-active { background: #eff6ff; color: #2563eb; font-weight: 600; }
.nav-icon-wrap { position: relative; display: grid; place-items: center; width: 32px; height: 32px; }
.nav-icon { font-size: 22px; line-height: 1; }
.nav-badge {
  position: absolute;
  top: -2px;
  right: -6px;
  display: inline-flex;
  min-width: 16px;
  height: 16px;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
  border-radius: 8px;
  background: #e11d48;
  color: #fff;
  font-size: 10px;
  line-height: 1;
}
.nav-label { font-size: 11px; line-height: 1.2; white-space: nowrap; }
.user-menu { max-height: calc(100dvh - 24px); overflow-y: auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; box-shadow: 0 12px 36px #0f172a24; }
.user-menu-profile { display: flex; align-items: center; gap: 14px; padding: 22px 20px; }
.user-menu-profile :deep(.n-avatar) { flex: none; }
.user-menu-identity { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.user-menu-name { font-size: 16px; color: #0f172a; overflow-wrap: anywhere; }
.user-menu-account { font-size: 12px; color: #64748b; overflow-wrap: anywhere; }
.user-menu-actions { padding: 8px; border-top: 1px solid #e2e8f0; }
.user-menu-actions button { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 44px; padding: 10px 12px; border: 0; border-radius: 8px; color: #334155; background: transparent; text-align: left; cursor: pointer; }
.user-menu-actions button:hover { background: #f1f5f9; }
.user-menu-actions .user-menu-logout { margin-top: 6px; border-top: 1px solid #f1f5f9; border-radius: 0 0 8px 8px; color: #dc2626; }
.user-menu-actions .user-menu-logout:hover { background: #fff1f2; }
.main-content { flex: 1; min-width: 0; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.main-content > :deep(*) { flex: 1; min-height: 0; height: 100%; }
:global(html.desktop-windows:not(.desktop-fullscreen)) .main-content { padding-top: 32px; }
@media (max-width: 767px) {
  .app-sidebar { flex-basis: 60px; width: 60px; }
  .nav-item { width: 48px; }
  .nav-label { font-size: 10px; }
  .nav-icon { font-size: 20px; }
}
</style>
