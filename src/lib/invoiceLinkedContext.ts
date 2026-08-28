export interface InvoiceContextOrder {
  id: string;
  number: number;
  supplier_id: string;
  status: string;
  currency: string;
}

export interface InvoiceContextReceipt {
  id: string;
  number: number;
  order_id: string;
  received_at: string;
}

export interface InvoiceContextSupplier {
  id: string;
  name: string;
  default_currency: string;
  country_code: string | null;
}

export type InvoiceLinkedContext = {
  status: 'linked';
  order: InvoiceContextOrder;
  receipt: InvoiceContextReceipt | null;
  supplier: InvoiceContextSupplier;
  orderId: string | null;
  receiptId: string | null;
} | { status: 'none' | 'invalid' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null): value is string {
  return value !== null && UUID.test(value);
}

export function resolveInvoiceLinkedContext(
  requestedOrderId: string | null,
  requestedReceiptId: string | null,
  order: InvoiceContextOrder | null,
  receipt: InvoiceContextReceipt | null,
  supplier: InvoiceContextSupplier | null,
): InvoiceLinkedContext {
  if (!requestedOrderId && !requestedReceiptId) return { status: 'none' };
  if ((requestedOrderId && !isUuid(requestedOrderId)) || (requestedReceiptId && !isUuid(requestedReceiptId))) {
    return { status: 'invalid' };
  }
  if (!order || !supplier || order.supplier_id !== supplier.id) return { status: 'invalid' };
  if (requestedOrderId && order.id !== requestedOrderId) return { status: 'invalid' };
  if (requestedReceiptId && (!receipt || receipt.id !== requestedReceiptId || receipt.order_id !== order.id)) {
    return { status: 'invalid' };
  }
  return {
    status: 'linked',
    order,
    receipt,
    supplier,
    orderId: requestedOrderId,
    receiptId: requestedReceiptId,
  };
}
