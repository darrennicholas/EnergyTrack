import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { createHash } from 'node:crypto'
import { enqueueReadingRollups } from '../src/rollups.js'

if (process.env.NODE_ENV === 'production') throw new Error('Seed contoh hanya untuk lingkungan lokal.')
const db = new PrismaClient()
const id = (kind: string, index: number) => {
  const hash = createHash('sha256').update(`energytrack-example-${kind}-${index}`).digest('hex')
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`
}
try {
  const admin = await db.user.findUnique({ where: { email: 'admin@energitrack.local' }, select: { id: true, organizationId: true } })
  if (!admin?.organizationId) throw new Error('Akun admin dan organisasinya belum tersedia.')
  const organizationId = admin.organizationId
  await db.$transaction(async tx => {
    for (let i = 1; i <= 5; i++) {
      const siteId = id('site',i), buildingId = id('building',i), meterId = id('meter',i), assetId = id('asset',i), tariffId = id('tariff',i), ruleId = id('rule',i)
      await tx.site.upsert({ where: { id:siteId }, update: {}, create: { id:siteId, organizationId, code:`CONTOH-SITE-${i}`, name:`Site Contoh ${i}`, type:'FACTORY', address:`Kawasan Contoh Nomor ${i}, Indonesia`, timezone:'Asia/Jakarta' } })
      await tx.building.upsert({ where: { id:buildingId }, update: {}, create: { id:buildingId, organizationId, siteId, code:`CONTOH-BLD-${i}`, name:`Gedung Contoh ${i}` } })
      await tx.asset.upsert({ where: { id:assetId }, update: {}, create: { id:assetId, organizationId, siteId, buildingId, code:`CONTOH-AST-${i}`, name:`Aset Contoh ${i}`, type:'EQUIPMENT' } })
      await tx.meter.upsert({ where: { id:meterId }, update: {}, create: { id:meterId, organizationId, siteId, assetId, code:`CONTOH-MTR-${i}`, meterType:'INTERVAL', metric:'ENERGY_IMPORT', unit:'kWh', sourceType:'MANUAL', intervalMinutes:60, multiplier:1, status:'ONLINE' } })
      const from = new Date('2025-01-01T00:00:00Z'), to = new Date('2030-12-31T00:00:00Z')
      await tx.tariff.upsert({ where:{id:tariffId}, update:{}, create:{id:tariffId,organizationId,name:`Tarif Contoh ${i}`,unitRate:1400+i*10,effectiveFrom:from} })
      if (!await tx.tariffAssignment.findFirst({where:{organizationId,meterId,tariffId}})) await tx.tariffAssignment.create({data:{organizationId,meterId,tariffId,effectiveFrom:from}})
      await tx.alertRule.upsert({where:{id:ruleId},update:{},create:{id:ruleId,organizationId,name:`Aturan Contoh ${i}`,metric:'ENERGY_IMPORT',threshold:1000,severity:'MEDIUM',scopeType:'METER',scopeId:meterId}})
      await tx.energyAudit.upsert({where:{id:id('audit',i)},update:{},create:{id:id('audit',i),organizationId,siteId,title:`Audit Contoh ${i}`,createdBy:admin.id}})
      await tx.baseline.upsert({where:{id:id('baseline',i)},update:{},create:{id:id('baseline',i),organizationId,siteId,groupId:id('baseline-group',i),metric:'ENERGY_IMPORT',startDate:from,endDate:to,value:10000+i*100}})
      await tx.energyTarget.upsert({where:{id:id('target',i)},update:{},create:{id:id('target',i),organizationId,siteId,metric:'ENERGY_IMPORT',targetValue:9000+i*100,unit:'kWh',startDate:from,endDate:to}})
      await tx.integrationSource.upsert({where:{id:id('source',i)},update:{},create:{id:id('source',i),organizationId,name:`Sumber Contoh ${i}`,description:'Data contoh lokal',type:'CSV'}})
      await tx.emissionFactor.upsert({where:{id:id('factor',i)},update:{},create:{id:id('factor',i),organizationId,region:`Contoh ${i}`,factor:0.8,unit:'kgCO2e/kWh',publicationSource:'Data contoh lokal',sourceUrl:'https://example.com',applicableYear:2026,effectiveFrom:from,effectiveTo:to}})
      const importId = id('import', i), alertId = id('alert', i)
      await tx.importJob.upsert({where:{id:importId},update:{},create:{id:importId,organizationId,sourceId:id('source',i),fileName:`contoh-${i}.csv`,mode:'COMMIT',status:'COMPLETED',accepted:30,createdBy:admin.id,completedAt:new Date()}})
      const readings = Array.from({length:30}, (_, day) => ({id:id(`reading-${i}`,day),organizationId,meterId,importJobId:importId,externalId:`contoh-${i}-${day}`,timestamp:new Date(Date.now() - (30-day)*86400000),rawValue:100+i*8+day,value:100+i*8+day,unit:'kWh',quality:'VALID',sourceType:'CSV'}))
      const added = await tx.meterReading.createMany({data:readings,skipDuplicates:true})
      if (added.count) await enqueueReadingRollups(tx,organizationId,readings)
      await tx.alert.upsert({where:{id:alertId},update:{},create:{id:alertId,organizationId,ruleId,meterId,status:'OPEN',message:`Contoh alert ${i} — data ilustrasi`}})
      await tx.notificationDelivery.upsert({where:{id:id('notification',i)},update:{},create:{id:id('notification',i),organizationId,alertId,userId:admin.id,channel:'IN_APP',recipientEmail:'admin@energitrack.local',status:'SENT',sentAt:new Date()}})
      await tx.auditLog.upsert({where:{id:id('log',i)},update:{},create:{id:id('log',i),organizationId,userId:admin.id,action:'EXAMPLE_SEED',entity:'Site',entityId:siteId,details:{example:true}}})
    }
  }, { timeout: 30000 })
  console.log('Lima data contoh per katalog utama tersedia; data existing tidak dihapus.')
} finally { await db.$disconnect() }
