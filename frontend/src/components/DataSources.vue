<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

type Source = { id:string; name:string; type:string; description:string|null; status:string; editable:boolean }
const props = defineProps<{ csrfToken:string; canManage:boolean }>()
const route = useRoute(), router = useRouter()
const sources = ref<Source[]>([]), error = ref(''), notice = ref(''), loading = ref(false), saving = ref(false)
const routeValue = (key:string, fallback:string) => typeof route.query[key] === 'string' ? route.query[key] as string : fallback
const search = ref(routeValue('search','')), page = ref(Math.max(1, Number(routeValue('page','1')) || 1)), pageSize = ref([25,50,100].includes(Number(routeValue('pageSize','25'))) ? Number(routeValue('pageSize','25')) : 25), sort = ref(routeValue('sortBy','name')), direction = ref<'asc'|'desc'>(routeValue('sortOrder','asc') === 'desc' ? 'desc' : 'asc'), total = ref(0), pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))
const form = ref({ name:'', type:'CSV', description:'' }), editing = ref<Source|null>(null)
async function call(path:string, options:RequestInit = {}) {
  const headers = new Headers(options.headers)
  if (options.body) headers.set('Content-Type', 'application/json')
  if (options.method && options.method !== 'GET') headers.set('X-CSRF-Token', props.csrfToken)
  const response = await fetch(`/api/v1${path}`, { ...options, headers, credentials:'same-origin' })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error?.message || 'Permintaan gagal.')
  return payload.data
}
async function load() { loading.value = true; error.value = ''; try { const query = new URLSearchParams({ page:String(page.value), pageSize:String(pageSize.value), sortBy:sort.value, sortOrder:direction.value, ...(search.value.trim()?{search:search.value.trim()}:{}) }); const result = await call(`/data-sources?${query}`); sources.value = Array.isArray(result) ? result : result.items; total.value = result.pagination?.total ?? sources.value.length } catch (e) { error.value = (e as Error).message } finally { loading.value = false } }
function sortBy(key:string) { if(sort.value===key)direction.value=direction.value==='asc'?'desc':'asc';else{sort.value=key;direction.value='asc'} }
async function save() {
  saving.value = true; error.value = ''; notice.value = ''
  try {
    if (editing.value) await call(`/data-sources/${editing.value.id}`, { method:'PATCH', body:JSON.stringify({ description:form.value.description }) })
    else await call('/data-sources', { method:'POST', body:JSON.stringify(form.value) })
    editing.value = null; form.value = { name:'', type:'CSV', description:'' }; await load(); notice.value = 'Sumber data tersimpan.'
  } catch (e) { error.value = (e as Error).message } finally { saving.value = false }
}
async function setStatus(source:Source) {
  const status = source.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE'
  if (!window.confirm(`${status === 'ACTIVE' ? 'Aktifkan' : 'Nonaktifkan'} sumber ${source.name}?`)) return
  error.value = ''; try { await call(`/data-sources/${source.id}`, { method:'PATCH', body:JSON.stringify({ status }) }); await load(); notice.value = 'Status sumber diperbarui.' } catch (e) { error.value = (e as Error).message }
}
watch([page,pageSize,sort,direction,search] as const, (value, previous) => {
  if (value[0] === previous[0] && value[0] !== 1 && (value[1] !== previous[1] || value[2] !== previous[2] || value[4] !== previous[4])) { page.value = 1; return }
  const query:Record<string,any>={...route.query,page:String(page.value),pageSize:String(pageSize.value),sortBy:sort.value,sortOrder:direction.value}
  if(search.value.trim())query.search=search.value.trim();else delete query.search
  delete query.sort;delete query.direction
  void router.replace({path:route.path,query})
  void load()
})
watch(() => route.query, query => {
  const pageValue = Number(query.page), sizeValue = Number(query.pageSize)
  page.value = Number.isInteger(pageValue) && pageValue > 0 ? pageValue : 1
  pageSize.value = [25,50,100].includes(sizeValue) ? sizeValue : 25
  search.value = typeof query.search === 'string' ? query.search : ''
  sort.value = ['name','type','status','createdAt'].includes(String(query.sortBy ?? query.sort)) ? String(query.sortBy ?? query.sort) : 'name'
  direction.value = (query.sortOrder ?? query.direction) === 'desc' ? 'desc' : 'asc'
}, { deep:true })
onMounted(load)
</script>

