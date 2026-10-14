import { createWebHistory, createWebHashHistory, createRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { pinia } from '@/stores';
import { getAuthRedirect } from '@/services/authNavigation';

const HOME_ROUTE = { name: 'Remote' };

const routes = [
  {
    name: 'RemoteControl',
    path: '/remote-control',
    component: () => import('@/views/remoteControl/index.vue'),
    meta: { requiresAuth: true },
  },
  {
    name: 'Login',
    path: '/login',
    component: () => import('@/views/login.vue'),
    meta: { requiresAuth: false },
  },
  {
    name: 'Remote',
    path: '/remote',
    component: () => import('@/views/remoteShare/index.vue'),
    meta: { requiresAuth: true },
  },
  {
    name: 'Profile',
    path: '/profile',
    component: () => import('@/views/profile.vue'),
    meta: { requiresAuth: true },
  },
  {
    name: 'Groups',
    path: '/groups',
    component: () => import('@/views/groups.vue'),
    meta: { requiresAuth: true },
  },
  {
    name: 'GroupChat',
    path: '/group-chat/:id',
    component: () => import('@/views/groupChat.vue'),
    meta: { requiresAuth: true },
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
  //#region 测试功能路由
  {
    name: 'Chat',
    path: '/chat',
    component: () => import('@/views/chat.vue'),
    meta: { requiresAuth: false },
  },
  {
    name: 'Socket',
    path: '/socket',
    component: () => import('@/views/socket.vue'),
    meta: { requiresAuth: false },
  },
  {
    name: 'Share',
    path: '/share',
    component: () => import('@/views/share.vue'),
    meta: { requiresAuth: false },
  },
  //#endregion 测试功能路由
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

  next();
});

export default router;
