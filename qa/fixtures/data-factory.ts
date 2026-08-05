import { createHash } from 'node:crypto';

export interface SyntheticQaData {
  runId: string;
  tag: string;
  organization: {
    reference: string;
    name: string;
  };
  supplier: {
    reference: string;
    name: string;
    email: string;
  };
  products: Array<{
    id: string;
    name: string;
    unit: string;
    price: number;
  }>;
  purchaseOrder: {
    reference: string;
    quantities: number[];
  };
  receipt: {
    reference: string;
    receivedQuantities: number[];
  };
  invoice: {
    reference: string;
    number: string;
    total: number;
  };
  payment: {
    reference: string;
    amount: number;
  };
  bankTransaction: {
    reference: string;
    description: string;
    amount: number;
  };
}

const DEMO_PRODUCTS = [
  { id: 'bb000000-0000-4000-8000-000000000001', name: 'עגבניות', unit: 'ק״ג', price: 9.11 },
  { id: 'bb000000-0000-4000-8000-000000000002', name: 'מלפפונים', unit: 'ק״ג', price: 6.13 },
  { id: 'bb000000-0000-4000-8000-000000000003', name: 'בצל יבש', unit: 'ק״ג', price: 5.07 },
] as const;

export function assertSafeRunId(runId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{5,79}$/i.test(runId)) {
    throw new Error('runId must contain only 6-80 ASCII letters, digits, or hyphens.');
  }
  return runId;
}

function shortTag(runId: string): string {
  return createHash('sha256').update(runId).digest('hex').slice(0, 10).toUpperCase();
}

export function createSyntheticQaData(runId: string): SyntheticQaData {
  assertSafeRunId(runId);
  const tag = shortTag(runId);
  const quantities = [12, 8, 5];
  const total = DEMO_PRODUCTS.reduce((sum, product, index) => sum + product.price * quantities[index], 0);
  const roundedTotal = Number(total.toFixed(2));

  return {
    runId,
    tag,
    organization: {
      reference: `QA-ORG-${tag}`,
      name: `SupplyFlow QA ${tag}`,
    },
    supplier: {
      reference: `QA-SUP-${tag}`,
      name: `ספק בדיקות ${tag}`,
      email: `qa-supplier-${tag.toLowerCase()}@example.invalid`,
    },
    products: DEMO_PRODUCTS.map((product) => ({ ...product })),
    purchaseOrder: {
      reference: `QA-PO-${tag}`,
      quantities,
    },
    receipt: {
      reference: `QA-GR-${tag}`,
      receivedQuantities: [12, 7, 5],
    },
    invoice: {
      reference: `QA-INV-${tag}`,
      number: `QA-${tag}`,
      total: roundedTotal,
    },
    payment: {
      reference: `QA-PAY-${tag}`,
      amount: roundedTotal,
    },
    bankTransaction: {
      reference: `QA-BANK-${tag}`,
      description: `Synthetic SupplyFlow QA transfer ${tag}`,
      amount: roundedTotal,
    },
  };
}
