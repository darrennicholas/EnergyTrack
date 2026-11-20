import { createRouter, createWebHistory } from 'vue-router'
import App from '../App.vue'
import { useWorkspaceStore } from '../stores/workspace'

// Route metadata also drives menu access checks. Backend authorization remains authoritative.
const screens = [
  ['01', 'Dashboard', '/dashboard', ['dashboard.read', 'monitor.read']],
  ['02', 'Sites', '/sites', ['site.read', 'sites.manage']], ['03', 'Site Detail', '/sites/:id', ['site.read', 'sites.manage']],
  ['04', 'Assets', '/assets', ['asset.read', 'asset.manage']], ['05', 'Asset Detail', '/assets/:id', ['asset.read', 'asset.manage']],
  ['06', 'Meters', '/meters', ['meter.read', 'meter.configure']], ['07', 'New Meter', '/meters/new', ['meter.configure']], ['08', 'Meter Detail', '/meters/:id', ['meter.read', 'meter.configure', 'meter.maintain', 'maintenance.manage', 'maintenance.assigned']],
  ['09', 'Monitoring Live', '/monitoring', ['monitor.read']], ['10', 'Monitoring History', '/monitoring/history', ['monitor.read']],
  ['11', 'Data Imports', '/imports', ['reading.import']], ['12', 'Import Detail', '/imports/:id', ['reading.import']], ['13', 'Tariffs', '/tariffs', ['tariff.manage', 'cost.read']],
  ['14', 'Cost Analysis', '/cost-analysis', ['cost.read', 'tariff.manage']], ['15', 'Baselines', '/baselines', ['baseline.manage']],
  ['16', 'Energy Targets', '/targets', ['baseline.manage']], ['17', 'Alerts', '/alerts', ['alert.read']], ['18', 'Alert Rules', '/alert-rules', ['alert.manage']],
  ['19', 'Alert Detail', '/alerts/:id', ['alert.read']], ['20', 'Energy Audits', '/audits', ['audit.read', 'audit.approve', 'audit.assigned']],
  ['21', 'Audit Detail', '/audits/:id', ['audit.read', 'audit.approve', 'audit.assigned']], ['22', 'Emissions', '/emissions', ['emissions.read', 'emissions.manage']],
  ['23', 'Reports', '/reports', ['report.read', 'report.generate', 'report.export']], ['24', 'Report Detail', '/reports/:id', ['report.read', 'report.generate', 'report.export']],
  ['25', 'Organization Settings', '/settings/organization', ['org.manage']], ['26', 'User Management', '/settings/users', ['users.manage']],
  ['27', 'Roles & Permissions', '/settings/roles', ['roles.manage']], ['28', 'Data Sources', '/settings/data-sources', ['reading.import', 'integrations.manage']],
  ['29', 'Audit Logs', '/settings/audit-logs', ['auditlog.read']], ['30', 'Analytics & Forecast', '/analytics', ['forecast.read', 'forecast.run']]
] as const

const publicRoutes = ['/login', '/forgot-password', '/reset-password', '/accept-invitation']
const extraRoutes = [
  { path: '/buildings', screenName: 'Buildings', permission: ['site.read', 'asset.manage'] },
  { path: '/buildings/new', screenName: 'New Building', permission: ['asset.manage'] },
  { path: '/buildings/:id/edit', screenName: 'Edit Building', permission: ['asset.manage'] },
  { path: '/buildings/:id', screenName: 'Building Detail', permission: ['site.read', 'asset.manage'] },
  { path: '/data-quality', screenName: 'Data Quality', permission: ['monitor.read', 'reading.read', 'reading.import'] },
  { path: '/settings/integrations', screenName: 'Integrations', permission: ['integrations.manage'] },
  { path: '/profile', screenName: 'My Profile', permission: [] },
  { path: '/notifications', screenName: 'Notifications', permission: ['notification.read'] },
  { path: '/settings/profile', screenName: 'My Profile', permission: [] },
  { path: '/meters/:id/configuration-history', screenName: 'Configuration History', permission: ['meter.read'] },
  { path: '/meters/:id/maintenance', screenName: 'Meter Maintenance', permission: ['meter.maintain', 'maintenance.manage', 'maintenance.assigned'] },
  { path: '/forbidden', screenName: 'Access Denied', permission: [] }
]

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/dashboard' },
    ...publicRoutes.map(path => ({ path, component: App, meta: { public: true } })),
    ...screens.map(([screenNumber, screenName, path, permission]) => ({ path, component: App, meta: { screenNumber, screenName, permission } })),
    ...extraRoutes.map(route => ({ path: route.path, component: App, meta: { screenName: route.screenName, permission: route.permission } })),
    { path: '/:pathMatch(.*)*', redirect: '/dashboard' }
  ]
})

router.beforeEach(async to => {
  if (to.meta.public) return true
  const workspace = useWorkspaceStore()
  const user = await workspace.loadSession()
  if (!user) return { path: '/login', query: { redirect: to.fullPath } }
  const required = to.meta.permission as string[] | undefined
  if (!workspace.hasAnyPermission(required)) return { path: '/forbidden' }
  return true
})
