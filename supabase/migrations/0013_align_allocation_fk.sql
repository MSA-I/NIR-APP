-- Align the payment_id foreign key on the two allocation tables (OPEN-DECISIONS / PROGRESS).
--
-- The two sibling junction tables behaved oppositely when a payment was deleted:
--   payment_allocations.payment_id  ->  ON DELETE CASCADE   (0001:289)
--   bank_allocations.payment_id     ->  NO ACTION            (0001:329)
-- So deleting a payment silently shredded its payment_allocations but errored on a
-- bank_allocation — an inconsistency that only stayed hidden because nothing hard-deletes
-- payments in normal use.
--
-- Decision (approved 21.07.2026): RESTRICT on both. The constitution keeps financial records
-- via soft-delete, so a hard DELETE of a payment should never happen — and if one is attempted,
-- it must fail loudly rather than cascade-delete financial allocation rows. RESTRICT makes the
-- attempt an explicit error on either table, consistently.

alter table payment_allocations drop constraint payment_allocations_payment_id_fkey;
alter table payment_allocations add  constraint payment_allocations_payment_id_fkey
  foreign key (payment_id) references payments(id) on delete restrict;

alter table bank_allocations drop constraint bank_allocations_payment_id_fkey;
alter table bank_allocations add  constraint bank_allocations_payment_id_fkey
  foreign key (payment_id) references payments(id) on delete restrict;

-- verify: both should now read ON DELETE RESTRICT
--   select conrelid::regclass, pg_get_constraintdef(oid) from pg_constraint
--   where conname in ('payment_allocations_payment_id_fkey','bank_allocations_payment_id_fkey');
