/**
 * Failure text, as dictionary keys.
 *
 * supabase-js returns `{ data, error }` and never throws, so a failed write reaches the user
 * either as nothing at all or as a raw Postgres string. This maps the messages the app can
 * actually produce onto sentences a business owner can act on, and keeps the original in the
 * console so a developer still sees what really happened.
 *
 * ponytail: a flat pattern list, not an error-code taxonomy. Postgres does not give
 * supabase-js a stable code on every path, and the strings below are the ones this schema
 * can raise.
 */

// Imported from the dependency-free half of the assistant contracts on purpose: this file is
// pulled in by most of the app, and `./assistant/contracts` carries Zod for its schemas.
import { ASSISTANT_ERROR_CODES } from './assistant/errorCodes';
// The Hebrew dictionary, for the transitional `toHebrewError` only. `toErrorKey` needs no language.
import { he } from './i18n/dictionaries/he';

/**
 * The payment-execution split, refused by name.
 *
 * `buildPaymentAllocations` (AccountantPaymentQueue) refuses these BEFORE the RPC is called, so
 * the accountant is stopped at the field rather than at the server. The screen shows the same
 * sentence inline next to the button it disables, and `toHebrewError` reads it too — one wording,
 * whether the refusal came from the browser's own arithmetic or arrived as a thrown message.
 *
 * Two of these names are the SERVER'S OWN — `credit_allocation_invoice_required` and
 * `payment_cash_amount_required` are raised by `execute_payment_request` too, so the client uses
 * the identical name and the accountant reads the identical sentence whichever side caught it.
 * The rest are client-only readings of conditions the server folds into its broader containment
 * refusals (`allocation_target_invalid`, `credit_allocation_supplier_mismatch`,
 * `allocation_invoice_coverage_mismatch`), mapped separately below.
 */
export const ALLOCATION_REFUSAL_MESSAGES: Record<string, string> = {
  credit_allocation_exceeds_remaining: 'credit_allocation_exceeds_remaining',
  credit_allocation_exceeds_invoice: 'credit_allocation_exceeds_invoice',
  // OPEN-DECISIONS #243/#244 as the owner settled them on 23.08.2026: an unlinked credit may be
  // offset against any invoice of the same supplier, and the link is recorded at the moment of
  // allocation. Which invoice it lands on is therefore a decision with a money consequence, and
  // the absence of a decision is a refusal — not a default.
  credit_allocation_invoice_required:
    'credit_allocation_invoice_required',
  // Client-only, and the server agrees by a broader name: a linked credit simply cannot be moved,
  // and naming a different invoice for it is answered there with `allocation_target_invalid`.
  credit_invoice_link_immutable:
    'credit_invoice_link_immutable',
  credit_invoice_not_in_request: 'credit_invoice_not_in_request',
  payment_cash_amount_required:
    'payment_cash_amount_required',
};

/**
 * The refusal a settings screen can resolve, worded for who is reading it (`#293`).
 *
 * `bank_match_tolerance_unconfigured` is the only currency refusal whose fix is a field. Sending
 * everyone to that field would be wrong: an office user cannot change organisation settings, and
 * a screen that tells them to would be handing them a door that is locked. So the destination is
 * chosen by capability, not by hope.
 */
export function toleranceRefusalKey(canChangeSettings: boolean): string {
  return canChangeSettings
    ? 'bank_match_tolerance_unconfigured_owner'
    : 'bank_match_tolerance_unconfigured_staff';
}

