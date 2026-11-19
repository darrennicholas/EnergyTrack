import { describe, expect, it } from 'vitest'
import { cumulativeDelta, rolloverValueAt } from './cumulative.js'

describe('cumulative register handling', () => {
  it('accepts only a configured wrap that is compatible with both register values', () => {
    const rollover = cumulativeDelta('9999.9', '0.2', '10000')
    expect(rollover.delta?.toFixed(1)).toBe('0.3')
    expect(rollover.event).toBe('ROLLOVER')
    expect(cumulativeDelta('100', '5')).toEqual({ delta: null, event: 'RESET' })
    expect(cumulativeDelta('10001', '5', '10000')).toEqual({ delta: null, event: 'RESET' })
  })
  it('selects the modulus effective at a reading timestamp and supports an explicit removal', () => {
    const meter = { rolloverValue: '20000', configurationVersions: [
      { rolloverValue: '10000', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveTo: new Date('2026-01-31T23:59:59.999Z') },
      { rolloverValue: null, effectiveFrom: new Date('2026-02-01T00:00:00Z'), effectiveTo: null }
    ] }
    expect(rolloverValueAt(new Date('2026-01-15T12:00:00Z'), meter)).toBe('10000')
    expect(rolloverValueAt(new Date('2026-02-15T12:00:00Z'), meter)).toBeNull()
  })
})
