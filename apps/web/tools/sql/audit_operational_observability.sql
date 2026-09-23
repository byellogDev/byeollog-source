begin transaction read only;
set local statement_timeout='20s';

select jsonb_build_object(
  'gatewayHeartbeatMonitor',jsonb_build_object(
    'scheduled',exists(
      select 1 from cron.job
      where jobname='byeollog-soop-gateway-heartbeat-monitor-v1' and active
    ),
    'lastRunStatus',(
      select status from cron.job_run_details
      where jobid=(select jobid from cron.job where jobname='byeollog-soop-gateway-heartbeat-monitor-v1' order by jobid desc limit 1)
      order by start_time desc limit 1
    ),
    'lastRunAt',(
      select start_time from cron.job_run_details
      where jobid=(select jobid from cron.job where jobname='byeollog-soop-gateway-heartbeat-monitor-v1' order by jobid desc limit 1)
      order by start_time desc limit 1
    ),
    'webhookConfigured',exists(select 1 from vault.secrets where name='soop_gateway_alert_webhook_url'),
    'openIncidents',(select count(*) from public.byeollog_soop_gateway_incidents where resolved_at is null),
    'openedLast24h',(select count(*) from public.byeollog_soop_gateway_incidents where opened_at>=clock_timestamp()-interval '24 hours')
  ),
  'workspaceIsolation',jsonb_build_object(
    'blockedConflictsTotal',(select count(*) from private.soop_workspace_conflicts),
    'blockedConflictsLast24h',(select count(*) from private.soop_workspace_conflicts where detected_at>=clock_timestamp()-interval '24 hours'),
    'latestConflictAt',(select max(detected_at) from private.soop_workspace_conflicts)
  ),
  'agentDisplay',jsonb_build_object(
    'retentionScheduled',exists(select 1 from cron.job where jobname='byeollog-agent-display-observation-retention-v1' and active),
    'observationsLast24h',(select count(*) from private.agent_display_observations_v1 where server_received_at>=clock_timestamp()-interval '24 hours'),
    'wallpaperReadyLast24h',(select count(*) from private.agent_display_observations_v1 where observation_kind='wallpaper_ready' and server_received_at>=clock_timestamp()-interval '24 hours'),
    'latestWallpaperReadyAt',(select max(server_received_at) from private.agent_display_observations_v1 where observation_kind='wallpaper_ready'),
    'p95WallpaperEndToEndMs',(
      select percentile_disc(0.95) within group(order by end_to_end_ms)
      from private.agent_display_observations_v1
      where observation_kind='wallpaper_ready' and server_received_at>=clock_timestamp()-interval '24 hours'
    )
  ),
  'agentDelivery',jsonb_build_object(
    'pendingOlderThan2m',(
      select count(*) from byeollog_automation.executions
      where execution_target='local_agent' and status='pending' and created_at<clock_timestamp()-interval '2 minutes'
    ),
    'runningWithExpiredLease',(
      select count(*) from byeollog_automation.executions
      where execution_target='local_agent' and status='running' and lease_expires_at<clock_timestamp()
    ),
    'failedLast24h',(
      select count(*) from byeollog_automation.executions
      where execution_target='local_agent' and status='failed' and finished_at>=clock_timestamp()-interval '24 hours'
    )
  )
) as observability;

rollback;
