/**
 * Pure GST calculations for invoices. All amounts are integer paise.
 * The rules here (CGST+SGST/UTGST within a state, IGST across states, place of supply for
 * B2C = buyer's state if known, else the seller's) should be reviewed by your CA before launch.
 */

export const STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka',
  '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
};

// Union territories without a legislature levy UTGST in place of SGST.
const UTGST_STATES = new Set(['04', '26', '31', '35', '38']);

export const isStateCode = (code: string) => code in STATES;

export function placeOfSupply(sellerState: string, buyer: { stateCode?: string | null; gstin?: string | null }): string {
  if (buyer.gstin) return buyer.gstin.slice(0, 2);
  if (buyer.stateCode && isStateCode(buyer.stateCode)) return buyer.stateCode;
  return sellerState;
}

export interface TaxBreakdown {
  docType: 'tax_invoice' | 'bill_of_supply';
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  ratePercent: number;
  secondTaxLabel: 'SGST' | 'UTGST';
}

export function computeTax(opts: {
  amountPaise: number;
  sellerRegistered: boolean;
  sellerState: string;
  placeOfSupply: string;
  ratePercent: number;
  pricesIncludeGst: boolean;
}): TaxBreakdown {
  const { amountPaise, ratePercent } = opts;
  if (!Number.isInteger(amountPaise) || amountPaise < 0) throw new Error('amountPaise must be a non-negative integer');
  const secondTaxLabel = UTGST_STATES.has(opts.sellerState) ? 'UTGST' : 'SGST';
  if (!opts.sellerRegistered || ratePercent === 0) {
    // An unregistered supplier cannot charge GST and issues a Bill of Supply.
    return { docType: 'bill_of_supply', taxablePaise: amountPaise, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: amountPaise, ratePercent: 0, secondTaxLabel };
  }
  const taxablePaise = opts.pricesIncludeGst ? Math.round((amountPaise * 100) / (100 + ratePercent)) : amountPaise;
  const taxPaise = opts.pricesIncludeGst ? amountPaise - taxablePaise : Math.round((amountPaise * ratePercent) / 100);
  const totalPaise = taxablePaise + taxPaise;
  if (opts.placeOfSupply === opts.sellerState) {
    const cgstPaise = Math.round(taxPaise / 2);
    return { docType: 'tax_invoice', taxablePaise, cgstPaise, sgstPaise: taxPaise - cgstPaise, igstPaise: 0, totalPaise, ratePercent, secondTaxLabel };
  }
  return { docType: 'tax_invoice', taxablePaise, cgstPaise: 0, sgstPaise: 0, igstPaise: taxPaise, totalPaise, ratePercent, secondTaxLabel };
}

/** Indian financial year (April to March) in IST, e.g. '2026-27'. */
export function financialYear(date: Date): string {
  const ist = new Date(date.getTime() + 5.5 * 3600_000);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Invoice number of at most 16 characters (CGST Rules), unique per financial year: INV2627-000042. */
export function invoiceNumber(prefix: string, fy: string, serial: number): string {
  const n = `${prefix}${fy.slice(2, 4)}${fy.slice(5, 7)}-${String(serial).padStart(6, '0')}`;
  if (n.length > 16) throw new Error(`invoice number ${n} exceeds 16 characters`);
  return n;
}
