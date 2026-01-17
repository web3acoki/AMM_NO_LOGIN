import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { useWalletStore } from './stores/walletStore';

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);

// 初始化钱包store，从localStorage加载已保存的钱包
const walletStore = useWalletStore(pinia);
walletStore.init();

app.mount('#app');