const PATTERNS: [RegExp, string][] = [
  /* THE CURRENCY REFUSALS (0227, 0228, 0231, 0232 — #290 to #293).
     Four distinct server refusals reached the user as one sentence: "הפעולה נכשלה. אם הבעיה
     חוזרת — פנה לתמיכה." Support is the wrong destination for all four, and for one of them the
     fix is a field the owner can fill in under a minute — but only if somebody says so.

     The tolerance line here is the role-blind fallback for paths that do not know who is reading;
     a screen that knows uses `toleranceRefusalMessage` above and names the right destination. */
  [/bank_match_tolerance_unconfigured/i, 'bank_match_tolerance_unconfigured'],
  [/bank_match_currency_mismatch/i,
    'bank_match_currency_mismatch'],
  [/payment_request_currency_mixed/i,
    'payment_request_currency_mixed'],
  [/invoice_currency_precision_invalid/i,
    'invoice_currency_precision_invalid'],
  // Assistant codes (contracts §8), generated from the canonical map so a failure reads
  // identically whether it surfaced from the Edge function or from a direct RPC — one wording,
  // not two. FIRST in the list on purpose: the generic /timeout|timed out/ pattern below would
  // otherwise swallow assistant_provider_timeout, and /not_authorized/ sits below for the same
  // reason notification_preference_not_authorized does.
  // The code IS the dictionary key, so this pairs each pattern with itself.
  ...ASSISTANT_ERROR_CODES.map((code): [RegExp, string] => [new RegExp(code, 'i'), code]),
  // Two different refusals that must never read the same. One says "you used what you have"; the
  // other says "nobody has told the system what you have", which is our problem, not the
  // customer's, and sending them to buy an upgrade for it would be wrong.
  [/plan_limit_reached/i,
    'plan_limit_reached'],
  [/plan_limit_unknown/i,
    'plan_limit_unknown'],
  [/plan_capability_required/i,
    'plan_capability_required'],
  [/plan_user_limit_reached/i,
    'plan_user_limit_reached'],
  [/plan_branch_limit_reached/i,
    'plan_branch_limit_reached'],
  [/plan_user_limit_unknown|plan_branch_limit_unknown/i,
    'plan_user_limit_unknown'],
  [/not_platform_capability/i,
    'not_platform_capability'],
  [/platform_filter_unknown/i,
    'platform_filter_unknown'],
  [/entitlement_override_exists/i,
    'entitlement_override_exists'],
  [/subscription_plan_inactive/i,
    'subscription_plan_inactive'],
  // The billing adapter's single refusal for every unproven-provider path -- checkout and
  // cancellation alike. Without it a refused cancellation fell through to FALLBACK, which for an
  // action the customer believes they just performed is close enough to silence. Our state, not
  // theirs, and it promises no date because none has been decided. Wording provisional (#203).
  [/not_configured/i,
    'not_configured'],
  [/internal_note_already_resolved/i,
    'internal_note_already_resolved'],
  [/internal_note_immutable|platform_lifecycle_event_immutable/i,
    'internal_note_immutable'],
  [/proposal_pending_decision/i,
    'proposal_pending_decision'],
  [/order_not_linkable|email_order_not_sendable/i,
    'order_not_linkable'],
  [/link_already_revoked/i, 'link_already_revoked'],
  [/proposal_already_decided/i, 'proposal_already_decided'],
  [/decision_reason_required/i, 'decision_reason_required'],
  [/decisions_incomplete|decisions_invalid/i, 'decisions_incomplete'],
  [/revision_already_created/i, 'revision_already_created'],
  [/revision_empty|proposal_not_accepted/i,
    'revision_empty'],
  [/email_channel_disabled/i,
    'email_channel_disabled'],
  [/email_destination_missing|communication_email_destination_missing/i,
    'email_destination_missing'],
  [/communication_whatsapp_destination_missing/i,
    'communication_whatsapp_destination_missing'],
  [/communication_email_invalid/i, 'communication_email_invalid'],
  [/communication_whatsapp_invalid/i, 'communication_whatsapp_invalid'],
  [/email_message_retry_limit/i,
    'email_message_retry_limit'],
  [/email_message_not_resettable/i, 'email_message_not_resettable'],
  [/accepted_document_scan_immutable|document_scan_superseded_by_recovery/i,
    'accepted_document_scan_immutable'],
  [/document_scan_recovery_unavailable|document_scan_processing_state_invalid/i,
    'document_scan_recovery_unavailable'],
  // 0252/#298. The refusal names what is missing and where it opens — never a price, never a
  // "upgrade now" (OPEN-DECISIONS #202 forbids a personal plan recommendation), and never the
  // impression that something broke. The subscription screen is where the rungs are compared.
  [/capability_not_in_plan/i,
    'capability_not_in_plan'],
  [/user_seats_exhausted/i,
    'user_seats_exhausted'],
  [/retired_identity_requires_platform_reactivation/i,
    'retired_identity_requires_platform_reactivation'],
  [/account_role_retired|role_not_invitable/i,
    'account_role_retired'],
  [/offboarding_already_requested/i,
    'offboarding_already_requested'],
  [/offboarding_cancellation_window_closed/i,
    'offboarding_cancellation_window_closed'],
  [/offboarding_export_not_ready|export_not_ready/i,
    'offboarding_export_not_ready'],
  [/offboarding_export_lease_lost|offboarding_export_not_building/i,
    'offboarding_export_lease_lost'],
  [/offboarding_request_unknown/i,
    'offboarding_request_unknown'],
  [/offboarding_reactivation_window_closed/i,
    'offboarding_reactivation_window_closed'],
  [/export_build_failed|export_storage_upload_failed|export_file_download_failed/i,
    'export_build_failed'],
  [/organization_read_only/i,
    'organization_read_only'],
  [/payment_request_not_executable/i,
    'payment_request_not_executable'],
  [/payment_execution_fields_required/i,
    'payment_execution_fields_required'],
  [/payment_execution_conflict|payment_request_idempotency_conflict|invoice_idempotency_conflict|receipt_idempotency_conflict|bank_payment_idempotency_conflict|credit_request_idempotency_conflict/i,
    'payment_execution_conflict'],
  // Ahead of the server's allocation family on purpose: `credit_allocation_exceeds_invoice` and
  // its siblings are specific readings of the same failure, and the generic sentences below would
  // otherwise answer a question the specific ones already answer better.
  ...Object.entries(ALLOCATION_REFUSAL_MESSAGES).map(([code, text]): [RegExp, string] => [
    new RegExp(code, 'i'),
    text,
  ]),
  [/allocation_exceeds_balance|payment_request_allocation_invalid/i,
    'allocation_exceeds_balance'],
  [/allocation_total_mismatch|bank_allocation_total_mismatch/i,
    'allocation_total_mismatch'],
  // 0173: the executor checks each invoice of the request separately — cash allocated to it plus
  // credit offset against it must equal exactly what the request allocated to that invoice. It
  // fires when the split drifted from the request between preview and execution, so the sentence
  // sends the accountant back to the split rather than to the total.
  [/allocation_invoice_coverage_mismatch/i,
    'allocation_invoice_coverage_mismatch'],
  // 0173: the credit and the invoice it was pointed at belong to different suppliers. Its own
  // sentence rather than an arm of allocation_target_invalid, because it is the one refusal here
  // that says the two records were never related — no refresh and no re-split will change that.
  [/credit_allocation_supplier_mismatch/i,
    'credit_allocation_supplier_mismatch'],
  // The server's containment refusal for a single allocation row: an invoice or a credit that is
  // not this org's, not this supplier's, not in this request, not in a state that can be
  // allocated, an amount above what is left of it — or a credit that already names an invoice
  // being pointed at a different one, which the server refuses here rather than by its own name.
  [/allocation_target_invalid|allocation_invalid/i,
    'allocation_target_invalid'],
  [/payment_request_checks_failed/i,
    'payment_request_checks_failed'],
  [/payment_request_checks_mismatch/i,
    'payment_request_checks_mismatch'],
  [/payment_request_credit_override_required/i,
    'payment_request_credit_override_required'],
  [/payment_request_credit_total_changed|payment_request_credit_supplier_mismatch/i,
    'payment_request_credit_total_changed'],
  [/payment_request_credit_override_replay_mismatch|payment_request_credit_override_invalid/i,
    'payment_request_credit_override_replay_mismatch'],
  [/payment_request_credit_override_not_required/i,
    'payment_request_credit_override_not_required'],
  [/payment_request_credit_scope_unresolved|payment_request_scope_unresolved|payment_request_scope_invalid/i,
    'payment_request_credit_scope_unresolved'],
  [/payment_request_transition_invalid/i,
    'payment_request_transition_invalid'],
  [/payment_request_unknown/i,
    'payment_request_unknown'],
  [/payment_request_supplier_invalid|payment_request_invalid/i,
    'payment_request_supplier_invalid'],
  [/bank_transaction_already_matched|payment_already_bank_matched/i,
    'bank_transaction_already_matched'],
  [/bank_transaction_not_matchable|bank_transaction_not_ignorable/i,
    'bank_transaction_not_matchable'],
  [/bank_transaction_unknown/i,
    'bank_transaction_unknown'],
  [/bank_payment_invalid|bank_supplier_invalid|bank_match_invalid/i,
    'bank_payment_invalid'],
  [/bank_row_replayed/i,
    'bank_row_replayed'],
  [/bank_import_invalid_rows|bank_import_invalid/i,
    'bank_import_invalid_rows'],
  // G1, finding 5: the old text said "רענן ובדוק את השורות", and a refresh cannot help with any of
  // the conditions this code actually covers. `save_goods_receipt` (0023:1505-1525) raises it when
  // the row count differs from the order's, when a row names an item that is not on the order, when
  // a quantity exceeds what remains, or when the status and the quantity disagree — the common
  // real-world cause being an item that arrived and was never ordered. Naming the constraint is the
  // only advice that leads anywhere, since a receipt cannot carry a line the order does not have.
  [/receipt_qty_exceeds_order/i,
    'receipt_qty_exceeds_order'],
  // Split apart in wave 8: the offline queue can hit either of these while a device was
  // disconnected, and the conflict screen asks a different question for each — "another draft
  // exists for this order" is not "this receipt is already closed".
  [/receipt_draft_conflict/i,
    'receipt_draft_conflict'],
  [/receipt_already_completed/i,
    'receipt_already_completed'],
  [/inventory_movement_id_conflict/i,
    'inventory_movement_id_conflict'],
  [/inventory_stocktake_required/i,
    'inventory_stocktake_required'],
  [/inventory_insufficient_stock/i,
    'inventory_insufficient_stock'],
  [/inventory_negative_override_forbidden/i,
    'inventory_negative_override_forbidden'],
  [/inventory_product_unknown/i,
    'inventory_product_unknown'],
  [/inventory_movement_invalid/i,
    'inventory_movement_invalid'],
  [/inventory_not_authorized/i,
    'inventory_not_authorized'],
  [/purchase_order_not_receivable/i,
    'purchase_order_not_receivable'],
  [/purchase_order_unknown|goods_receipt_invalid/i,
    'purchase_order_unknown'],
  [/invoice_amounts_invalid/i,
    'invoice_amounts_invalid'],
  [/invoice_order_invalid|invoice_receipt_invalid|invoice_supplier_invalid/i,
    'invoice_order_invalid'],
  [/invoice_review_transition_invalid/i,
    'invoice_review_transition_invalid'],
  [/invoice_has_financial_references/i,
    'invoice_has_financial_references'],
  [/invoice_not_found/i,
    'invoice_not_found'],
  // Two guards, two sentences (0146). They shared one line until the owner hit it: a supplier with
  // a forgotten draft order and no money owed was told he had an open balance.
  [/supplier_has_open_balance/i,
    'supplier_has_open_balance'],
  [/supplier_has_active_orders/i,
    'supplier_has_active_orders'],
  [/supplier_not_found|product_not_found/i,
    'supplier_not_found'],
  [/purchase_order_cancel_invalid/i,
    'purchase_order_cancel_invalid'],
  [/invoice_fields_required|invoice_review_fields_required/i,
    'invoice_fields_required'],
  [/credit_request_not_fully_allocated/i,
    'credit_request_not_fully_allocated'],
  [/credit_request_transition_invalid/i,
    'credit_request_transition_invalid'],
  [/credit_request_invoice_unknown|credit_request_unknown/i,
    'credit_request_invoice_unknown'],
  [/credit_request_invoice_not_approved/i,
    'credit_request_invoice_not_approved'],
  [/credit_request_amount_invalid|credit_request_fields_required|credit_request_transition_fields_required/i,
    'credit_request_amount_invalid'],
  [/price_import_target_invalid/i,
    'price_import_target_invalid'],
  [/price_import_invalid/i,
    'price_import_invalid'],
  [/price_submission_idempotency_conflict/i,
    'price_submission_idempotency_conflict'],
  [/price_submission_intake_busy/i,
    'price_submission_intake_busy'],
  [/price_submission_file_changed/i,
    'price_submission_file_changed'],
  [/price_submission_file_missing|price_submission_intake_required/i,
    'price_submission_file_missing'],
  [/price_submission_supplier_invalid/i,
    'price_submission_supplier_invalid'],
  [/price_submission_intake_invalid|price_submission_invalid/i,
    'price_submission_intake_invalid'],
  [/price_values_invalid/i,
    'price_values_invalid'],
  [/supplier_product_not_found/i,
    'supplier_product_not_found'],
  [/month_export_legacy_snapshot_missing/i,
    'month_export_legacy_snapshot_missing'],
  [/month_export_snapshot_conflict/i,
    'month_export_snapshot_conflict'],
  [/month_export_invoice_invalid|month_export_duplicate_invoice|month_export_invalid/i,
    'month_export_invoice_invalid'],
  [/Invalid month/i,
    'invalid'],
  // `queryResult.ts` throws this instead of ever letting a missing COUNT render as 0 — zero is a
  // claim about the business. The sentence says the list is unverified, not empty.
  [/count_unavailable/i,
    'count_unavailable'],
  // Migration 0068 / migration 0068. Ahead of the generic `not_authorized` line below on purpose:
  // PATTERNS is scanned in order, and `notification_preference_not_authorized` would otherwise be
  // answered by the generic sentence instead of by one that names the setting.
  [/notification_preference_not_authorized/i,
    'notification_preference_not_authorized'],
  [/notification_event_unknown/i,
    'notification_event_unknown'],
  [/notification_preference_invalid/i,
    'notification_preference_invalid'],
  [/financial_command_rpc_required|invoice_soft_delete_rpc_required|supplier_soft_delete_rpc_required|product_active_rpc_required|purchase_order_cancel_rpc_required/i,
    'financial_command_rpc_required'],
  [/fresh_authentication_required/i,
    'fresh_authentication_required'],
  // 0071: the server refuses to leave an active member with zero scope grants. Without this
  // sentence the browser would show a bare Postgres string for the one refusal whose whole
  // purpose is to prevent a silent ₪0 on a financial screen.
  [/scope_last_grant_required/i,
    'scope_last_grant_required'],
  [/invoice_create_not_authorized|invoice_review_not_authorized|credit_request_create_not_authorized|credit_request_transition_not_authorized|price_write_not_authorized|price_import_not_authorized|price_submission_not_authorized|price_submission_intake_service_only|month_export_not_authorized|not_authorized/i,
    'invoice_create_not_authorized'],
  [/draft_unknown/i,
    'draft_unknown'],
  [/draft_invalid_supplier_selection|draft_supplier_unavailable/i,
    'draft_invalid_supplier_selection'],
  [/draft_price_changed/i,
    'draft_price_changed'],
  [/document_already_filed/i,
    // "יעד עסקי" is the entity_type column talking. A bookkeeper files a document against an
    // invoice or a goods receipt, so that is what the message names.
    'document_already_filed'],
  [/document_processing_active/i,
    'document_processing_active'],
  [/document_target_unknown/i,
    'document_target_unknown'],
  // The archive screen's most likely real race: two clerks, one rescues the document, the
  // other's list is stale. Both refusals name exactly what happened, so the second person is
  // told the truth instead of getting the generic fallback.
  [/document_not_in_archive/i,
    'document_not_in_archive'],
  [/document_unknown/i,
    'document_unknown'],
  // 0077 section 4b. Reversal is a ONE-WAY DOOR, and its likeliest real failure is not an attack —
  // it is two clerks looking at one list, the second a few seconds behind. Both refusals say what
  // actually happened instead of the generic fallback, and `auto_action_unknown` deliberately does
  // not distinguish "another tenant's" from "does not exist": that distinction is the leak.
  [/auto_action_already_reverted|document_auto_action_immutable/i,
    'auto_action_already_reverted'],
  [/auto_action_unknown/i,
    'auto_action_unknown'],
  // 0076. The autonomy command refuses by name rather than by constraint, so each refusal can be
  // answered with the rule that was broken. `autonomy_policy_reason_required` is deliberately NOT
  // here: it contains `reason_required`, and the generic sentence below is already the right one.
  [/autonomy_policy_not_tightening/i,
    'autonomy_policy_not_tightening'],
  [/autonomy_policy_invalid/i,
    'autonomy_policy_invalid'],
  [/autonomy_policy_unknown/i,
    'autonomy_policy_unknown'],
  [/not_platform_admin/i,
    'not_platform_admin'],
  [/reason_required/i,
    'reason_required'],
  // Its own sentence rather than an arm of reason_required: telling someone who just wrote 1001
  // characters that they must enter a reason is a worse answer than the raw constraint name it
  // replaces. Ahead of nothing in particular — it collides with no other pattern.
  [/reason_too_long/i,
    'reason_too_long'],
  [/row-level security|permission denied|insufficient privilege/i,
    'level'],
  [/duplicate key value|already exists/i,
    'duplicate'],
  [/violates foreign key constraint/i,
    'violates'],
  [/null value in column .* violates not-null/i,
    'null'],
  [/violates check constraint/i,
    'violates_2'],
  [/JWT expired|Invalid Refresh Token|refresh_token_not_found/i,
    'expired'],
  [/Invalid login credentials/i,
    'invalid_2'],
  [/Email not confirmed/i,
    'email'],
  [/already registered/i,
    'already'],
  [/FunctionsHttpError|Edge Function returned a non-2xx status code/i,
    'functionshttperror'],
  [/Failed to fetch|NetworkError|ERR_NETWORK|fetch failed|FunctionsFetchError|Failed to send a request to the Edge Function|FunctionsRelayError/i,
    'failed'],
  [/timeout|timed out/i,
    'timeout'],
  [/payload too large|exceeded the maximum allowed size/i,
    'payload'],
  // The upload surface's own conditions. The first three are synthetic codes `tusUpload.ts` raises
  // for HTTP verdicts that carry no message of their own; the last three are the renewal RPC's real
  // error strings, which used to be matched by a duplicate table inside that file. One vocabulary,
  // one place — a second table is a second answer waiting to disagree with this one.
  [/tus_upload_forbidden/i, 'tus_upload_forbidden'],
  [/tus_upload_conflict/i, 'tus_upload_conflict'],
  [/tus_upload_too_large/i, 'tus_upload_too_large'],
  [/document_upload_reservation_registered/i, 'document_upload_reservation_registered'],
  [/document_upload_reservation_lifetime_exceeded/i, 'document_upload_reservation_lifetime_exceeded'],
  [/document_upload_reservation_unknown/i, 'document_upload_reservation_unknown'],
  // The registration half of the same surface. `uploadDocument` stores the file first and
  // registers it second, so every one of these means THE FILE IS SAFE and only the row is
  // missing — which is why each sentence says so, and why none of them says "upload it again".
  [/document_registration_malformed_response/i, 'document_registration_malformed_response'],
  [/document_registration_unavailable/i, 'document_registration_unavailable'],
  [/document_registration_misconfigured/i, 'document_registration_misconfigured'],
  [/document_registration_not_authorized/i, 'document_registration_not_authorized'],
  [/document_registration_key_taken/i, 'document_registration_key_taken'],
  [/document_registration_invalid/i, 'document_registration_invalid'],
  [/document_registration_transient/i, 'document_registration_transient'],
  [/document_registration_failed/i, 'document_registration_failed'],
  [/document_enqueue_transient/i, 'document_enqueue_transient'],
  [/document_enqueue_failed/i, 'document_enqueue_failed'],
  [/document_upload_cancelled/i, 'document_upload_cancelled'],
  [/document_upload_too_large/i, 'document_upload_too_large'],
  [/document_upload_type_unsupported/i, 'document_upload_type_unsupported'],
  // Two screens used to keep their own status-to-sentence tables. The conditions live here now,
  // where a reader can see the whole vocabulary at once instead of hunting it per page.
  [/price_list_confirm_session_expired/i, 'price_list_confirm_session_expired'],
  [/price_list_confirm_forbidden/i, 'price_list_confirm_forbidden'],
  [/price_list_confirm_conflict/i, 'price_list_confirm_conflict'],
  [/price_list_confirm_unavailable/i, 'price_list_confirm_unavailable'],
  [/monthly_report_snapshot_unattributed_bank_transactions/i, 'monthly_report_snapshot_unattributed_bank'],
  [/monthly_report_snapshot_unattributed_(invoices|payments|credits|exceptions)/i, 'monthly_report_snapshot_unattributed'],
  [/monthly_report_snapshot_legal_entity_invalid|unit_out_of_scope/i, 'monthly_report_snapshot_legal_entity_invalid'],
  [/monthly_report_snapshot_source_unavailable/i, 'monthly_report_snapshot_source_unavailable'],
  // The offline queue's own outcomes. It persists what it stored to IndexedDB and shows it on
  // a later visit, so what it stores has to be a condition — a sentence written now would be shown
  // days later in whatever language happened to be active at the moment of the failure.
  //
  // The rest of this block used to be Hebrew sentences thrown from `offlineDb`/`offlineQueue`, and
  // they matched nothing here: `errorText` collapsed each of them into the generic fallback, so the
  // one screen built to say WHICH receipt failed and WHY said neither. Ordered longest-first, since
  // `offline_storage_unavailable` would otherwise be shadowed by nothing but its own prefix.
  [/offline_finalization_incomplete/i, 'offline_finalization_incomplete'],
  [/offline_transport_failure/i, 'offline_transport_failure'],
  [/offline_queued_no_network/i, 'offline_queued_no_network'],
  [/offline_queued_session_expired/i, 'offline_queued_session_expired'],
  [/offline_queued_syncing_elsewhere/i, 'offline_queued_syncing_elsewhere'],
  [/offline_queued_server_version_stale/i, 'offline_queued_server_version_stale'],
  [/offline_queued_changed_elsewhere/i, 'offline_queued_changed_elsewhere'],
  [/offline_local_action_unidentified/i, 'offline_local_action_unidentified'],
  [/offline_recovery_newer_draft_exists/i, 'offline_recovery_newer_draft_exists'],
  [/offline_recovery_action_exists/i, 'offline_recovery_action_exists'],
  [/offline_receipt_not_stored/i, 'offline_receipt_not_stored'],
  [/offline_scope_unresolved/i, 'offline_scope_unresolved'],
  [/offline_storage_unavailable/i, 'offline_storage_unavailable'],
  // The invitation codes (0007). They used to be a private map inside invitations.ts, which meant
  // the invitee — a person who has no account yet and no way to ask anyone — was the one reader
  // whose failures came from a second vocabulary.
  [/invitation_unknown/i, 'invitation_unknown'],
  [/invitation_expired/i, 'invitation_expired'],
  [/invitation_accepted/i, 'invitation_accepted'],
  [/invitation_revoked/i, 'invitation_revoked'],
  [/email_mismatch/i, 'email_mismatch'],
  [/profile_exists/i, 'profile_exists'],
  [/org_suspended/i, 'org_suspended'],
  [/full_name_required/i, 'full_name_required'],
  [/not_authenticated/i, 'not_authenticated'],
  [/terms_consent_required/i, 'terms_consent_required'],
];

