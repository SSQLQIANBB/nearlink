import { createWebHistory, createWebHashHistory, createRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { pinia } from '@/stores';
import { getAuthRedirect } from '@/services/authNavigation';
import { closeAuxiliaryWindow, isAuxiliaryWindow } from '@/services/desktopAuxiliaryContext';
import { openDesktopGroupWindow } from '@/services/desktopAuxiliaryWindows';
import { parseRemoteTab } from '@/services/remoteTabState';

const HOME_ROUTE = { path: '/remote' };

const routes = [
  { path: '/desktop-image', component: { render: () => null } },
  { path: '/desktop-private', component: { render: () => null }, meta: { requiresAuth: true } },
  {
    name: 'Login',
    path: '/login',
    component: () => import('@/views/login.vue'),
    meta: { requiresAuth: false },
  },
  {
    path: '/remote',
    component: () => import('@/layouts/MainLayout.vue'),
    meta: { requiresAuth: true },
    children: [
      {
        name: 'Profile',
        path: '/profile',
        component: () => import('@/views/profile.vue'),
        meta: { requiresAuth: true },
      },
      {
        name: 'Remote',
        path: '',
        component: () => import('@/views/remoteShare/index.vue'),
        meta: { requiresAuth: true },
      },
      {
        name: 'GroupChat',
        path: '/group-chat/:id(\\d+)?',
        component: () => import('@/views/groupChat.vue'),
        meta: { requiresAuth: true },
      },
      {
        name: 'Groups',
        path: '/groups',
        component: () => import('@/views/groups.vue'),
        meta: { requiresAuth: true },
      },
      {
        name: 'Meetings',
        path: '/meetings',
        component: () => import('@/views/meetingLibrary.vue'),
        meta: { requiresAuth: true },
      },
      {
        name: 'MeetingMinutes',
        path: '/meeting-minutes',
        component: () => import('@/views/meetingMinutes.vue'),
        meta: { requiresAuth: true },
      },
      {
        name: 'RemoteControl',
        path: '/remote-control',
        component: () => import('@/views/remoteControl/index.vue'),
        meta: { requiresAuth: true },
      },
    ],
  },
  {
    name: 'GroupVideo',
    path: '/group-video/:id',
    component: () => import('@/views/groupVideo.vue'),
    meta: { requiresAuth: true },
  },
  {
    name: 'GroupAudio',
    path: '/group-audio/:id',
    component: () => import('@/views/groupVideo.vue'),
    meta: { requiresAuth: true },
  },
  {
    name: 'GroupScreen',
    path: '/group-screen/:id',
    component: () => import('@/views/groupScreen.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/screen-share/:kind(private)/:id',
    component: () => import('@/views/groupScreen.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/',
    redirect: '/remote',
  },
];

const router = createRouter({
  routes,
  history: import.meta.env.VITE_DESKTOP === 'true' ? createWebHashHistory() : createWebHistory(),
});

// 路由守卫
router.beforeEach(async (to, _from, next) => {
  if (
    isAuxiliaryWindow &&
    !/^\/(desktop-(image|private)|group-(video|audio|screen)\/\d+|screen-share\/private\/\d+)$/.test(
      to.path,
    )
  ) {
    closeAuxiliaryWindow();
    next(false);
    return;
  }
  const auth = useAuthStore(pinia);

  if (to.path === '/login') {
    if (auth.token) {
      try {
        if (!auth.currentUser) {
          await auth.login();
        }
        next(HOME_ROUTE);
        return;
      } catch (error) {
        console.error('Restore current user before login redirect failed:', error);
        await auth.logout({ callApi: false });
      }
    }

    next();
    return;
  }

  if (to.meta.requiresAuth && !auth.token) {
    const redirect = getAuthRedirect(to.fullPath);
    await auth.logout({ callApi: false });
    next({
      name: 'Login',
      query: redirect ? { redirect } : {},
    });
    return;
  }

  if (auth.token && !auth.currentUser) {
    try {
      await auth.login();
    } catch (error) {
      console.error('Restore current user failed:', error);
      const redirect = getAuthRedirect(to.fullPath);
      await auth.logout({ callApi: false });
      next({
        name: 'Login',
        query: redirect ? { redirect } : {},
      });
      return;
    }
  }

  if (to.meta.requiresAuth && !auth.isAuthenticated) {
    const redirect = getAuthRedirect(to.fullPath);
    await auth.logout({ callApi: false });
    next({
      name: 'Login',
      query: redirect ? { redirect } : {},
    });
    return;
  }

  // 旧群组 Tab 深链继续进入群聊工作区，并保留其他查询参数。
  if (to.name === 'Remote' && parseRemoteTab(to.query.tab) === 'groups') {
    const { tab: _tab, ...query } = to.query;
    next({ name: 'GroupChat', query, hash: to.hash, replace: true });
    return;
  }
  if (to.meta.requiresAuth && (await openDesktopGroupWindow(to.path))) {
    next(false);
    return;
  }
  next();
});

export default router;
