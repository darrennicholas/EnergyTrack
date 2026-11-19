<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { init, use, type ECharts, type EChartsCoreOption } from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

use([LineChart, GridComponent, TooltipComponent, CanvasRenderer])

const props = defineProps<{ dates: string[]; values: number[]; unit?: string }>()
const host = ref<HTMLElement | null>(null)
let chart: ECharts | undefined
let observer: ResizeObserver | undefined
function formatDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(value)
  if (!match) return value
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des']
  return `${Number(match[3])} ${months[Number(match[2]) - 1] || match[2]}${match[4] ? ` ${match[4]}:${match[5]}` : ''}`
}
function render() {
  if (!chart) return
  chart.setOption({
    animation: false,
    grid: { left: 16, right: 24, top: 32, bottom: 16, containLabel: true },
    tooltip: { trigger: 'axis', valueFormatter: (v: unknown) => `${Number(v).toLocaleString('id-ID')} ${props.unit || 'kWh'}` },
    xAxis: { type: 'category', data: props.dates, boundaryGap: false, axisLabel: { color: '#9CB5A8', formatter: formatDate, hideOverlap: true, showMinLabel: true, showMaxLabel: true, margin: 12 }, axisLine: { lineStyle: { color: '#254037' } } },
    yAxis: { type: 'value', name: props.unit || 'kWh', nameTextStyle: { color: '#9CB5A8', align: 'left' }, axisLabel: { color: '#9CB5A8', formatter: (value: number) => value.toLocaleString('id-ID') }, splitLine: { lineStyle: { color: '#1C342B' } } },
    series: [{ type: 'line', data: props.values, smooth: false, showSymbol: false, lineStyle: { color: '#20D595', width: 3 }, areaStyle: { color: 'rgba(32,213,149,.12)' } }]
  } as EChartsCoreOption, true)
}
onMounted(() => { if (!host.value) return; chart = init(host.value); render(); observer = new ResizeObserver(() => chart?.resize()); observer.observe(host.value) })
watch(() => [props.dates, props.values], render, { deep: true })
onBeforeUnmount(() => { observer?.disconnect(); chart?.dispose(); chart = undefined })
</script>
<template><div ref="host" class="energy-chart" role="img" :aria-label="`Grafik energi dalam ${unit || 'kWh'}`"></div></template>
<style scoped>.energy-chart{width:100%;height:260px;min-height:220px}</style>
