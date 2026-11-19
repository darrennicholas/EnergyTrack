import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'
import Root from './Root.vue'
import { router } from './router'
import './style.css'
import { globalSelect } from './lib/globalSelect'
const app = createApp(Root)
app.directive('global-select', globalSelect)
app.use(createPinia())
app.use(router)
app.use(VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } } }) })
app.mount('#app')
