-- P1/P2 follow-up: 새 device FK의 삭제/조인 경로를 위한 covering index.
create index if not exists bangsel_collector_logs_device_id_idx
  on public.bangsel_collector_logs(device_id);

