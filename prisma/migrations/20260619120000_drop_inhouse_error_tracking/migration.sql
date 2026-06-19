-- Drop the in-house error tracker. Exception tracking is now handled by Sentry
-- (server: @sentry/node, mobile: @sentry/react-native). The MetricSnapshot,
-- CronHeartbeat and AlertState observability tables are retained.
-- ErrorEvent has a FK -> ErrorGroup, so drop it first.
DROP TABLE IF EXISTS "ErrorEvent";
DROP TABLE IF EXISTS "ErrorGroup";
