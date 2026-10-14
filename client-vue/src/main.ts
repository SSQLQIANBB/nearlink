import { createApp } from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';
import App from './App.vue';
import { APP_VERSION_LABEL } from './config/appVersion';
import router from './router';
import './style/tailwind.css';
import './assets/iconfont/iconfont.css';
import './style/icons.css';
import './style/desktop.css';
import './style/remote-control.css';
import setupStore from '@/stores/index';
import { isAuxiliaryWindow, isDesktopWindow } from '@/services/desktopAuxiliaryContext';

const isShareOverlay = isDesktopWindow && new URLSearchParams(location.search).has('share-overlay');

if (import.meta.env.VITE_DESKTOP === 'true' && !isAuxiliaryWindow && !isShareOverlay) {
  document.documentElement.classList.add('desktop-app');
  if (/Mac/.test(navigator.platform)) document.documentElement.classList.add('desktop-macos');
  if (/Win/.test(navigator.platform)) document.documentElement.classList.add('desktop-windows');
}

if (isAuxiliaryWindow && getCurrentWindow().label === 'media-call') {
  document.documentElement.classList.add('desktop-media-window');
}

document.title = `NearLink ${APP_VERSION_LABEL}`;

async function startApp() {
  if (isShareOverlay) {
    const { default: Overlay } = await import('./DesktopShareOverlay.vue');
    createApp(Overlay).mount('#app');
    return;
  }
  if (!isAuxiliaryWindow) {
    const app = createApp(App);
    setupStore(app);
    app.use(router);
    app.mount('#app');
    return;
  }
  const { initializeAuxiliaryClient, mountAuxiliaryClient } = await import(
    '@/services/desktopAuxiliaryClient'
  );
  const initial = await initializeAuxiliaryClient();
  const { default: AuxiliaryApp } = await import('./DesktopAuxiliaryApp.vue');
  const { useAuthStore } = await import('@/stores/auth');
  const { useSocketStore } = await import('@/stores/socket');
  const { usePrivateCallStore } = await import('@/stores/privateCall');
  const { useNotificationSettingsStore } = await import('@/stores/notificationSettings');
  const app = createApp(AuxiliaryApp);
  setupStore(app);
  const auth = useAuthStore();
  auth.$patch({
    token: initial.token,
    refreshToken: initial.refreshToken,
    currentUser: initial.user,
  });
  if (initial.content.kind !== 'image' && initial.token && initial.user) {
    useSocketStore().connect(initial.token, initial.user);
    void useNotificationSettingsStore().load(initial.user.id);
  }
  app.use(router);
  await router.isReady();
  app.mount('#app');
  await mountAuxiliaryClient(
    () => app.unmount(),
    () => {
      if (initial.content.kind === 'private' && initial.content.request)
        usePrivateCallStore().request = initial.content.request;
    },
  );
}
void startApp().catch((error) => {
  console.error('应用启动失败', error);
  document.getElementById('app')!.textContent = '窗口启动失败，请关闭后重试。';
});
