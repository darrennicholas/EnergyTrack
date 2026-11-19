import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const routeSources = await Promise.all([
  'server.ts',
  'routes/administration.ts',
  'routes/data-sources.ts',
  'routes/forecast.ts',
  'routes/reading-preview.ts',
].map(path => readFile(new URL(`../backend/src/${path}`, import.meta.url), 'utf8')))
const routes = routeSources.flatMap(source => [...source.matchAll(/\b(?:api|app)\.(get|post|patch|put|delete)\('([^']+)'/g)])
const publicPaths = new Set(['/auth/login', '/auth/forgot-password', '/auth/reset-password', '/auth/accept-invitation', '/ingestion/device-readings', '/api/v1/reports/:id/signed-download', '/health/live', '/health/ready'])
const noBodyPaths = new Set(['/auth/logout', '/sites/:id/archive', '/integration-sources/:id/revoke', '/webhooks/:id/rotate', '/webhooks/:id/revoke', '/webhooks/:id/test', '/reading-imports/:id/confirm'])
const string = (extra = {}) => ({ type: 'string', ...extra })
const uuid = string({ format: 'uuid' })
const isoDateTime = string({ format: 'date-time' })
const localDate = string({ format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$' })
const decimal = { anyOf: [{ type: 'number' }, string({ pattern: '^\\d{1,14}(\\.\\d{1,4})?$' })] }
const object = (properties, required = [], additionalProperties = false) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties })
const bodyContracts = {
  'POST /api/v1/auth/login': object({ email: string({ format: 'email' }), password: string({ maxLength: 200 }) }, ['email', 'password']),
  'POST /api/v1/auth/switch-organization': object({ organizationId: uuid }, ['organizationId']),
  'POST /api/v1/auth/forgot-password': object({ email: string({ format: 'email', maxLength: 254 }) }, ['email']),
  'POST /api/v1/auth/reset-password': object({ token: string({ pattern: '^pr_[a-f0-9]{64}$' }), password: string({ minLength: 12, maxLength: 200 }) }, ['token', 'password']),
  'POST /api/v1/auth/accept-invitation': object({ token: string({ pattern: '^inv_[a-f0-9]{64}$' }), password: string({ minLength: 12, maxLength: 200 }) }, ['token']),
  'PATCH /api/v1/auth/profile': object({ fullName: string({ minLength: 2, maxLength: 150 }) }, ['fullName']),
  'POST /api/v1/auth/change-password': object({ currentPassword: string({ maxLength: 200 }), newPassword: string({ minLength: 12, maxLength: 200 }) }, ['currentPassword', 'newPassword']),
  'PATCH /api/v1/organization': object({ name: string({ minLength: 2, maxLength: 200 }) }, ['name']),
  'POST /api/v1/invitations': { ...object({ email: string({ format: 'email', maxLength: 254 }), fullName: string({ minLength: 2, maxLength: 150 }), role: string({ enum: ['ADMIN', 'ENERGY_MANAGER', 'FACILITY_MANAGER', 'ANALYST', 'TECHNICIAN', 'EXECUTIVE', 'AUDITOR'] }), roleId: uuid, siteIds: { type: 'array', items: uuid, maxItems: 500 } }, ['email', 'fullName']), anyOf: [{ required: ['role'] }, { required: ['roleId'] }] },
  'PATCH /api/v1/users/{id}': object({ role: string({ enum: ['ADMIN', 'ENERGY_MANAGER', 'FACILITY_MANAGER', 'ANALYST', 'TECHNICIAN', 'EXECUTIVE', 'AUDITOR'] }), roleId: uuid, active: { type: 'boolean' }, siteIds: { type: 'array', items: uuid, maxItems: 500 } }),
  'POST /api/v1/roles': object({ name: string({ minLength: 2, maxLength: 100 }), description: string({ maxLength: 500 }), scope: string({ enum: ['ORGANIZATION', 'ASSIGNED_SITES'] }), permissionCodes: { type: 'array', maxItems: 100, uniqueItems: true, items: string({ minLength: 2, maxLength: 100 }) } }, ['name', 'scope', 'permissionCodes']),
  'PATCH /api/v1/roles/{id}': object({ name: string({ minLength: 2, maxLength: 100 }), description: { ...string({ maxLength: 500 }), type: ['string', 'null'] }, scope: string({ enum: ['ORGANIZATION', 'ASSIGNED_SITES'] }), active: { type: 'boolean' }, permissionCodes: { type: 'array', maxItems: 100, uniqueItems: true, items: string({ minLength: 2, maxLength: 100 }) } }),
  'POST /api/v1/platform/organizations': object({ code: string({ pattern: '^[A-Z0-9][A-Z0-9-]{1,63}$' }), name: string({ minLength: 2, maxLength: 200 }), adminEmail: string({ format: 'email', maxLength: 254 }), adminFullName: string({ minLength: 2, maxLength: 150 }) }, ['code', 'name', 'adminEmail', 'adminFullName']),
  'POST /api/v1/integration-sources': object({ name: string({ minLength: 2, maxLength: 150 }), meterIds: { type: 'array', minItems: 1, maxItems: 500, items: uuid }, ipAllowlist: { type: 'array', maxItems: 100, items: string({ format: 'ip' }) }, rateLimitPerMinute: { type: 'integer', minimum: 1, maximum: 6000, default: 60 } }, ['name', 'meterIds']),
  'POST /api/v1/webhooks': object({ name: string({ minLength: 2, maxLength: 120 }), url: string({ format: 'uri', maxLength: 2000 }), events: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', enum: ['alert.created', 'alert.updated', 'reading.import.completed', 'report.completed'] } } }, ['name', 'url', 'events']),
  'PATCH /api/v1/integration-sources/{id}': object({ meterIds: { type: 'array', minItems: 1, maxItems: 500, items: uuid }, ipAllowlist: { type: 'array', maxItems: 100, items: string({ format: 'ip' }) }, rateLimitPerMinute: { type: 'integer', minimum: 1, maximum: 6000 } }),
  'POST /api/v1/integration-sources/{id}/rotate': object({ graceMinutes: { type: 'integer', minimum: 1, maximum: 1440, default: 60 } }),
  'POST /api/v1/site-assignments': object({ userId: uuid, siteId: uuid }, ['userId', 'siteId']),
  'POST /api/v1/buildings': object({ siteId: uuid, code: string({ pattern: '^[A-Z0-9-]{1,100}$' }), name: string({ minLength: 2, maxLength: 200 }), status: string({ enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' }) }, ['siteId', 'code', 'name']),
  'PATCH /api/v1/buildings/{id}': object({ code: string({ pattern: '^[A-Z0-9-]{1,100}$' }), name: string({ minLength: 2, maxLength: 200 }), status: string({ enum: ['ACTIVE', 'INACTIVE', 'ARCHIVED'] }) }),
  'POST /api/v1/sites': object({ code: string({ pattern: '^[A-Z0-9-]+$' }), name: string({ minLength: 2, maxLength: 200 }), type: string({ enum: ['FACTORY', 'OFFICE', 'COMMERCIAL', 'WAREHOUSE', 'OTHER'] }), address: string({ minLength: 10, maxLength: 500 }), timezone: string(), latitude: { type: ['number', 'null'], minimum: -90, maximum: 90 }, longitude: { type: ['number', 'null'], minimum: -180, maximum: 180 }, operatingSchedule: { type: ['array', 'null'], items: object({ dayOfWeek: { type: 'integer', minimum: 0, maximum: 6 }, start: string({ pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' }), end: string({ pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' }) }, ['dayOfWeek', 'start', 'end']), maxItems: 21 }, managerId: { ...uuid, type: ['string', 'null'] }, emissionRegion: { ...string({ minLength: 2, maxLength: 150 }), type: ['string', 'null'] }, status: string({ enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' }) }, ['code', 'name', 'type', 'address', 'timezone']),
  'POST /api/v1/meters': object({ code: string({ minLength: 1, maxLength: 100 }), siteId: uuid, assetId: uuid, serialNumber: string({ minLength: 1, maxLength: 150 }), installedAt: isoDateTime, decommissionedAt: isoDateTime, meterType: string({ enum: ['CUMULATIVE', 'INTERVAL'] }), metric: string({ enum: ['ENERGY_IMPORT', 'POWER_DEMAND'] }), unit: string({ enum: ['kWh', 'kW'] }), sourceType: string({ enum: ['MANUAL', 'CSV', 'API', 'SIMULATOR', 'MQTT'] }), intervalMinutes: { type: 'integer', enum: [1, 5, 15, 30, 60] }, multiplier: { type: 'number', exclusiveMinimum: 0 }, rolloverValue: string({ pattern: '^\\d{1,14}(\\.\\d{1,6})?$' }), status: string({ const: 'PENDING', default: 'PENDING' }) }, ['code', 'siteId', 'meterType', 'metric', 'unit', 'sourceType', 'intervalMinutes', 'multiplier']),
  'POST /api/v1/meters/{id}/configuration-versions': object({ sourceType: string({ enum: ['MANUAL', 'CSV', 'API', 'SIMULATOR', 'MQTT'] }), intervalMinutes: { type: 'integer', enum: [1, 5, 15, 30, 60] }, multiplier: { type: 'number', exclusiveMinimum: 0, maximum: 1000000 }, rolloverValue: { ...string({ pattern: '^\\d{1,14}(\\.\\d{1,6})?$' }), type: ['string', 'null'] }, effectiveFrom: isoDateTime, reason: string({ minLength: 2, maxLength: 1000 }) }, ['sourceType', 'intervalMinutes', 'multiplier', 'effectiveFrom', 'reason']),
  'PATCH /api/v1/meters/{id}/status': object({ status: string({ enum: ['PENDING', 'TESTING', 'ONLINE', 'OFFLINE', 'MAINTENANCE', 'RETIRED'] }) }, ['status']),
  'POST /api/v1/ingestion/readings': object({ readings: { type: 'array', minItems: 1, maxItems: 5000, items: object({ meterId: uuid, externalReadingId: string({ minLength: 1, maxLength: 200 }), timestamp: isoDateTime, value: string({ pattern: '^\\d{1,14}(\\.\\d{1,6})?$' }), unit: string({ enum: ['kWh', 'kW'] }), metric: string({ enum: ['ENERGY_IMPORT', 'POWER_DEMAND'] }), quality: string({ enum: ['VALID', 'ESTIMATED', 'SUSPECT', 'INVALID'], default: 'VALID' }) }, ['meterId', 'timestamp', 'value', 'unit']) } }, ['readings']),
  'POST /api/v1/ingestion/device-readings': object({ meterId: uuid, timestamp: isoDateTime, value: string({ pattern: '^\\d{1,14}(\\.\\d{1,6})?$' }), unit: string({ enum: ['kWh', 'kW'] }) }, ['meterId', 'timestamp', 'value', 'unit']),
  'POST /api/v1/reading-imports': object({ fileName: string({ minLength: 1, maxLength: 255 }), csv: string({ minLength: 1, maxLength: 10000000 }), mode: string({ enum: ['VALIDATE_ONLY', 'COMMIT'] }) }, ['fileName', 'csv', 'mode']),
  'POST /api/v1/data-sources': object({ name: string({ minLength: 2, maxLength: 100 }), type: string({ enum: ['MANUAL', 'CSV', 'API', 'SIMULATOR'] }), description: string({ maxLength: 500 }) }, ['name', 'type']),
  'PATCH /api/v1/data-sources/{id}': object({ description: { type: ['string', 'null'], maxLength: 500 }, status: string({ enum: ['ACTIVE', 'INACTIVE'] }) }),
  'POST /api/v1/simulator/readings': object({ meterId: uuid, startAt: isoDateTime, count: { type: 'integer', minimum: 1, maximum: 5000 }, intervalMinutes: { type: 'integer', enum: [1, 5, 15, 30, 60] }, baseValue: { type: 'number', minimum: 0, maximum: 1000000000 }, amplitude: { type: 'number', minimum: 0, maximum: 1000000, default: 0 } }, ['meterId', 'startAt', 'count', 'baseValue']),
  'POST /api/v1/meters/{id}/maintenance': object({ category: string({ enum: ['PREVENTIVE', 'CORRECTIVE', 'CALIBRATION', 'INSPECTION'] }), title: string({ minLength: 2, maxLength: 200 }), scheduledAt: isoDateTime, assignedTo: uuid }, ['category', 'title']),
  'PATCH /api/v1/meter-maintenance/{id}/status': object({ status: string({ enum: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'] }), workNotes: string({ minLength: 2, maxLength: 4000 }), outcome: string({ minLength: 2, maxLength: 4000 }) }, ['status']),
  'POST /api/v1/meter-maintenance/{id}/evidence': object({ fileName: string({ minLength: 1, maxLength: 180 }), contentType: string({ enum: ['application/pdf', 'image/jpeg', 'image/png'] }), contentBase64: string({ format: 'byte', minLength: 4, maxLength: 7000000 }) }, ['fileName', 'contentType', 'contentBase64']),
  'POST /api/v1/assets': object({ siteId: uuid, buildingId: uuid, code: string({ minLength: 1, maxLength: 100 }), name: string({ minLength: 2, maxLength: 200 }), type: string({ minLength: 2, maxLength: 100 }), status: string({ enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' }) }, ['siteId', 'code', 'name', 'type']),
  'PATCH /api/v1/assets/{id}': object({ name: string({ minLength: 2, maxLength: 200 }), type: string({ minLength: 2, maxLength: 100 }), status: string({ enum: ['ACTIVE', 'INACTIVE', 'ARCHIVED'] }), buildingId: { ...uuid, type: ['string', 'null'] } }),
  'POST /api/v1/meters/{id}/readings/{readingId}/revisions': object({ value: string({ pattern: '^\\d{1,14}(\\.\\d{1,6})?$' }), quality: string({ enum: ['VALID', 'ESTIMATED', 'SUSPECT', 'INVALID'], default: 'VALID' }), reason: string({ minLength: 2, maxLength: 1000 }) }, ['value', 'reason']),
  'POST /api/v1/audit-findings/{id}/actions': object({ ownerId: uuid, dueDate: localDate }, ['ownerId', 'dueDate']),
  'POST /api/v1/corrective-actions/{id}/close': object({ outcome: string({ minLength: 2, maxLength: 4000 }), evidenceUrl: string({ format: 'uri', maxLength: 2000 }) }, ['outcome', 'evidenceUrl']),
  'POST /api/v1/audits': object({ siteId: uuid, title: string({ minLength: 2, maxLength: 200 }), assignedAuditorId: uuid, scheduledAt: isoDateTime }, ['siteId', 'title', 'assignedAuditorId']),
  'POST /api/v1/audits/{id}/findings': object({ severity: string({ enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] }), observation: string({ minLength: 2, maxLength: 4000 }), recommendation: string({ minLength: 2, maxLength: 4000 }) }, ['severity', 'observation', 'recommendation']),
  'POST /api/v1/audits/{id}/transition': object({ status: string({ enum: ['SCHEDULED', 'IN_PROGRESS', 'SUBMITTED', 'APPROVED', 'REVISION_REQUIRED', 'CLOSED'] }), comments: string({ maxLength: 2000 }) }, ['status']),
  'POST /api/v1/audits/{id}/evidence': object({ fileName: string({ minLength: 1, maxLength: 180 }), contentType: string({ enum: ['application/pdf', 'image/jpeg', 'image/png'] }), contentBase64: string({ format: 'byte', minLength: 4, maxLength: 7000000 }) }, ['fileName', 'contentType', 'contentBase64']),
  'POST /api/v1/analytics/forecast-runs': object({ siteId: uuid, meterId: uuid, days: { type: 'integer', minimum: 8, maximum: 365, default: 30 }, horizon: { type: 'integer', minimum: 1, maximum: 30, default: 7 }, model: string({ enum: ['MOVING_AVERAGE', 'EXPONENTIAL_SMOOTHING', 'COMPARE', 'EXOGENOUS_LINEAR'], default: 'MOVING_AVERAGE' }), alpha: { type: 'number', exclusiveMinimum: 0, maximum: 1, default: 0.3 }, exogenousHistory: { type: 'array', maxItems: 365, items: object({ date: localDate, weatherIndex: { type: 'number' }, productionUnits: { type: 'number' } }) }, exogenousFuture: { type: 'array', maxItems: 30, items: object({ date: localDate, weatherIndex: { type: 'number' }, productionUnits: { type: 'number' } }) } }, ['siteId']),
  'POST /api/v1/forecast-drivers': object({ siteId: uuid, rows: { type: 'array', minItems: 1, maxItems: 365, items: { allOf: [object({ date: localDate, weatherIndex: { type: 'number', minimum: -100, maximum: 100 }, productionUnits: { type: 'number', minimum: 0, maximum: 1000000000000 } }), { anyOf: [{ required: ['weatherIndex'] }, { required: ['productionUnits'] }] }] } } }, ['siteId', 'rows']),
  'POST /api/v1/forecast-drivers/weather-sync': object({ siteId: uuid, days: { type: 'integer', minimum: 1, maximum: 15, default: 7 } }, ['siteId']),
  'POST /api/v1/reports': object({ type: string({ enum: ['ENERGY', 'COST', 'QUALITY', 'ALERTS', 'AUDIT', 'EMISSIONS'], default: 'ENERGY' }), periodStart: isoDateTime, periodEnd: isoDateTime, siteId: uuid, buildingId: uuid, meterId: uuid, timezone: string(), granularity: string({ enum: ['HOUR', 'DAY', 'WEEK', 'MONTH'], default: 'DAY' }), emissionFactorId: uuid, format: string({ enum: ['CSV', 'XLSX', 'PDF'], default: 'CSV' }) }, ['periodStart', 'periodEnd']),
  'POST /api/v1/alerts/{id}/transition': object({ status: string({ enum: ['ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED', 'FALSE_POSITIVE'] }), note: string({ maxLength: 2000 }) }, ['status']),
  'POST /api/v1/alert-rules': object({ name: string({ minLength: 2, maxLength: 150 }), scopeType: string({ enum: ['SITE', 'METER'] }), scopeId: uuid, metric: string({ enum: ['ENERGY_IMPORT', 'POWER_DEMAND'] }), operator: string({ enum: ['GT', 'LT', 'OUTSIDE_RANGE'] }), threshold: decimal, thresholdMax: decimal, windowMinutes: { type: 'integer', minimum: 1, maximum: 1440 }, cooldownMinutes: { type: 'integer', minimum: 0, maximum: 10080 }, severity: string({ enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] }), channels: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: string({ enum: ['IN_APP', 'EMAIL'] }) }, assigneeId: uuid }, ['name', 'scopeType', 'scopeId', 'metric', 'operator', 'threshold', 'windowMinutes', 'cooldownMinutes', 'severity', 'channels']),
  'PATCH /api/v1/notification-preferences': object({ inAppEnabled: { type: 'boolean' }, emailEnabled: { type: 'boolean' } }),
  'PATCH /api/v1/organization': object({ name: string({ minLength: 2, maxLength: 200 }), auditApprovalSoD: { type: 'boolean' } }),
  'POST /api/v1/baselines': object({ siteId: uuid, metric: string({ const: 'ENERGY_IMPORT' }), startDate: localDate, endDate: localDate, value: { type: 'number', minimum: 0 }, denominator: { type: 'number', minimum: 0 }, denominatorUnit: string({ minLength: 1 }), approvalNotes: string({ maxLength: 2000 }) }, ['siteId', 'metric', 'startDate', 'endDate', 'value']),
  'POST /api/v1/baselines/{id}/approve': object({ notes: string({ minLength: 2, maxLength: 2000 }) }, ['notes']),
  'POST /api/v1/baselines/{id}/revisions': object({ startDate: localDate, endDate: localDate, value: { type: 'number', minimum: 0 }, denominator: { type: 'number', minimum: 0 }, denominatorUnit: string({ minLength: 1 }), approvalNotes: string({ maxLength: 2000 }) }, ['startDate', 'endDate', 'value']),
  'POST /api/v1/targets': object({ siteId: uuid, metric: string({ const: 'ENERGY_IMPORT' }), startDate: localDate, endDate: localDate, targetValue: { type: 'number', minimum: 0 }, unit: string({ const: 'kWh' }) }, ['siteId', 'metric', 'startDate', 'endDate', 'targetValue', 'unit']),
  'POST /api/v1/emission-factors': object({ region: string({ minLength: 2, maxLength: 150 }), energySource: string({ enum: ['ELECTRICITY', 'NATURAL_GAS', 'DIESEL', 'GASOLINE', 'STEAM', 'OTHER'], default: 'ELECTRICITY' }), factor: { type: 'number', minimum: 0 }, unit: string({ const: 'kgCO2e/kWh' }), publicationSource: string({ minLength: 2, maxLength: 500 }), applicableYear: { type: 'integer', minimum: 1900, maximum: 2200 }, sourceUrl: string({ format: 'uri' }), effectiveFrom: localDate, effectiveTo: localDate }, ['region', 'factor', 'unit', 'publicationSource', 'applicableYear', 'sourceUrl', 'effectiveFrom']),
  'POST /api/v1/tariffs': object({ name: string({ minLength: 2, maxLength: 150 }), currency: string({ const: 'IDR', default: 'IDR' }), tariffType: string({ enum: ['FLAT', 'TOU'], default: 'FLAT' }), unitRate: { type: 'number', minimum: 0, default: 0 }, fixedCharge: { type: 'number', minimum: 0, default: 0 }, taxPercent: { type: 'number', minimum: 0, maximum: 100, default: 0 }, rates: { type: 'array', maxItems: 24, items: object({ startMinute: { type: 'integer', minimum: 0, maximum: 1439 }, endMinute: { type: 'integer', minimum: 1, maximum: 1440 }, unitRate: { type: 'number', minimum: 0 } }, ['startMinute', 'endMinute', 'unitRate']) }, effectiveFrom: localDate, effectiveTo: localDate }, ['name', 'effectiveFrom']),
  'POST /api/v1/tariff-assignments': object({ meterId: uuid, tariffId: uuid, effectiveFrom: localDate, effectiveTo: localDate }, ['meterId', 'tariffId', 'effectiveFrom']),
  'POST /api/v1/quarantined-readings/{id}/release': object({ meterId: uuid, timestamp: isoDateTime, value: string({ pattern: '^\\d{1,14}(\\.\\d{1,6})?$' }), unit: string({ enum: ['kWh', 'kW'] }) }, ['meterId', 'timestamp', 'value', 'unit']),
  'PATCH /api/v1/sites/{id}': object({ code: string({ pattern: '^[A-Z0-9-]+$' }), name: string({ minLength: 2, maxLength: 200 }), type: string({ enum: ['FACTORY', 'OFFICE', 'COMMERCIAL', 'WAREHOUSE', 'OTHER'] }), address: string({ minLength: 10, maxLength: 500 }), timezone: string(), latitude: { type: ['number', 'null'], minimum: -90, maximum: 90 }, longitude: { type: ['number', 'null'], minimum: -180, maximum: 180 }, operatingSchedule: { type: ['array', 'null'], maxItems: 21, items: object({ dayOfWeek: { type: 'integer', minimum: 0, maximum: 6 }, start: string({ pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' }), end: string({ pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' }) }, ['dayOfWeek', 'start', 'end']) }, managerId: { ...uuid, type: ['string', 'null'] }, emissionRegion: { ...string({ minLength: 2, maxLength: 150 }), type: ['string', 'null'] }, status: string({ enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' }) }),
}
const queryContracts = {
  'GET /api/v1/buildings': [{ name: 'siteId', schema: uuid }],
  'GET /api/v1/meters/{id}/readings': [{ name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 } }, { name: 'cursor', schema: uuid }],
  'GET /api/v1/data-quality': [{ name: 'siteId', schema: uuid }, { name: 'meterId', schema: uuid }, { name: 'days', schema: { type: 'integer', minimum: 1, maximum: 366, default: 30 } }, { name: 'periodStart', schema: isoDateTime }, { name: 'periodEnd', schema: isoDateTime }],
  'GET /api/v1/monitoring/summary': [{ name: 'siteId', schema: uuid }, { name: 'buildingId', schema: uuid }, { name: 'meterId', schema: uuid }, { name: 'metric', schema: string({ enum: ['ENERGY_IMPORT', 'POWER_DEMAND'], default: 'ENERGY_IMPORT' }) }, { name: 'periodStart', schema: isoDateTime }, { name: 'periodEnd', schema: isoDateTime }, { name: 'days', schema: { type: 'integer', minimum: 1, maximum: 365, default: 30 } }, { name: 'comparePrevious', schema: string({ enum: ['true', 'false'], default: 'false' }) }],
  'GET /api/v1/monitoring/timeseries': [{ name: 'siteId', schema: uuid }, { name: 'buildingId', schema: uuid }, { name: 'meterId', schema: uuid }, { name: 'metric', schema: string({ enum: ['ENERGY_IMPORT', 'POWER_DEMAND'], default: 'ENERGY_IMPORT' }) }, { name: 'bucket', schema: string({ enum: ['HOUR', 'DAY', 'WEEK', 'MONTH'], default: 'DAY' }) }, { name: 'periodStart', schema: isoDateTime }, { name: 'periodEnd', schema: isoDateTime }, { name: 'days', schema: { type: 'integer', minimum: 1, maximum: 365, default: 30 } }],
  'GET /api/v1/cost-analysis': [{ name: 'periodStart', required: true, schema: isoDateTime }, { name: 'periodEnd', required: true, schema: isoDateTime }, { name: 'siteId', schema: uuid }],
  'GET /api/v1/emissions/estimate': [{ name: 'siteId', required: true, schema: uuid }, { name: 'factorId', schema: uuid }, { name: 'periodStart', required: true, schema: isoDateTime }, { name: 'periodEnd', required: true, schema: isoDateTime }],
  'GET /api/v1/analytics/forecast': [{ name: 'siteId', required: true, schema: uuid }, { name: 'meterId', schema: uuid }, { name: 'days', schema: { type: 'integer', minimum: 8, maximum: 365, default: 30 } }, { name: 'horizon', schema: { type: 'integer', minimum: 1, maximum: 30, default: 7 } }, { name: 'model', schema: string({ enum: ['MOVING_AVERAGE', 'EXPONENTIAL_SMOOTHING', 'COMPARE', 'EXOGENOUS_LINEAR'], default: 'MOVING_AVERAGE' }) }, { name: 'alpha', schema: { type: 'number', exclusiveMinimum: 0, maximum: 1, default: 0.3 } }],
  'GET /api/v1/forecast-drivers': [{ name: 'siteId', required: true, schema: uuid }, { name: 'from', schema: localDate }, { name: 'to', schema: localDate }],
  'GET /api/v1/analytics/forecast-runs': [{ name: 'siteId', schema: uuid }, { name: 'meterId', schema: uuid }],
  'GET /api/v1/quarantined-readings': [{ name: 'status', schema: string({ enum: ['OPEN', 'RELEASED', 'DISCARDED'] }) }, { name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } }],
  'GET /api/v1/notification-deliveries': [{ name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } }],
  'GET /api/v1/audit-logs': [{ name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } }],
  'GET /api/v1/platform/audit-logs': [{ name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } }],
  'GET /api/v1/baselines/{id}/compare': [{ name: 'periodStart', schema: localDate }, { name: 'periodEnd', schema: localDate }],
}
const pagedGetPaths = new Set(['/api/v1/sites', '/api/v1/buildings', '/api/v1/meters', '/api/v1/assets', '/api/v1/reading-imports', '/api/v1/data-sources', '/api/v1/baselines', '/api/v1/targets', '/api/v1/alert-rules', '/api/v1/audits', '/api/v1/emission-factors', '/api/v1/reports', '/api/v1/audit-logs', '/api/v1/users', '/api/v1/roles', '/api/v1/tariffs', '/api/v1/tariff-assignments', '/api/v1/alerts', '/api/v1/integration-sources', '/api/v1/webhooks', '/api/v1/notification-deliveries', '/api/v1/analytics/forecast-runs', '/api/v1/invitations', '/api/v1/site-assignments', '/api/v1/quarantined-readings', '/api/v1/webhooks/{id}/deliveries', '/api/v1/meters/{id}/configuration-history', '/api/v1/meters/{id}/maintenance', '/api/v1/forecast-drivers', '/api/v1/platform/organizations', '/api/v1/platform/audit-logs'])
const responseContracts = {
  'POST /api/v1/auth/login': { $ref: '#/components/schemas/AuthSession' },
  'POST /api/v1/auth/forgot-password': { $ref: '#/components/schemas/MessageResponse' },
  'POST /api/v1/auth/reset-password': { $ref: '#/components/schemas/MessageResponse' },
  'GET /api/v1/auth/me': { $ref: '#/components/schemas/AuthenticatedUser' },
  'POST /api/v1/auth/switch-organization': { $ref: '#/components/schemas/OrganizationSwitchResult' },
  'PATCH /api/v1/auth/profile': { $ref: '#/components/schemas/ProfileResponse' },
  'POST /api/v1/auth/change-password': { $ref: '#/components/schemas/MessageResponse' },
  'POST /api/v1/auth/accept-invitation': { $ref: '#/components/schemas/InvitationAccepted' },
  'POST /api/v1/ingestion/device-readings': { $ref: '#/components/schemas/DeviceIngestionResult' },
  'POST /api/v1/reading-imports/preview': { $ref: '#/components/schemas/ImportPreview' },
  'PATCH /api/v1/notification-preferences': { $ref: '#/components/schemas/NotificationPreferences' },
  'POST /api/v1/audit-findings/{id}/actions': { $ref: '#/components/schemas/CorrectiveAction' },
  'POST /api/v1/corrective-actions/{id}/close': { $ref: '#/components/schemas/CorrectiveAction' },
  'GET /api/v1/organization': { $ref: '#/components/schemas/Organization' },
  'GET /api/v1/permissions': { type: 'array', items: { $ref: '#/components/schemas/Permission' } },
  'GET /api/v1/platform/permissions': { type: 'array', items: { $ref: '#/components/schemas/Permission' } },
  'GET /api/v1/platform/config': { $ref: '#/components/schemas/PlatformConfig' },
  'GET /api/v1/platform/organizations': { type: 'array', items: { $ref: '#/components/schemas/OrganizationSummary' } },
  'GET /api/v1/platform/audit-logs': { type: 'array', items: { $ref: '#/components/schemas/PlatformAuditLog' } },
  'GET /api/v1/data-quality': { $ref: '#/components/schemas/DataQualitySummary' },
  'GET /api/v1/cost-analysis': { $ref: '#/components/schemas/CostAnalysisResult' },
  'GET /api/v1/emissions/estimate': { $ref: '#/components/schemas/EmissionsEstimate' },
  'GET /api/v1/tariff-assignments': { type: 'array', items: { $ref: '#/components/schemas/TariffAssignment' } },
  'GET /api/v1/notification-preferences': { $ref: '#/components/schemas/NotificationPreferences' },
  'GET /api/v1/health/live': { $ref: '#/components/schemas/HealthStatus' },
  'GET /api/v1/health/ready': { $ref: '#/components/schemas/HealthStatus' },
  'GET /api/v1/monitoring/summary': { $ref: '#/components/schemas/MonitoringSummary' },
  'GET /api/v1/monitoring/timeseries': { type: 'array', items: { $ref: '#/components/schemas/MonitoringPoint' } },
  'GET /api/v1/analytics/forecast': { $ref: '#/components/schemas/ForecastResponse' },
  'POST /api/v1/analytics/forecast-runs': { $ref: '#/components/schemas/ForecastRun' },
  'GET /api/v1/forecast-drivers': { $ref: '#/components/schemas/ForecastDriverPage' },
  'POST /api/v1/forecast-drivers': { $ref: '#/components/schemas/ForecastDriverSaveResult' },
  'POST /api/v1/forecast-drivers/weather-sync': { $ref: '#/components/schemas/WeatherSyncResult' },
}
const resourceForPath = path => {
  if (path.endsWith('/analytics/forecast-runs')) return 'ForecastRun'
  if (path.endsWith('/readings')) return 'MeterReading'
  if (path.endsWith('/configuration-history')) return 'MeterConfigVersion'
  if (path.endsWith('/maintenance')) return 'MeterMaintenance'
  if (path.endsWith('/deliveries')) return 'WebhookDelivery'
  const root = path.split('/').filter(Boolean)[2]
  if (path === '/api/v1/platform/organizations' || path === '/api/v1/platform/organizations/{id}') return 'OrganizationSummary'
  if (path === '/api/v1/platform/audit-logs') return 'PlatformAuditLog'
  if (path.startsWith('/api/v1/platform/permissions') || path === '/api/v1/permissions') return 'Permission'
  return ({ organization: 'Organization', sites: 'Site', buildings: 'Building', meters: 'Meter', assets: 'Asset', 'reading-imports': 'ImportJob', 'data-sources': 'DataSource', 'quarantined-readings': 'QuarantinedReading', baselines: 'Baseline', targets: 'EnergyTarget', 'alert-rules': 'AlertRule', alerts: 'Alert', audits: 'EnergyAudit', 'emission-factors': 'EmissionFactor', reports: 'ReportJob', 'audit-logs': 'AuditLog', users: 'User', roles: 'Role', tariffs: 'Tariff', 'tariff-assignments': 'TariffAssignment', 'integration-sources': 'IntegrationSource', webhooks: 'Webhook', invitations: 'Invitation', 'site-assignments': 'SiteAssignment', 'notification-deliveries': 'NotificationDelivery', 'forecast-drivers': 'ForecastDriver', 'meter-maintenance': 'MeterMaintenance', analytics: 'ForecastRun', permissions: 'Permission' })[root]
}
const entityFieldSchemas = {
  Site: { id: uuid, organizationId: uuid, code: string(), name: string(), type: string(), address: string(), timezone: string(), status: string(), latitude: { type: ['number', 'null'] }, longitude: { type: ['number', 'null'] }, emissionRegion: { type: ['string', 'null'] }, createdAt: isoDateTime },
  Building: { id: uuid, organizationId: uuid, siteId: uuid, code: string(), name: string(), status: string(), createdAt: isoDateTime },
  Meter: { id: uuid, organizationId: uuid, siteId: uuid, assetId: { type: ['string', 'null'], format: 'uuid' }, code: string(), serialNumber: { type: ['string', 'null'] }, meterType: string(), metric: string(), unit: string(), sourceType: string(), intervalMinutes: { type: 'integer' }, multiplier: decimal, rolloverValue: { anyOf: [decimal, { type: 'null' }] }, status: string(), createdAt: isoDateTime },
  Asset: { id: uuid, organizationId: uuid, siteId: uuid, buildingId: { type: ['string', 'null'], format: 'uuid' }, code: string(), name: string(), type: string(), status: string(), createdAt: isoDateTime },
  ImportJob: { id: uuid, organizationId: uuid, fileName: string(), status: string(), mode: string(), accepted: { type: 'integer' }, rejected: { type: 'integer' }, createdAt: isoDateTime, completedAt: { anyOf: [isoDateTime, { type: 'null' }] } },
  DataSource: { id: uuid, organizationId: uuid, name: string(), type: string({ enum: ['MANUAL', 'CSV', 'API', 'SIMULATOR', 'MQTT'] }), description: { type: ['string', 'null'] }, status: string(), createdAt: isoDateTime, editable: { type: 'boolean' } },
  QuarantinedReading: { id: uuid, organizationId: uuid, importJobId: uuid, meterId: uuid, status: string(), reason: string(), createdAt: isoDateTime },
  Baseline: { id: uuid, organizationId: uuid, siteId: uuid, metric: string(), startDate: localDate, endDate: localDate, value: decimal, status: string(), version: { type: 'integer' }, createdAt: isoDateTime },
  EnergyTarget: { id: uuid, organizationId: uuid, siteId: uuid, metric: string(), startDate: localDate, endDate: localDate, targetValue: decimal, unit: string(), createdAt: isoDateTime },
  AlertRule: { id: uuid, organizationId: uuid, name: string(), scopeType: string(), scopeId: uuid, metric: string(), operator: string(), threshold: decimal, severity: string(), channels: { type: 'array', items: string() }, active: { type: 'boolean' }, createdAt: isoDateTime },
  Alert: { id: uuid, organizationId: uuid, ruleId: uuid, meterId: uuid, status: string(), severity: string(), message: string(), triggeredAt: isoDateTime, resolvedAt: { anyOf: [isoDateTime, { type: 'null' }] } },
  EnergyAudit: { id: uuid, organizationId: uuid, siteId: uuid, title: string(), status: string(), assignedAuditorId: uuid, scheduledAt: { anyOf: [isoDateTime, { type: 'null' }] }, createdAt: isoDateTime },
  EmissionFactor: { id: uuid, organizationId: uuid, region: string(), factor: decimal, unit: string(), publicationSource: string(), applicableYear: { type: 'integer' }, effectiveFrom: localDate },
  ReportJob: { id: uuid, organizationId: uuid, type: string({ enum: ['ENERGY', 'COST', 'QUALITY', 'ALERTS', 'AUDIT', 'EMISSIONS'] }), requestedBy: uuid, status: string(), format: string(), periodStart: isoDateTime, periodEnd: isoDateTime, expiresAt: { anyOf: [isoDateTime, { type: 'null' }] }, createdAt: isoDateTime },
  AuditLog: { id: uuid, organizationId: uuid, userId: { type: ['string', 'null'], format: 'uuid' }, action: string(), entity: string(), entityId: { type: ['string', 'null'] }, details: { type: ['object', 'null'], additionalProperties: true }, createdAt: isoDateTime },
  User: { id: uuid, email: string({ format: 'email' }), fullName: string(), active: { type: 'boolean' }, createdAt: isoDateTime },
  Role: { id: uuid, organizationId: uuid, code: string(), name: string(), description: { type: ['string', 'null'] }, scope: string(), active: { type: 'boolean' }, createdAt: isoDateTime },
  Tariff: { id: uuid, organizationId: uuid, name: string(), tariffType: string(), effectiveFrom: localDate, effectiveTo: { anyOf: [localDate, { type: 'null' }] }, unitRate: decimal, createdAt: isoDateTime },
  IntegrationSource: { id: uuid, organizationId: uuid, name: string(), status: string(), rateLimitPerMinute: { type: 'integer' }, createdAt: isoDateTime },
  Webhook: { id: uuid, organizationId: uuid, name: string(), status: string(), url: string({ format: 'uri' }), events: { type: 'array', items: string() }, createdAt: isoDateTime },
  Invitation: { id: uuid, organizationId: uuid, email: string({ format: 'email' }), fullName: string(), expiresAt: isoDateTime, acceptedAt: { anyOf: [isoDateTime, { type: 'null' }] }, createdAt: isoDateTime },
  SiteAssignment: { id: uuid, organizationId: uuid, userId: uuid, siteId: uuid, createdAt: isoDateTime },
  NotificationDelivery: { id: uuid, organizationId: uuid, alertId: uuid, userId: uuid, channel: string(), status: string(), attemptCount: { type: 'integer' }, createdAt: isoDateTime, sentAt: { anyOf: [isoDateTime, { type: 'null' }] } },
  ForecastDriver: { id: uuid, organizationId: uuid, siteId: uuid, date: isoDateTime, weatherIndex: { anyOf: [decimal, { type: 'null' }], description: 'Daily mean air temperature in degrees Celsius from Open-Meteo.' }, productionUnits: { anyOf: [decimal, { type: 'null' }] }, source: string(), sourceReference: { anyOf: [string(), { type: 'null' }] }, updatedAt: isoDateTime },
  MeterMaintenance: { id: uuid, organizationId: uuid, meterId: uuid, category: string(), title: string(), status: string(), scheduledAt: { anyOf: [isoDateTime, { type: 'null' }] }, completedAt: { anyOf: [isoDateTime, { type: 'null' }] }, createdAt: isoDateTime },
  MeterReading: { id: uuid, organizationId: uuid, meterId: uuid, timestamp: isoDateTime, value: decimal, unit: string(), quality: string(), externalReadingId: { type: ['string', 'null'] }, createdAt: isoDateTime },
  MeterConfigVersion: { id: uuid, organizationId: uuid, meterId: uuid, meterType: string(), metric: string(), unit: string(), sourceType: string(), intervalMinutes: { type: 'integer' }, multiplier: decimal, effectiveFrom: isoDateTime, effectiveTo: { anyOf: [isoDateTime, { type: 'null' }] }, reason: string(), createdAt: isoDateTime },
  WebhookDelivery: { id: uuid, webhookId: uuid, event: string(), status: string(), attemptCount: { type: 'integer' }, responseCode: { type: ['integer', 'null'] }, nextAttemptAt: { anyOf: [isoDateTime, { type: 'null' }] }, createdAt: isoDateTime },
  Permission: { id: uuid, code: string(), module: string(), description: string(), createdAt: isoDateTime },
  Organization: { id: uuid, code: string(), name: string(), auditApprovalSoD: { type: 'boolean' }, createdAt: isoDateTime },
  TariffAssignment: { id: uuid, meterId: uuid, tariffId: uuid, effectiveFrom: localDate, effectiveTo: { anyOf: [localDate, { type: 'null' }] }, name: string(), unitRate: decimal },
}
const paths = {}
let contractedBodies = 0
for (const [, method, expressPath] of routes) {
  const sourcePath = expressPath.startsWith('/api/v1/') ? expressPath.slice('/api/v1'.length) : expressPath
  const path = `/api/v1${sourcePath.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`
  const operationId = `${method}${expressPath.split('/').filter(Boolean).map(part => part.startsWith(':') ? `By${part.slice(1)}` : part.replace(/[^A-Za-z0-9]/g, '')).map(part => part[0].toUpperCase() + part.slice(1)).join('')}`
  const tag = expressPath.split('/').filter(Boolean)[0]?.replace(/:.*/, '') || 'API'
  const parameters = [...sourcePath.matchAll(/:([A-Za-z0-9_]+)/g)].map(([, name]) => ({ name, in: 'path', required: true, schema: { type: 'string', ...(name.toLowerCase().includes('id') ? { format: 'uuid' } : {}) } }))
  const operation = {
    operationId,
    tags: [tag[0].toUpperCase() + tag.slice(1)],
    summary: `${method.toUpperCase()} ${expressPath}`,
    description: 'Request and response use the common API envelope. See docs/api.md for implemented fields and domain rules. Mutation requests authenticated by a session also require X-CSRF-Token.',
    ...(parameters.length ? { parameters } : {}),
    ...(!publicPaths.has(expressPath) && ['post', 'patch', 'put', 'delete'].includes(method) ? { parameters: [...parameters, { name: 'X-CSRF-Token', in: 'header', required: true, schema: { type: 'string' } }] } : {}),
    ...(['post', 'patch', 'put'].includes(method) && !noBodyPaths.has(expressPath) && !sourcePath.endsWith('/signed-download') ? { requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } } : {}),
    ...(publicPaths.has(expressPath) ? {} : { security: [{ SessionCookie: [] }] }),
    responses: {
      '200': { description: 'Operation succeeded', content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessEnvelope' } } } },
      '201': { description: 'Resource created', content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessEnvelope' } } } },
      '202': { description: 'Operation accepted for asynchronous processing', content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessEnvelope' } } } },
      '204': { description: 'Operation succeeded without a response body' },
      '400': { description: 'Malformed request' },
      '401': { description: 'Authentication required' },
      '403': { description: 'Role, scope, or CSRF policy denied the operation' },
      '404': { description: 'Resource not found in the current tenant/scope' },
      '409': { description: 'State or idempotency conflict' },
      '422': { description: 'Validation failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } },
      '500': { description: 'Unexpected server error' },
      '503': { description: 'Service not ready' },
    },
  }
  if (expressPath === '/ingestion/device-readings') operation.security = [{ DeviceBearer: [] }]
  if (sourcePath === '/reports/:id/signed-download') {
    operation.parameters.push({ name: 'expires', in: 'query', required: true, schema: { type: 'integer' } }, { name: 'signature', in: 'query', required: true, schema: { type: 'string' } })
  }
  if (expressPath === '/audits/:id/evidence') {
    operation.requestBody = { required: true, content: { 'application/json': { schema: { type: 'object', required: ['fileName', 'contentType', 'contentBase64'], properties: { fileName: { type: 'string', maxLength: 180 }, contentType: { type: 'string', enum: ['application/pdf', 'image/jpeg', 'image/png'] }, contentBase64: { type: 'string', format: 'byte', maxLength: 7000000 } }, additionalProperties: false } } } }
  }
  if (expressPath === '/meter-maintenance/:id/evidence') {
    operation.requestBody = { required: true, content: { 'application/json': { schema: { type: 'object', required: ['fileName', 'contentType', 'contentBase64'], properties: { fileName: { type: 'string', maxLength: 180 }, contentType: { type: 'string', enum: ['application/pdf', 'image/jpeg', 'image/png'] }, contentBase64: { type: 'string', format: 'byte', maxLength: 7000000 } }, additionalProperties: false } } } }
  }
  if (sourcePath === '/reading-imports/preview') {
    operation.requestBody = { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['file', 'sourceId'], properties: { file: { type: 'string', format: 'binary' }, sourceId: uuid }, additionalProperties: false } } } }
    operation['x-contract-status'] = 'documented-multipart-preview-request'
    contractedBodies++
  }
  if (expressPath === '/reports') {
    operation.parameters ??= []
    operation.parameters.push({ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', minLength: 8, maxLength: 200 } })
  }
  if (sourcePath === '/reports/:id/download' || sourcePath === '/reports/:id/signed-download' || sourcePath === '/audits/:id/evidence/:evidenceId' || sourcePath === '/meter-maintenance/:id/evidence/:evidenceId') {
    operation.responses['200'] = { description: 'Private file contents', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }
    operation['x-response-contract-status'] = 'documented-binary-file-response'
  }
  const requestKey = `${method.toUpperCase()} ${path}`
  let responseContract = responseContracts[requestKey] || (resourceForPath(path) ? { $ref: `#/components/schemas/${resourceForPath(path)}` } : { $ref: '#/components/schemas/OperationResult' })
  if (responseContract && operation.responses['200'].content?.['application/json']) {
    operation.responses['200'].content['application/json'].schema = { allOf: [{ $ref: '#/components/schemas/SuccessEnvelope' }, { type: 'object', properties: { data: responseContract } }] }
    operation.responses['201'].content['application/json'].schema = { allOf: [{ $ref: '#/components/schemas/SuccessEnvelope' }, { type: 'object', properties: { data: responseContract } }] }
    operation['x-response-contract-status'] = 'documented-operation-response'
  }
  if (method === 'get' && sourcePath === '/meters/:id/readings') {
    operation.responses['200'].content['application/json'].schema = { allOf: [{ $ref: '#/components/schemas/SuccessEnvelope' }, { type: 'object', properties: { data: { $ref: '#/components/schemas/ReadingPage' } } }] }
    operation['x-response-contract-status'] = 'documented-reading-cursor-page'
  } else if (method === 'get' && pagedGetPaths.has(path)) {
    const itemSchema = resourceForPath(path) ? { $ref: `#/components/schemas/${resourceForPath(path)}` } : { $ref: '#/components/schemas/JSONValue' }
    operation.responses['200'].content['application/json'].schema = {
      allOf: [
        { $ref: '#/components/schemas/SuccessEnvelope' },
        { type: 'object', properties: { data: { oneOf: [{ type: 'object', required: ['items', 'pagination'], properties: { items: { type: 'array', items: itemSchema }, pagination: { $ref: '#/components/schemas/PageMeta' } } }, { type: 'array', items: itemSchema }] } } },
      ],
    }
    operation['x-response-contract-status'] = 'documented-paginated-entity-response'
  } else if (operation.responses['200'].content?.['application/json']) {
    if (method === 'get' && resourceForPath(path) && !responseContracts[requestKey]) responseContract = { type: 'array', items: { $ref: `#/components/schemas/${resourceForPath(path)}` } }
    if (!operation.responses['200'].content?.['application/json']) operation.responses['200'].content = { 'application/json': {} }
    operation.responses['200'].content['application/json'].schema = { allOf: [{ $ref: '#/components/schemas/SuccessEnvelope' }, { type: 'object', properties: { data: responseContract } }] }
    operation.responses['201'].content['application/json'].schema = { allOf: [{ $ref: '#/components/schemas/SuccessEnvelope' }, { type: 'object', properties: { data: responseContract } }] }
    operation['x-response-contract-status'] = 'documented-endpoint-response'
  }
  if (sourcePath === '/health/metrics') {
    operation.responses['200'] = { description: 'Prometheus text metrics', content: { 'text/plain; version=0.0.4': { schema: { type: 'string' } } } }
    delete operation.responses['201']; delete operation.responses['202']
    operation['x-response-contract-status'] = 'documented-metrics-text-response'
  }
  if (sourcePath === '/events') {
    operation.responses['200'] = { description: 'Server-sent event stream', content: { 'text/event-stream': { schema: { type: 'string', description: 'SSE events named ready and updates.' } } } }
    delete operation.responses['201']; delete operation.responses['202']
    operation['x-response-contract-status'] = 'documented-event-stream-response'
  }
  if (sourcePath === '/auth/forgot-password') {
    delete operation.responses['200']; delete operation.responses['201']
    operation.responses['202'] = { description: 'Password reset request accepted', content: { 'application/json': { schema: { allOf: [{ $ref: '#/components/schemas/SuccessEnvelope' }, { type: 'object', properties: { data: { $ref: '#/components/schemas/MessageResponse' } } }] } } } }
    operation['x-response-contract-status'] = 'documented-accepted-response'
  }
  if (['/auth/reset-password', '/auth/change-password', '/auth/logout'].includes(sourcePath)) {
    delete operation.responses['200']; delete operation.responses['201']; delete operation.responses['202']
    operation.responses['204'] = { description: 'Operation succeeded without a response body' }
    operation['x-response-contract-status'] = 'documented-empty-success-response'
  }
  if (method === 'get' && !['/health/metrics', '/events'].includes(sourcePath)) { delete operation.responses['201']; delete operation.responses['202'] }
  if (operation.requestBody) {
    if (bodyContracts[requestKey]) {
      operation.requestBody.content['application/json'].schema = bodyContracts[requestKey]
      operation['x-contract-status'] = 'documented-request-schema'
      contractedBodies++
    } else if (sourcePath !== '/reading-imports/preview') operation['x-contract-status'] = 'placeholder-request-schema'
  }
  const queryKey = `${method.toUpperCase()} ${path}`
  if (queryContracts[queryKey]) {
    operation.parameters ??= []
    operation.parameters.push(...queryContracts[queryKey].map(parameter => ({ name: parameter.name, in: 'query', required: parameter.required ?? false, schema: parameter.schema })))
    operation['x-contract-status'] = operation['x-contract-status'] || 'documented-query-schema'
  }
  if (method === 'get' && pagedGetPaths.has(path)) {
    operation.parameters ??= []
    const existing = new Set(operation.parameters.map(parameter => parameter.name))
    for (const parameter of [
      { name: 'page', schema: { type: 'integer', minimum: 1, default: 1 } },
      { name: 'pageSize', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } },
      { name: 'sort', schema: string({ maxLength: 40 }) },
      { name: 'direction', schema: string({ enum: ['asc', 'desc'], default: 'asc' }) },
      { name: 'sortBy', schema: string({ maxLength: 40 }) },
      { name: 'sortOrder', schema: string({ enum: ['asc', 'desc'], default: 'asc' }) },
      { name: 'search', schema: string({ maxLength: 200 }) },
    ]) if (!existing.has(parameter.name)) operation.parameters.push({ ...parameter, in: 'query', required: false })
  }
  paths[path] ??= {}
  paths[path][method] = operation
}

const document = {
  openapi: '3.1.0',
  info: { title: 'EnergiTrack API', version: '1.1.0', description: 'OpenAPI route inventory generated from Express declarations. Request schemas are endpoint-specific where documented. Pagination and meter reading cursor response envelopes are typed; most domain response payloads remain JSONValue until their endpoint-specific contracts are added. See docs/api.md for current business rules.' },
  servers: [{ url: 'http://127.0.0.1:3000', description: 'Local development' }],
  paths,
  components: {
    securitySchemes: {
      SessionCookie: { type: 'apiKey', in: 'cookie', name: 'connect.sid', description: 'Authenticated session cookie. Mutations require X-CSRF-Token.' },
      DeviceBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'Integration source token' },
    },
    schemas: {
      JSONValue: { anyOf: [{ type: 'null' }, { type: 'boolean' }, { type: 'number' }, { type: 'string' }, { type: 'array', items: { $ref: '#/components/schemas/JSONValue' } }, { type: 'object', additionalProperties: { $ref: '#/components/schemas/JSONValue' } }] },
      ...Object.fromEntries(Object.entries(entityFieldSchemas).map(([name, properties]) => [name, { type: 'object', required: ['id'], properties, additionalProperties: true }])),
      OperationResult: { type: 'object', properties: { id: uuid, status: string(), message: string(), accepted: { type: 'integer' }, rejected: { type: 'integer' }, count: { type: 'integer' }, createdAt: isoDateTime, updatedAt: isoDateTime }, additionalProperties: true },
      MessageResponse: { type: 'object', required: ['message'], properties: { message: string(), developmentToken: string({ pattern: '^pr_[a-f0-9]{64}$' }) }, additionalProperties: false },
      AuthSession: { type: 'object', required: ['csrfToken'], properties: { csrfToken: string({ minLength: 32 }) }, additionalProperties: false },
      AuthenticatedUser: { type: 'object', required: ['id', 'email', 'fullName', 'role', 'organization', 'permissions'], properties: { id: uuid, email: string({ format: 'email' }), fullName: string(), role: string(), roleId: uuid, organization: { $ref: '#/components/schemas/Organization' }, memberships: { type: 'array', items: { type: 'object', properties: { organizationId: uuid, role: string(), scope: string() }, additionalProperties: true } }, siteIds: { type: 'array', items: uuid }, permissions: { type: 'array', items: string() }, csrfToken: string({ minLength: 32 }) }, additionalProperties: true },
      ProfileResponse: { type: 'object', required: ['id', 'email', 'fullName'], properties: { id: uuid, email: string({ format: 'email' }), fullName: string() }, additionalProperties: false },
      OrganizationSwitchResult: { type: 'object', required: ['organizationId', 'organization', 'csrfToken'], properties: { organizationId: uuid, organization: { $ref: '#/components/schemas/Organization' }, role: string(), csrfToken: string({ minLength: 32 }) } },
      InvitationAccepted: { type: 'object', required: ['email'], properties: { email: string({ format: 'email' }) } },
      DeviceIngestionResult: { type: 'object', required: ['accepted', 'duplicates', 'rejected', 'quarantineJobId'], properties: { accepted: { type: 'integer' }, duplicates: { type: 'integer' }, rejected: { type: 'integer' }, quarantineJobId: { type: ['string', 'null'], format: 'uuid' } } },
      ImportPreview: { type: 'object', required: ['id', 'status', 'fileName', 'sourceId', 'total', 'valid', 'rejected', 'errors', 'createdAt'], properties: { id: uuid, status: { const: 'PREVIEW' }, fileName: string(), sourceId: uuid, total: { type: 'integer' }, valid: { type: 'integer' }, rejected: { type: 'integer' }, errors: { type: 'array', items: { type: 'object', required: ['row', 'message'], properties: { row: { type: 'integer' }, message: string() }, additionalProperties: false } }, createdAt: isoDateTime }, additionalProperties: false },
      CorrectiveAction: { type: 'object', required: ['id', 'findingId', 'ownerId', 'dueDate', 'status'], properties: { id: uuid, findingId: uuid, ownerId: uuid, dueDate: localDate, status: string(), outcome: { type: ['string', 'null'] }, evidenceUrl: { type: ['string', 'null'], format: 'uri' }, completedAt: { anyOf: [isoDateTime, { type: 'null' }] }, createdAt: isoDateTime, updatedAt: isoDateTime }, additionalProperties: true },
      NotificationPreferences: { type: 'object', required: ['inAppEnabled', 'emailEnabled'], properties: { inAppEnabled: { type: 'boolean' }, emailEnabled: { type: 'boolean' }, updatedAt: { anyOf: [isoDateTime, { type: 'null' }] } } },
      ForecastDriverPage: { type: 'object', required: ['items', 'pagination'], properties: { items: { type: 'array', items: { $ref: '#/components/schemas/ForecastDriver' } }, pagination: { $ref: '#/components/schemas/PageMeta' } } },
      ForecastDriverSaveResult: { type: 'object', required: ['saved', 'rows'], properties: { saved: { type: 'integer', minimum: 0 }, rows: { type: 'array', items: { $ref: '#/components/schemas/ForecastDriver' } } } },
      WeatherSyncResult: { type: 'object', required: ['provider', 'variable', 'unit', 'siteId', 'imported', 'rows', 'attribution'], properties: { provider: { const: 'OPEN_METEO' }, variable: { const: 'temperature_2m_mean' }, unit: { const: '°C' }, siteId: uuid, imported: { type: 'integer' }, rows: { type: 'array', items: { $ref: '#/components/schemas/ForecastDriver' } }, attribution: string() } },
      PageMeta: { type: 'object', required: ['page', 'pageSize', 'total', 'pageCount', 'sortBy', 'sortOrder'], properties: { page: { type: 'integer', minimum: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 100 }, total: { type: 'integer', minimum: 0 }, pageCount: { type: 'integer', minimum: 0 }, sortBy: { type: 'string' }, sortOrder: { type: 'string', enum: ['asc', 'desc'] }, sort: { type: 'string', description: 'Legacy alias for sortBy.' }, direction: { type: 'string', enum: ['asc', 'desc'], description: 'Legacy alias for sortOrder.' }, search: { type: ['string', 'null'] } }, additionalProperties: false },
      PageEnvelope: { type: 'object', required: ['items', 'pagination'], properties: { items: { type: 'array', items: { $ref: '#/components/schemas/JSONValue' } }, pagination: { $ref: '#/components/schemas/PageMeta' } }, additionalProperties: false },
      ReadingPage: { type: 'object', required: ['items', 'hasMore', 'nextCursor'], properties: { items: { type: 'array', items: { $ref: '#/components/schemas/MeterReading' } }, hasMore: { type: 'boolean' }, nextCursor: { type: ['string', 'null'], format: 'uuid' } }, additionalProperties: false },
      HealthStatus: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['LIVE', 'READY'] } }, additionalProperties: false },
      MonitoringPoint: { type: 'object', required: ['date', 'kwh', 'unit', 'quality'], properties: { date: string(), kwh: { type: 'number' }, unit: string({ enum: ['kWh', 'kW'] }), quality: string(), readingCount: { type: 'integer', minimum: 0 }, expectedReadingCount: { type: 'integer', minimum: 0 }, completenessPercent: { type: ['number', 'null'], minimum: 0, maximum: 100 }, resetCount: { type: 'integer', minimum: 0 }, rolloverCount: { type: 'integer', minimum: 0 }, aggregateVersion: { type: 'integer', minimum: 1 }, source: string({ enum: ['PERSISTENT_ROLLUP'] }) }, additionalProperties: false },
      MonitoringSummary: { type: 'object', required: ['siteCount', 'meterCount', 'openAlerts', 'metric', 'siteRanking', 'periodStart', 'periodEnd', 'timezone'], properties: { siteCount: { type: 'integer' }, meterCount: { type: 'integer' }, openAlerts: { type: 'integer' }, metric: string({ enum: ['ENERGY_IMPORT', 'POWER_DEMAND'] }), energyKwh: { type: ['number', 'null'] }, peakDemandKw: { type: ['string', 'null'] }, estimatedCostIdr: { type: ['string', 'null'] }, completenessPercent: { type: ['number', 'null'] }, expectedReadings: { type: 'integer' }, observedReadings: { type: 'integer' }, siteRanking: { type: 'array', items: { type: 'object', properties: { siteId: uuid, siteName: string(), energyKwh: { type: 'number' } }, required: ['siteId', 'siteName', 'energyKwh'] } }, periodStart: isoDateTime, periodEnd: isoDateTime, timezone: string(), comparison: { anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] }, note: string() }, additionalProperties: false },
      ForecastResponse: { type: 'object', required: ['model', 'siteId', 'timezone', 'unit'], properties: { model: string({ enum: ['MOVING_AVERAGE', 'EXPONENTIAL_SMOOTHING', 'COMPARE', 'EXOGENOUS_LINEAR'] }), result: { type: 'object', additionalProperties: true }, movingAverage: { anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] }, exponentialSmoothing: { anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] }, comparison: { anyOf: [{ type: 'array', items: { type: 'object', additionalProperties: true } }, { type: 'null' }] }, siteId: uuid, meterId: { type: ['string', 'null'], format: 'uuid' }, timezone: string(), unit: string(), note: string(), trainingStart: localDate, trainingEnd: localDate }, additionalProperties: true },
      ForecastRun: { type: 'object', required: ['id', 'organizationId', 'siteId', 'model', 'result', 'createdAt'], properties: { id: uuid, organizationId: uuid, siteId: uuid, meterId: { type: ['string', 'null'], format: 'uuid' }, requestedBy: uuid, model: string(), parameters: { type: 'object', additionalProperties: true }, result: { type: 'object', additionalProperties: true }, createdAt: isoDateTime }, additionalProperties: true },
      SuccessEnvelope: { type: 'object', required: ['success', 'data'], properties: { success: { const: true }, data: { $ref: '#/components/schemas/JSONValue' } } },
      ErrorEnvelope: { type: 'object', required: ['success', 'error'], properties: { success: { const: false }, error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' }, fields: { type: 'object', additionalProperties: { type: 'string' } } } } } },
    },
  },
}
const operations = Object.entries(paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, operation]) => ({ path, method, operation })))
const operationIds = operations.map(({ operation }) => operation.operationId)
if (operations.length !== routes.length) throw new Error(`OpenAPI route mismatch: found ${routes.length} Express declarations but generated ${operations.length} operations.`)
if (new Set(operationIds).size !== operationIds.length) throw new Error('OpenAPI operationId values must be unique.')
for (const { path, method, operation } of operations) {
  const declaredParams = new Set(operation.parameters?.filter(parameter => parameter.in === 'path').map(parameter => parameter.name) ?? [])
  const requiredParams = [...path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => name)
  if (requiredParams.some(name => !declaredParams.has(name))) throw new Error(`Missing path parameter schema for ${method.toUpperCase()} ${path}`)
  if (operation['x-contract-status'] === 'placeholder-request-schema') throw new Error(`Missing request schema for ${method.toUpperCase()} ${path}`)
  const successStatus = ['200', '201', '202', '204'].find(status => operation.responses[status]), successResponse = successStatus ? operation.responses[successStatus] : undefined
  if (!successResponse || successStatus !== '204' && !successResponse.content?.['application/json']?.schema && !successResponse.content?.['application/octet-stream']?.schema && !Object.values(successResponse.content ?? {}).some(value => value.schema)) throw new Error(`Missing response schema for ${method.toUpperCase()} ${path}`)
}
const target = fileURLToPath(new URL('../docs/openapi.json', import.meta.url))
await writeFile(target, `${JSON.stringify(document, null, 2)}\n`)
console.log(`Wrote ${Object.keys(paths).length} paths and ${routes.length} operations (${contractedBodies} request schemas documented; ${routes.filter(([, method, path]) => ['post', 'patch', 'put'].includes(method) && !noBodyPaths.has(path) && !path.endsWith('/signed-download')).length - contractedBodies} placeholders) to ${target}`)
