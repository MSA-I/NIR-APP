// The deterministic business tools (A4). Composition into the registry happens in index.ts,
// alongside get_business_summary and get_open_alerts, which live with the boundary (A3).
import type { AssistantTool } from "./registry.ts";
import { compareOrderReceiptInvoice } from "./compareOrderReceiptInvoice.ts";
import { draftSupplierReminder } from "./draftSupplierReminder.ts";
import { explainInvoiceBlock } from "./explainInvoiceBlock.ts";
import { findEntity } from "./findEntity.ts";
import { getDashboardSnapshot } from "./getDashboardSnapshot.ts";
import { getInventoryRisk } from "./getInventoryRisk.ts";
import { getMonthlyPriceRises } from "./getMonthlyPriceRises.ts";
import { getOpenCredits } from "./getOpenCredits.ts";
import { getOrdersAwaitingConfirmation } from "./getOrdersAwaitingConfirmation.ts";
import { getPaymentExposure } from "./getPaymentExposure.ts";
import { getProductHelp } from "./getProductHelp.ts";
import { getPurchaseComparison } from "./getPurchaseComparison.ts";
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
  // The two server read models #189 and #190 decided: the assistant explains what these return
  // and computes nothing of its own.
  getMonthlyPriceRises,
  getPurchaseComparison,
  findEntity,
  // Product help and the supplier draft close #192 and #191. Both are reads: the help tool
  // returns registry entries the current role may see, and the draft tool returns the FACTS a
  // reminder may quote -- the body is composed as a draft block and pinned by validate.ts.
  getProductHelp,
  draftSupplierReminder,
];
