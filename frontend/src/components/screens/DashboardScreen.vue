<script setup lang="ts">
import { defineAsyncComponent, toRefs } from 'vue'
import Button from '../ui/Button.vue'
const EnergyChart = defineAsyncComponent(() => import('../data/EnergyChart.vue'))

const props = defineProps<{
  monitorFilters: { siteId: string; days: number; bucket: string; comparePrevious: boolean; metric: string }
  summary: any
  series: { date: string; kwh: number }[]
  seriesUnit: string
  sites: { id: string; name: string }[]
  meters: { id: string }[]
  siteBreakdown: any
  recentActivity: any[]
  canReadAuditLog: boolean
  navigate: (item: string) => void
}>()
const { monitorFilters, summary, series, seriesUnit, sites, meters, siteBreakdown, recentActivity, canReadAuditLog, navigate } = toRefs(props)
function formatDashboardDate(value: string) { return new Intl.DateTimeFormat('id-ID',{day:'2-digit',month:'short',year:'numeric',timeZone:summary.value?.timezone||'Asia/Jakarta'}).format(new Date(value)) }
function formatDashboardTimestamp(value: string) { return new Intl.DateTimeFormat('id-ID',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',timeZoneName:'short',timeZone:summary.value?.timezone||'Asia/Jakarta'}).format(new Date(value)) }
</script>

<template>
  <div class="dashboard-screen">
  <div class="dashboard-filterbar" aria-label="Filter dashboard">
    <label>Site<select v-global-select v-model="monitorFilters.siteId"><option value="">Semua site</option><option v-for="site in sites" :key="site.id" :value="site.id">{{ site.name }}</option></select></label>
    <label>Periode<select v-global-select v-model.number="monitorFilters.days"><option :value="7">7 hari</option><option :value="30">30 hari</option><option :value="90">90 hari</option><option :value="365">12 bulan</option></select></label>
    <label>Granularitas<select v-global-select v-model="monitorFilters.bucket"><option value="DAY">Harian</option><option value="WEEK">Mingguan</option><option value="MONTH">Bulanan</option></select></label>
    <label class="dashboard-compare"><input v-model="monitorFilters.comparePrevious" type="checkbox"> Bandingkan periode sebelumnya</label>
  </div>
  <div class="notice">Ringkasan memakai bacaan tervalidasi. Estimasi biaya dan kelengkapan memerlukan konfigurasi tarif serta jadwal meter.</div>
  <div class="kpis">
    <div class="panel kpi"><span>{{ monitorFilters.metric==='POWER_DEMAND'?'Puncak demand (periode)':'Total konsumsi energi' }} · {{ monitorFilters.days }} hari</span><strong>{{ monitorFilters.metric==='POWER_DEMAND'?(summary?.peakDemandKw?.toLocaleString('id-ID') ?? '—'):(summary?.energyKwh?.toLocaleString('id-ID') ?? '—') }} {{ seriesUnit }}</strong><small>Data tervalidasi · {{ summary?.periodStart ? formatDashboardDate(summary.periodStart) : '—' }}–{{ summary?.periodEnd ? formatDashboardDate(summary.periodEnd) : '—' }} · {{ summary?.timezone || 'Asia/Jakarta' }}</small></div>
    <div class="panel kpi"><span>Estimasi biaya</span><strong>{{ summary?.estimatedCostIdr ? Number(summary.estimatedCostIdr).toLocaleString('id-ID') : 'Belum tersedia' }} IDR</strong><small>Tarif efektif dan bacaan energi yang valid</small></div>
    <div class="panel kpi"><span>Kelengkapan data</span><strong>{{ summary?.completenessPercent ?? '—' }}%</strong><small>{{ summary?.observedReadings ?? 0 }} dari {{ summary?.expectedReadings ?? 0 }} interval</small></div>
    <div class="panel kpi"><span>Alert terbuka</span><strong>{{ summary?.openAlerts ?? '—' }}</strong><small>{{ summary?.siteCount ?? sites.length }} site · {{ summary?.meterCount ?? meters.length }} meter</small></div>
  </div>
  <div v-if="summary?.comparison" class="notice comparison-notice">Dibanding periode sebelumnya: {{ summary.comparison.metricChangePercent == null ? 'perbandingan metrik belum tersedia' : `${summary.comparison.metricChangePercent > 0 ? '+' : ''}${summary.comparison.metricChangePercent}%` }} · Biaya {{ summary.comparison.costChangePercent == null ? '—' : `${summary.comparison.costChangePercent > 0 ? '+' : ''}${summary.comparison.costChangePercent}%` }} · kelengkapan periode lalu {{ summary.comparison.completenessPercent ?? '—' }}%</div>
  <div class="dashboard-grid">
    <section class="panel dashboard-trend"><div class="dashboard-panel-heading"><div><h2>Tren konsumsi energi</h2><p class="muted">{{ monitorFilters.days }} hari · data {{ seriesUnit }} tervalidasi</p></div></div><div class="dashboard-chart"><EnergyChart v-if="series.length" :dates="series.map(point => point.date)" :values="series.map(point => point.kwh)" :unit="seriesUnit" /><div v-else class="empty">Belum ada data untuk ditampilkan.</div></div></section>
    <section class="panel dashboard-sites"><h2>Penggunaan energi per site</h2><p class="muted">Distribusi dari {{ monitorFilters.days }} hari terakhir</p><div v-if="siteBreakdown.rows.length" class="site-distribution"><div class="site-donut" role="img" :aria-label="`Distribusi energi untuk ${siteBreakdown.rows.length} site`" :style="{background:`conic-gradient(${siteBreakdown.gradient})`}"><span>{{ siteBreakdown.total.toLocaleString('id-ID',{maximumFractionDigits:0}) }}<small>kWh total</small></span></div><ul><li v-for="row in siteBreakdown.rows" :key="row.siteId"><i :style="{background:row.color}"></i><span>{{ row.siteName || sites.find(site=>site.id===row.siteId)?.name || row.siteId }}</span><b>{{ row.percent.toFixed(0) }}%</b></li></ul></div><div v-else class="empty">Belum ada konsumsi tervalidasi untuk ditampilkan.</div></section>
  </div>
  <section class="panel dashboard-activity"><div class="dashboard-panel-heading"><div><h2>Aktivitas terbaru</h2><p class="muted">Perubahan yang tercatat di organisasi</p></div><Button v-if="canReadAuditLog" variant="secondary" size="small" @click="navigate('Audit Logs')">Lihat semua</Button></div><div v-if="!canReadAuditLog" class="empty">Aktivitas hanya tersedia bagi pengguna yang memiliki akses ke audit log.</div><div v-else class="table-wrap"><table><thead><tr><th>WAKTU</th><th>AKTIVITAS</th><th>PEMILIK</th><th>STATUS</th></tr></thead><tbody><tr v-for="item in recentActivity" :key="item.id"><td>{{ item.createdAt ? formatDashboardTimestamp(item.createdAt) : '—' }}</td><td>{{ String(item.action||'Aktivitas').replaceAll('_',' ') }} · {{ item.entity }}</td><td>{{ item.userId ? String(item.userId).slice(0,8) : 'Sistem' }}</td><td><span class="badge">Tercatat</span></td></tr></tbody></table><div v-if="!recentActivity.length" class="empty">Belum ada aktivitas yang tercatat.</div></div></section>
  </div>
</template>
