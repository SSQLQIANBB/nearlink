import { createApp } from 'vue';
import App from './App.vue';
import { APP_VERSION_LABEL } from './config/appVersion';
import router from './router';
import './style/tailwind.css';
import './style/iconfont.css';
import './style/desktop.css';
import './style/remote-control.css';
import setupStore from '@/stores/index';

if (import.meta.env.VITE_DESKTOP === 'true') {
  document.documentElement.classList.add('desktop-app');
  if (/Mac/.test(navigator.platform)) document.documentElement.classList.add('desktop-macos');
}

document.title = `ToDesk ${APP_VERSION_LABEL}`;

const app = createApp(App);

setupStore(app);

app.use(router);
app.mount('#app');