const FALLBACK = 'fallback';

/**
 * Turns any thrown value or Supabase error message into a DICTIONARY KEY.
 *
 * A key and not a sentence, because the moment of failure and the moment of display are not the
 * same moment. The offline queue catches a write error now and shows it when the device comes
 * back; a query client catches one before any component has rendered. Resolving text at the throw
 * would freeze the language that happened to be active then. A key travels, and whoever draws it
 * on a screen resolves it in the language that reader is actually using.
 */
export function toErrorKey(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : String(e);
  // The original is what a developer needs; the return value is what the user reads.
  if (raw) console.error('[supplyflow]', raw);
  for (const [re, key] of PATTERNS) if (re.test(raw)) return key;
  return FALLBACK;
}

/**
 * The Hebrew sentence for a failure, resolved immediately.
 *
 * TRANSITIONAL, and deliberately named for what it does. `useT().errorText` is the one that
 * follows the reader's language; this one is Hebrew whatever the reader chose. Every remaining
 * call is therefore a screen that has not been converted yet, and the count of them is PINNED by
 * `node scripts/gate-i18n.mjs legacy-errors` so it can only go down. When it reaches zero this
 * function goes with it.
 */
export function toHebrewError(e: unknown): string {
  return (he.errors as Record<string, string>)[toErrorKey(e)] ?? he.errors.fallback;
}

/**
 * Reads a supabase-js result and throws on failure.
 *
 * The reason this exists: `await supabase.from(x).insert(y)` resolves successfully even when
 * the insert was rejected, so `try/catch` around it catches nothing and the next line happily
 * reports success. Every write should pass through here.
 */
export function ok<T extends { error: { message: string } | null }>(res: T): T {
  if (res.error) throw new Error(res.error.message);
  return res;
}
