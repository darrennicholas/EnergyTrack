<script setup lang="ts">
defineProps<{
  detail: any
  canEdit: boolean
  activeTab: 'Summary' | 'Buildings' | 'Assets' | 'Meters'
  assets: any[]
}>()
const emit = defineEmits<{ 'update:activeTab': [value: 'Summary' | 'Buildings' | 'Assets' | 'Meters']; edit: []; openMeter: [id: string] }>()
</script>

<template>
  <div class="form-actions site-detail-actions"><button v-if="canEdit" class="secondary" @click="emit('edit')">Edit site</button></div>
  <nav class="detail-tabs" role="tablist" aria-label="Bagian detail site"><button v-for="tab in ['Summary','Buildings','Assets','Meters'] as const" :key="tab" role="tab" :aria-selected="activeTab===tab" :class="{active:activeTab===tab}" @click="emit('update:activeTab',tab)">{{ tab }}</button></nav>
  <div v-if="activeTab==='Summary'" class="detail-grid site-summary"><div><span>Site code</span><strong>{{ detail.code }}</strong></div><div><span>Status</span><strong>{{ detail.status }}</strong></div><div><span>Timezone</span><strong>{{ detail.timezone }}</strong></div><div><span>Manager</span><strong>{{ detail.manager?.fullName || 'Belum ditetapkan' }}</strong></div><div><span>Buildings</span><strong>{{ detail.buildings?.length || 0 }}</strong></div><div><span>Meters</span><strong>{{ detail.meters?.length || 0 }}</strong></div></div>
  <div v-else-if="activeTab==='Buildings'"><article v-for="building in detail.buildings||[]" :key="building.id" class="detail-row"><strong>{{ building.code }} · {{ building.name }}</strong><p class="muted">{{ building.status }} · {{ building.assets?.length||0 }} aset</p></article><p v-if="!detail.buildings?.length" class="empty">Belum ada building pada site ini.</p></div>
  <div v-else-if="activeTab==='Assets'"><article v-for="asset in assets" :key="asset.id" class="detail-row"><strong>{{ asset.code }} · {{ asset.name }}</strong><p class="muted">{{ asset.type }} · {{ asset.status }}</p></article><p v-if="!assets.length" class="empty">Belum ada aset pada site ini.</p></div>
  <div v-else><article v-for="meter in detail.meters||[]" :key="meter.id" class="detail-row clickable" @click="emit('openMeter',meter.id)"><strong>{{ meter.code }} · {{ meter.name }}</strong><p class="muted">{{ meter.meterType }} · {{ meter.status }} · {{ meter.unit }}</p></article><p v-if="!detail.meters?.length" class="empty">Belum ada meter pada site ini.</p></div>
</template>
