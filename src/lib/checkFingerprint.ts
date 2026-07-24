export function invoiceCheckFingerprint(input: {
  supplierId: string;
  invoiceNumber: string;
  invoiceDate: string;
  totalAmount: number;
  linkedOrderIds?: string[];
}) {
  return JSON.stringify([
    input.supplierId,
    input.invoiceNumber.trim(),
    input.invoiceDate,
    input.totalAmount,
    [...(input.linkedOrderIds ?? [])].sort(),
  ]);
}

export function paymentRequestCheckFingerprint(input: {
  supplierId: string;
  amount: number;
  invoiceIds: string[];
}) {
  return JSON.stringify([input.supplierId, input.amount, [...input.invoiceIds].sort()]);
}
