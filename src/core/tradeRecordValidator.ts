import { TradeRecord } from './types';

export class TradeRecordValidator {
  static validate(record: Partial<TradeRecord> & { id: string }): void {
    if (record.entryPriceLamports === 0n) {
      throw new Error(`TradeRecord ${record.id}: entryPriceLamports === 0`);
    }
    if (record.priceBasisInvalid === true && record.exitTimestamp) {
      throw new Error(`TradeRecord ${record.id}: closed while priceBasisInvalid`);
    }
    if (
      record.exitTimestamp &&
      record.realizedMultiple === undefined &&
      record.priceBasisInvalid !== true
    ) {
      throw new Error(`TradeRecord ${record.id}: closed but realizedMultiple not computed`);
    }
    if (record.strategy === 'SNIPER') {
      if (!Array.isArray(record.edgesFired) || record.edgesFired.length !== 1 || record.edgesFired[0] !== 'AUTONOMOUS') {
        // SNIPER trades use 'AUTONOMOUS' edge label in the current EdgeName union until the union is extended.
        // This check is a placeholder — tighten once 'SNIPER' is added to EdgeName.
      }
    }
  }
}
