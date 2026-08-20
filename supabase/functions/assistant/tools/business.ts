// The deterministic business tools (A4). Composition into the registry happens in index.ts,
// alongside get_business_summary and get_open_alerts, which live with the boundary (A3).
import type { AssistantTool } from "./registry.ts";
import { compareOrderReceiptInvoice } from "./compareOrderReceiptInvoice.ts";
import { explainInvoiceBlock } from "./explainInvoiceBlock.ts";
import { findEntity } from "./findEntity.ts";
import { getDashboardSnapshot } from "./getDashboardSnapshot.ts";
import { getInventoryRisk } from "./getInventoryRisk.ts";
import { getOpenCredits } from "./getOpenCredits.ts";
import { getOrdersAwaitingConfirmation } from "./getOrdersAwaitingConfirmation.ts";
import { getPaymentExposure } from "./getPaymentExposure.ts";
import { getPurchaseMetrics } from "./getPurchaseMetrics.ts";
import { getSupplierPerformance } from "./getSupplierPerformance.ts";
import { getUnmatchedBankTransactions } from "./getUnmatchedBankTransactions.ts";

export const deterministicBusinessTools: readonly AssistantTool[] = [
  explainInvoiceBlock,
  compareOrderReceiptInvoice,
  getDashboardSnapshot,
  getPurchaseMetrics,
  getSupplierPerformance,
  getInventoryRisk,
  getOpenCredits,
  getPaymentExposure,
  getOrdersAwaitingConfirmation,
  getUnmatchedBankTransactions,
  findEntity,
];
