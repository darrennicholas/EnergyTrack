<script setup lang="ts">
import { RouterView } from 'vue-router'
import { ref } from 'vue'

const loading = ref('')
const active = new Map<number, string>()
let nextId = 0
const originalFetch = window.fetch.bind(window)
window.fetch = async (input, options) => {
  const method = (options?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const url = input instanceof Request ? input.url : String(input)
  if (!/\/api\/v1\//.test(url) || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || /\/(cancel|cancelled)(?:[/?]|$)/i.test(url)) return originalFetch(input, options)
  const id = ++nextId
  const message = method === 'DELETE' ? 'Menghapus data, mohon tunggu...' : method === 'POST' ? 'Menyimpan data, mohon tunggu...' : 'Memperbarui data, mohon tunggu...'
  active.set(id, message)
  loading.value = message
  const started = Date.now()
  try { return await originalFetch(input, options) }
  finally { await new Promise(resolve => setTimeout(resolve, Math.max(0, 1000 - (Date.now() - started)))); active.delete(id); loading.value = Array.from(active.values()).at(-1) || '' }
}
</script>
<template><RouterView /><div v-if="loading" class="global-loading" role="status" aria-live="polite"><div class="global-loading-content"><span class="global-loading-spinner" aria-hidden="true"></span><strong>EnergyTrack</strong><p>{{ loading }}</p><span class="global-loading-bar" aria-hidden="true"></span></div></div></template>
