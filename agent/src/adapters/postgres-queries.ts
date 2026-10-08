export const postgresQueries: Record<string, string> = {
  version: "SELECT version() AS version",
  health:
    "SELECT current_database() AS database, pg_is_in_recovery() AS recovery, now() AS observed_at",
  activity:
    "SELECT state, wait_event_type, count(*)::int AS count FROM pg_stat_activity GROUP BY state, wait_event_type",
  replication_status:
    "SELECT state, sync_state, write_lag::text, flush_lag::text, replay_lag::text FROM pg_stat_replication",
};
