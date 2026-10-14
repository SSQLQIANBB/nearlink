import type { App } from 'vue';
import { createPinia } from 'pinia';
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate';

const pinia = createPinia();

// 使用持久化插件
pinia.use(piniaPluginPersistedstate);

export default function setupStore(app: App<Element>) {
  // vue注入pinia
  app.use(pinia);
}

export { pinia };