<template>
  <section class="panel import-panel data-sources-panel">
    <div class="table-toolbar"><div><h2>Sumber data</h2><p class="muted">Kelola sumber bacaan MANUAL, CSV, API, dan SIMULATOR.</p></div><button class="secondary" :disabled="loading" @click="load">{{ loading ? 'Memuat…' : 'Muat ulang' }}</button></div>
    <p v-if="error" class="error" role="alert">{{ error }} <button class="secondary" @click="load">Coba lagi</button></p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <div class="data-sources-filters"><label class="search-field">Cari sumber<input v-model="search" type="search" maxlength="200" placeholder="Nama, jenis, deskripsi"></label><label>Baris per halaman<select v-global-select v-model.number="pageSize"><option :value="25">25</option><option :value="50">50</option><option :value="100">100</option></select></label></div>
    <form v-if="canManage" class="data-sources-form" @submit.prevent="save">
      <h2>{{ editing ? 'Edit deskripsi' : 'Tambah sumber data' }}</h2>
      <label>Nama sumber *<input v-model.trim="form.name" required minlength="2" maxlength="100" :disabled="!!editing"></label>
      <label>Jenis *<select v-global-select v-model="form.type" :disabled="!!editing"><option>MANUAL</option><option>CSV</option><option>API</option><option>SIMULATOR</option></select></label>
      <label class="data-sources-description">Deskripsi<textarea v-model.trim="form.description" maxlength="500"></textarea></label>
      <div class="form-actions"><button v-if="editing" type="button" class="secondary" @click="editing=null;form={name:'',type:'CSV',description:''}">Batal</button><button class="primary" :disabled="saving">{{ saving ? 'Menyimpan…' : 'Simpan' }}</button></div>
    </form>
    <p v-if="loading" class="muted" role="status">Memuat sumber data…</p>
    <div v-else class="table-wrap"><table v-if="sources.length"><thead><tr><th><button class="secondary" @click="sortBy('name')">NAMA {{ sort==='name'?(direction==='asc'?'↑':'↓'):'' }}</button></th><th><button class="secondary" @click="sortBy('type')">JENIS {{ sort==='type'?(direction==='asc'?'↑':'↓'):'' }}</button></th><th>DESKRIPSI</th><th><button class="secondary" @click="sortBy('status')">STATUS {{ sort==='status'?(direction==='asc'?'↑':'↓'):'' }}</button></th><th v-if="canManage">AKSI</th></tr></thead><tbody><tr v-for="source in sources" :key="source.id"><td>{{ source.name }}</td><td>{{ source.type }}</td><td>{{ source.description || '—' }}</td><td><span class="badge">{{ source.status }}</span></td><td v-if="canManage"><template v-if="source.editable"><button class="secondary" @click="editing=source;form={name:source.name,type:source.type,description:source.description || ''}">Edit</button> <button class="secondary" @click="setStatus(source)">{{ source.status === 'ACTIVE' ? 'Nonaktifkan' : 'Aktifkan' }}</button></template><span v-else class="muted">Integrasi lama</span></td></tr></tbody></table><p v-else-if="loading" class="muted" role="status">Memuat sumber data…</p><p v-else class="empty">{{ search ? 'Tidak ada sumber yang cocok dengan pencarian.' : 'Belum ada sumber data.' }}</p><div class="table-toolbar"><span class="muted">{{ total }} sumber · halaman {{ page }} dari {{ pageCount }}</span><div><button class="secondary" :disabled="page<=1 || loading" @click="page--">Sebelumnya</button> <button class="secondary" :disabled="page>=pageCount || loading" @click="page++">Berikutnya</button></div></div></div>
  </section>
</template>
