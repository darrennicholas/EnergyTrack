<script setup lang="ts">
import { Activity, ArrowUpRight, Bell, Boxes, ChartColumnIncreasing, ChevronDown, ClipboardCheck, Coins, Database, Factory, FileText, Gauge, History, LayoutDashboard, MapPin, Menu, Plug, ScrollText, Search, Settings, Shield, SlidersHorizontal, Target, Upload, UserRound, Users } from '@lucide/vue'
import { onMounted, onUnmounted } from 'vue'

type User = { fullName: string; organization?: { name: string } | null }
type NavigationSection = { name: string; items: string[] }

defineProps<{
  user: User
  visibleSections: NavigationSection[]
  page: string
  pageLabels: Record<string, string>
  menu: boolean
  menuSearch: string
}>()
const emit = defineEmits<{
  'update:menu': [value: boolean]
  'update:menuSearch': [value: string]
  navigate: [item: string]
  signOut: []
}>()

const navIcons = {
  Dashboard: LayoutDashboard, Sites: MapPin, Buildings: Factory, Assets: Boxes, Meters: Gauge,
  Monitoring: Activity, 'Monitoring History': History, 'Data Quality': ClipboardCheck, 'Data Imports': Upload,
  'Tariffs & Cost': Coins, 'Cost Analysis': ChartColumnIncreasing, 'Baselines & Targets': Target,
  'Energy Targets': Target, Alerts: Bell, 'Alert Rules': SlidersHorizontal, 'Energy Audits': ClipboardCheck,
  Emissions: Factory, Reports: FileText, 'Organization Settings': Settings, Users, 'Roles & Permissions': Shield,
  Integrations: Plug, 'Data Sources': Database, 'Audit Logs': ScrollText, 'Analytics & Forecast': ChartColumnIncreasing,
  'My Profile': UserRound, Notifications: Bell
} as const
const iconFor = (item: string) => navIcons[item as keyof typeof navIcons] || FileText
function navigateItem(item: string) { emit('navigate', item) }
let revealObserver: IntersectionObserver | undefined
let contentObserver: MutationObserver | undefined
onMounted(() => {
  const content = document.querySelector('.app-main .content')
  if (!content || window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return
  const selector = '.panel, .notice, .page-heading, .dashboard-filterbar'
  const observed = new WeakSet<Element>()
  revealObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) entry.target.animate([{ opacity: 0.72, transform: 'translateY(12px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 2000, easing: 'cubic-bezier(.16, 1, .3, 1)' })
      revealObserver?.unobserve(entry.target)
    }
  }, { threshold: 0.08 })
  const observe = (root: Element) => {
    const elements = [ ...(root.matches(selector) ? [root] : []), ...Array.from(root.querySelectorAll(selector)) ]
    for (const element of elements) if (!observed.has(element)) { observed.add(element); revealObserver?.observe(element) }
  }
  observe(content)
  contentObserver = new MutationObserver(records => {
    for (const record of records) for (const node of Array.from(record.addedNodes)) if (node instanceof Element) observe(node)
  })
  contentObserver.observe(content, { childList: true, subtree: true })
})
onUnmounted(() => { revealObserver?.disconnect(); contentObserver?.disconnect() })
const today = new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Jakarta' }).format(new Date())
</script>

<template>
  <div class="min-h-screen bg-[#071511]">
    <aside :class="['app-sidebar fixed inset-y-0 left-0 z-30 w-60 overflow-y-auto border-r border-[#18332a] bg-[#06120f] px-3.5 pb-[30px] pt-6 transition-transform duration-200', menu ? 'translate-x-0' : '-translate-x-full']">
      <div class="flex items-center px-[13px] text-[22px] font-extrabold tracking-[-.7px] text-[#f2faf5]"><ArrowUpRight class="mr-1 size-5 text-[#19d39b]" /> EnergiTrack</div>
      <div class="mx-1.5 mb-[27px] mt-6 flex items-center justify-between rounded-lg border border-[#2c4b3f] bg-[#091914] p-3 text-xs text-[#e0eee7]">
        <span class="truncate">{{ user.organization?.name || 'Platform' }}</span><ChevronDown class="ml-2 size-4 shrink-0 text-[#9cb5a8]" aria-hidden="true" />
      </div>
      <nav aria-label="Navigasi utama">
        <div v-for="section in visibleSections" :key="section.name">
          <div class="mb-[9px] mt-6 px-[13px] text-[10px] font-bold tracking-[1.35px] text-[#718e81]">{{ section.name }}</div>
          <button v-for="item in section.items" :key="item" :class="['flex min-h-[38px] w-full items-center gap-3 rounded-[7px] border-0 bg-transparent px-[13px] py-2.5 text-left text-xs font-semibold text-[#aec4b9] transition-colors', { 'sidebar-active': page === item }]" :aria-current="page === item ? 'page' : undefined" @click="navigateItem(item)">
            <component :is="iconFor(item)" class="size-[15px] shrink-0 text-[#19d39b]" aria-hidden="true" />{{ pageLabels[item] || item }}
          </button>
        </div>
        <p v-if="!visibleSections.length" class="mx-3 mt-3 text-[11px] text-[#91aa9e]">Menu tidak ditemukan.</p>
      </nav>
    </aside>
    <div :class="['app-main w-full', { 'sidebar-closed': !menu }]">
      <header class="flex h-[71px] items-center justify-between border-b border-[#213d31] bg-[#0c1b16] px-4 min-[901px]:px-[31px]">
        <button class="rounded-md p-2 text-[#e6f5eb] hover:bg-[#142a22]" :aria-label="menu ? 'Tutup menu' : 'Buka menu'" :aria-expanded="menu" @click="emit('update:menu', !menu)"><Menu class="size-5" /></button>
        <label class="global-search m-0 flex h-[39px] w-[min(345px,42vw)] items-center gap-2 rounded-lg border border-[#264438] bg-[#091913] px-3 text-[#829c8e]">
          <Search class="size-4 shrink-0" aria-hidden="true" />
          <input :value="menuSearch" class="m-0 min-w-0 border-0 bg-transparent p-0 text-[11px] text-foreground shadow-none placeholder:text-muted-foreground focus-visible:ring-0" placeholder="Cari menu..." aria-label="Cari menu" @input="emit('update:menuSearch', ($event.target as HTMLInputElement).value)">
        </label>
        <div class="flex items-center gap-[18px] text-xs text-[#a2b7ab]">
          <span class="hidden text-[11px] min-[551px]:inline">{{ today }} · WIB</span>
          <button class="rounded-md p-2 text-[#8fa99c] hover:bg-[#142a22] hover:text-[#19d39b]" title="Buka alert" aria-label="Buka alert" @click="emit('navigate', 'Alerts')"><Bell class="size-4" /></button>
          <button class="size-8 rounded-full bg-[#123a2b] text-xs font-bold text-[#19d39b] hover:bg-[#174d38]" @click="emit('signOut')" title="Keluar" aria-label="Keluar">{{ user.fullName.slice(0,2).toUpperCase() }}</button>
        </div>
      </header>
      <slot />
    </div>
    <slot name="overlay" />
  </div>
</template>
