-- Reclassify fact rows that were ingested while charge_category was
-- hardcoded to 'Usage'.
--
-- WHY A MIGRATION IS NEEDED AT ALL: charge_category is part of the fact
-- table's natural key (002_facts.sql), so the ingest upsert cannot
-- correct a row's category -- it inserts a SECOND row. A September day
-- ingested as ('Tax', ..., 'Usage') and then re-fetched after the fix
-- becomes two rows for the same service and day, and
-- `include_tax_and_credits=true` counts the amount twice.
--
-- Shipping the code fix without this would therefore have made the data
-- worse than leaving it alone.
--
-- The classification mirrors cost_explorer.NON_USAGE_SERVICES. Keep the
-- two in step; there is deliberately no attempt to catch the inline
-- negative credits that arrive attached to a real service name, because
-- those cannot be identified from the service name at all (TODO-27).

-- 1. Delete rows that the corrected key would duplicate: where BOTH the
--    stale 'Usage' row and a correctly-classified row already exist for
--    the same service and day, the stale one is the one to drop.
DELETE FROM fact_cost_daily stale
WHERE stale.charge_category = 'Usage'
  AND lower(btrim(stale.service_name)) IN ('tax', 'refund', 'credit', 'credits')
  AND EXISTS (
    SELECT 1
    FROM fact_cost_daily fixed
    WHERE fixed.provider        = stale.provider
      AND fixed.account_id      = stale.account_id
      AND fixed.service_name    = stale.service_name
      AND fixed.region          = stale.region
      AND fixed.usage_date      = stale.usage_date
      AND fixed.currency        = stale.currency
      AND fixed.charge_category <> 'Usage'
  );

-- 2. Reclassify the remainder in place. No duplicate can exist now, so
--    the natural key is safe to move.
UPDATE fact_cost_daily
   SET charge_category = CASE lower(btrim(service_name))
                           WHEN 'tax'     THEN 'Tax'
                           WHEN 'refund'  THEN 'Credit'
                           WHEN 'credit'  THEN 'Credit'
                           WHEN 'credits' THEN 'Credit'
                         END,
       updated_at = now(),
       updated_by = 'migration:007',
       revision   = revision + 1
 WHERE charge_category = 'Usage'
   AND lower(btrim(service_name)) IN ('tax', 'refund', 'credit', 'credits');

-- 3. Same for the dimension table, so the service list stops offering
--    'Tax' as though it were a service anyone would filter by.
--    (dim_service has no category column; this is a no-op placeholder
--    kept out deliberately rather than inventing one.)
