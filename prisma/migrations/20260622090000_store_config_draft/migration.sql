-- Editor working draft for the storefront block document.
-- Publish copies storeConfigDraft → storeConfig (the published doc the public store renders).
ALTER TABLE "Business" ADD COLUMN "storeConfigDraft" JSONB;
