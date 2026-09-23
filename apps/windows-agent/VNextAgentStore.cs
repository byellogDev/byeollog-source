using System.Text.Json;

namespace HurogiCollector;

internal sealed record VNextAgentJob(
    string ExecutionId,
    string IdempotencyKey,
    string WorkspaceId,
    string EventId,
    string ExecutionTarget,
    string AgentDeviceId,
    string ActionType,
    JsonElement ActionParams,
    int TimeoutMs,
    int AttemptNo,
    int MaxAttempts,
    int RetryBackoffSeconds,
    DateTimeOffset LeaseExpiresAt,
    VNextOverlayAssetDescriptor? OverlayAsset = null);

internal sealed record VNextAgentOutcome(
    bool Succeeded,
    bool Retryable,
    object? Result,
    string? Error);

internal sealed record VNextAgentAck(
    string ExecutionId,
    int AttemptNo,
    bool Succeeded,
    bool Retryable,
    object? Result,
    string? Error);

internal sealed record VNextAgentReceipt(
    string ExecutionId,
    string State,
    int LatestAttemptNo,
    int? OutcomeAttemptNo,
    bool? Succeeded,
    bool? Retryable,
    object? Result,
    string? Error);

internal sealed record VNextAgentOutboxItem(long Id, VNextAgentAck Ack, int SendAttempts);

internal sealed record VNextAgentStoreStats(int PendingAcks, int Uncertain, int Succeeded);

internal sealed record VNextAgentStoreHealth(
    bool IntegrityOk,
    bool ForeignKeysOk,
    int SchemaVersion,
    int PendingAcks,
    int Uncertain,
    int Succeeded);

internal sealed record VNextAgentExecutionEvidence(
    string ActionType,
    string State,
    int AttemptNo,
    DateTimeOffset ReceivedAtUtc,
    DateTimeOffset? CompletedAtUtc,
    string? ExpectedOverlayAssetId,
    int? ExpectedOverlayAssetVersion,
    string? ExpectedOverlayContentSha256,
    bool AckSent,
    JsonElement? Result);

internal sealed class VNextAgentStore : IDisposable
{
    private readonly NativeSqliteDatabase _database;
    private readonly JsonSerializerOptions _json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true
    };

    public VNextAgentStore(string path)
    {
        _database = new NativeSqliteDatabase(path);
        _database.ExecuteScript("""
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = FULL;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS agent_meta (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS inbox (
              execution_id TEXT PRIMARY KEY,
              idempotency_key TEXT NOT NULL UNIQUE,
              workspace_id TEXT NOT NULL,
              event_id TEXT NOT NULL,
              execution_target TEXT NOT NULL CHECK (execution_target = 'local_agent'),
              agent_device_id TEXT,
              action_type TEXT NOT NULL,
              action_params_json TEXT NOT NULL,
              overlay_asset_id TEXT,
              overlay_asset_version INTEGER,
              overlay_asset_sha256 TEXT,
              timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 100 AND 300000),
              state TEXT NOT NULL CHECK (state IN (
                'received', 'executing', 'succeeded', 'retryable_failed', 'terminal_failed', 'uncertain'
              )),
              latest_attempt_no INTEGER NOT NULL CHECK (latest_attempt_no > 0),
              max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 20),
              retry_backoff_seconds INTEGER NOT NULL CHECK (retry_backoff_seconds BETWEEN 1 AND 86400),
              outcome_attempt_no INTEGER,
              succeeded INTEGER CHECK (succeeded IN (0, 1)),
              retryable INTEGER CHECK (retryable IN (0, 1)),
              result_json TEXT,
              error TEXT,
              lease_expires_at TEXT NOT NULL,
              received_at_ms INTEGER NOT NULL,
              executing_at_ms INTEGER,
              completed_at_ms INTEGER,
              updated_at_ms INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS outbox (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              execution_id TEXT NOT NULL REFERENCES inbox(execution_id) ON DELETE CASCADE,
              attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
              payload_json TEXT NOT NULL,
              delivery_status TEXT NOT NULL DEFAULT 'pending'
                CHECK (delivery_status IN ('pending', 'sent', 'stale', 'rejected')),
              send_attempts INTEGER NOT NULL DEFAULT 0 CHECK (send_attempts >= 0),
              next_send_at_ms INTEGER NOT NULL,
              last_error TEXT,
              created_at_ms INTEGER NOT NULL,
              sent_at_ms INTEGER,
              UNIQUE (execution_id, attempt_no)
            );

            CREATE INDEX IF NOT EXISTS outbox_due_idx
              ON outbox (delivery_status, next_send_at_ms, id);
            """);
        MigrateSchema();
        RecoverInterrupted();
    }

    private static long NowMs => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private void MigrateSchema()
    {
        var versionRow = _database.QuerySingle("PRAGMA user_version");
        var version = versionRow is null ? 0 : ReadInt(versionRow, "user_version");
        var columns = _database.Query("PRAGMA table_info(inbox)")
            .Select(row => ReadString(row, "name"))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (version < 2 && !columns.Contains("agent_device_id"))
            _database.Execute("ALTER TABLE inbox ADD COLUMN agent_device_id TEXT");
        if (version < 3)
        {
            if (!columns.Contains("overlay_asset_id"))
                _database.Execute("ALTER TABLE inbox ADD COLUMN overlay_asset_id TEXT");
            if (!columns.Contains("overlay_asset_version"))
                _database.Execute("ALTER TABLE inbox ADD COLUMN overlay_asset_version INTEGER");
            if (!columns.Contains("overlay_asset_sha256"))
                _database.Execute("ALTER TABLE inbox ADD COLUMN overlay_asset_sha256 TEXT");
        }
        _database.ExecuteScript("PRAGMA user_version = 3;");
    }

    private void RecoverInterrupted()
    {
        _database.Execute(
            """
            UPDATE inbox
            SET state = 'uncertain',
                error = 'local agent restarted while the action outcome was unknown',
                updated_at_ms = ?
            WHERE state = 'executing'
            """,
            NowMs);
    }

    public string GetOrCreateDeviceId()
    {
        return _database.Transaction(() =>
        {
            var row = _database.QuerySingle("SELECT value FROM agent_meta WHERE key = 'device_id'");
            if (row is not null) return ReadString(row, "value");
            var deviceId = Guid.NewGuid().ToString("D");
            _database.Execute("INSERT INTO agent_meta (key, value) VALUES ('device_id', ?)", deviceId);
            return deviceId;
        });
    }

    public VNextAgentReceipt Receive(VNextAgentJob job)
    {
        var now = NowMs;
        var actionParamsJson = job.ActionParams.GetRawText();
        var overlayAssetId = job.OverlayAsset?.AssetId;
        var overlayAssetVersion = job.OverlayAsset?.VersionNumber;
        var overlayAssetSha256 = job.OverlayAsset?.ContentSha256;
        return _database.Transaction(() =>
        {
            var existing = _database.QuerySingle(
                "SELECT execution_id FROM inbox WHERE execution_id = ?",
                job.ExecutionId);
            if (existing is null)
            {
                _database.Execute(
                    """
                    INSERT INTO inbox (
                      execution_id, idempotency_key, workspace_id, event_id,
                      execution_target, agent_device_id, action_type, action_params_json,
                      overlay_asset_id, overlay_asset_version, overlay_asset_sha256, timeout_ms,
                      state, latest_attempt_no, max_attempts, retry_backoff_seconds,
                      lease_expires_at, received_at_ms, updated_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?, ?, ?, ?)
                    """,
                    job.ExecutionId,
                    job.IdempotencyKey,
                    job.WorkspaceId,
                    job.EventId,
                    job.ExecutionTarget,
                    job.AgentDeviceId,
                    job.ActionType,
                    actionParamsJson,
                    overlayAssetId,
                    overlayAssetVersion,
                    overlayAssetSha256,
                    job.TimeoutMs,
                    job.AttemptNo,
                    job.MaxAttempts,
                    job.RetryBackoffSeconds,
                    job.LeaseExpiresAt.ToString("O"),
                    now,
                    now);
            }
            else
            {
                _database.Execute(
                    """
                    UPDATE inbox
                    SET agent_device_id = coalesce(agent_device_id, ?),
                        overlay_asset_id = CASE
                          WHEN state = 'received' AND overlay_asset_id IS NULL THEN ?
                          ELSE overlay_asset_id
                        END,
                        overlay_asset_version = CASE
                          WHEN state = 'received' AND overlay_asset_version IS NULL THEN ?
                          ELSE overlay_asset_version
                        END,
                        overlay_asset_sha256 = CASE
                          WHEN state = 'received' AND overlay_asset_sha256 IS NULL THEN ?
                          ELSE overlay_asset_sha256
                        END,
                        latest_attempt_no = max(latest_attempt_no, ?),
                        lease_expires_at = CASE
                          WHEN ? >= latest_attempt_no THEN ?
                          ELSE lease_expires_at
                        END,
                        updated_at_ms = ?
                    WHERE execution_id = ?
                    """,
                    job.AgentDeviceId,
                    overlayAssetId,
                    overlayAssetVersion,
                    overlayAssetSha256,
                    job.AttemptNo,
                    job.AttemptNo,
                    job.LeaseExpiresAt.ToString("O"),
                    now,
                    job.ExecutionId);
            }

            var row = RequireInbox(job.ExecutionId);
            if (ReadString(row, "idempotency_key") != job.IdempotencyKey
                || ReadString(row, "workspace_id") != job.WorkspaceId
                || ReadString(row, "event_id") != job.EventId
                || ReadString(row, "execution_target") != job.ExecutionTarget
                || ReadString(row, "agent_device_id") != job.AgentDeviceId
                || ReadString(row, "action_type") != job.ActionType
                || ReadString(row, "action_params_json") != actionParamsJson
                || ReadNullableString(row, "overlay_asset_id") != overlayAssetId
                || ReadNullableInt(row, "overlay_asset_version") != overlayAssetVersion
                || ReadNullableString(row, "overlay_asset_sha256") != overlayAssetSha256
                || ReadInt(row, "timeout_ms") != job.TimeoutMs
                || ReadInt(row, "max_attempts") != job.MaxAttempts
                || ReadInt(row, "retry_backoff_seconds") != job.RetryBackoffSeconds)
            {
                throw new InvalidOperationException("실행 스냅샷이 attempt 사이에서 변경되었습니다.");
            }
            if (job.AttemptNo < ReadInt(row, "latest_attempt_no"))
                throw new InvalidOperationException("이전 실행 attempt가 뒤늦게 전달되었습니다.");

            if (ReadString(row, "state") == "retryable_failed"
                && ReadNullableInt(row, "outcome_attempt_no") is int outcomeAttempt
                && job.AttemptNo > outcomeAttempt)
            {
                _database.Execute(
                    """
                    UPDATE inbox
                    SET state = 'received', outcome_attempt_no = NULL, succeeded = NULL,
                        retryable = NULL, result_json = NULL, error = NULL,
                        executing_at_ms = NULL, completed_at_ms = NULL, updated_at_ms = ?
                    WHERE execution_id = ?
                    """,
                    now,
                    job.ExecutionId);
            }

            return GetReceipt(job.ExecutionId)
                ?? throw new InvalidOperationException("SQLite inbox 저장 결과가 없습니다.");
        });
    }

    public VNextAgentReceipt? GetReceipt(string executionId)
    {
        var row = _database.QuerySingle("SELECT * FROM inbox WHERE execution_id = ?", executionId);
        if (row is null) return null;
        return new VNextAgentReceipt(
            executionId,
            ReadString(row, "state"),
            ReadInt(row, "latest_attempt_no"),
            ReadNullableInt(row, "outcome_attempt_no"),
            ReadNullableBool(row, "succeeded"),
            ReadNullableBool(row, "retryable"),
            ReadJson(row, "result_json"),
            ReadNullableString(row, "error"));
    }

    public bool MarkExecuting(string executionId, int attemptNo)
    {
        var now = NowMs;
        return _database.Execute(
            """
            UPDATE inbox
            SET state = 'executing', executing_at_ms = ?, updated_at_ms = ?
            WHERE execution_id = ? AND latest_attempt_no = ? AND state = 'received'
            """,
            now,
            now,
            executionId,
            attemptNo) == 1;
    }

    public void CompleteAndQueueAck(string executionId, int attemptNo, VNextAgentOutcome outcome)
    {
        var state = outcome.Succeeded ? "succeeded" : outcome.Retryable ? "retryable_failed" : "terminal_failed";
        var now = NowMs;
        _database.Transaction(() =>
        {
            var updated = _database.Execute(
                """
                UPDATE inbox
                SET state = ?, outcome_attempt_no = ?, succeeded = ?, retryable = ?,
                    result_json = ?, error = ?, completed_at_ms = ?, updated_at_ms = ?
                WHERE execution_id = ? AND latest_attempt_no = ? AND state = 'executing'
                """,
                state,
                attemptNo,
                outcome.Succeeded,
                outcome.Retryable,
                outcome.Result is null ? null : JsonSerializer.Serialize(outcome.Result, _json),
                outcome.Error,
                now,
                now,
                executionId,
                attemptNo);
            if (updated != 1) throw new InvalidOperationException("실행 중 상태의 inbox 항목을 찾지 못했습니다.");
            InsertAck(new VNextAgentAck(
                executionId,
                attemptNo,
                outcome.Succeeded,
                outcome.Retryable,
                outcome.Result,
                outcome.Error),
                now);
        });
    }

    public void MarkUncertain(string executionId, int attemptNo, string error)
    {
        var updated = _database.Execute(
            """
            UPDATE inbox
            SET state = 'uncertain', error = ?, updated_at_ms = ?
            WHERE execution_id = ? AND latest_attempt_no = ? AND state = 'executing'
            """,
            Limit(error),
            NowMs,
            executionId,
            attemptNo);
        if (updated != 1) throw new InvalidOperationException("실행 중 상태의 inbox 항목을 찾지 못했습니다.");
    }

    public void ResolveUncertainAndQueueAck(string executionId, int attemptNo)
    {
        const string error = "local action outcome is uncertain after interruption; automatic replay was blocked";
        var now = NowMs;
        _database.Transaction(() =>
        {
            var updated = _database.Execute(
                """
                UPDATE inbox
                SET state = 'terminal_failed', outcome_attempt_no = ?, succeeded = 0,
                    retryable = 0, result_json = NULL, error = ?, completed_at_ms = ?, updated_at_ms = ?
                WHERE execution_id = ? AND state = 'uncertain'
                """,
                attemptNo,
                error,
                now,
                now,
                executionId);
            if (updated != 1) throw new InvalidOperationException("불확실 상태의 inbox 항목을 찾지 못했습니다.");
            InsertAck(new VNextAgentAck(executionId, attemptNo, false, false, null, error), now);
        });
    }

    public void QueueCachedAck(string executionId, int attemptNo)
    {
        var receipt = GetReceipt(executionId)
            ?? throw new InvalidOperationException("기존 실행 receipt를 찾지 못했습니다.");
        var replayable = receipt.State is "succeeded" or "terminal_failed"
            || (receipt.State == "retryable_failed" && receipt.OutcomeAttemptNo == attemptNo);
        if (!replayable || receipt.Succeeded is null || receipt.Retryable is null)
            throw new InvalidOperationException($"{receipt.State} 상태는 ACK를 재사용할 수 없습니다.");

        InsertAck(new VNextAgentAck(
            executionId,
            attemptNo,
            receipt.Succeeded.Value,
            receipt.Retryable.Value,
            receipt.Result,
            receipt.Error),
            NowMs);
    }

    private void InsertAck(VNextAgentAck ack, long now)
    {
        _database.Execute(
            """
            INSERT OR IGNORE INTO outbox (
              execution_id, attempt_no, payload_json, delivery_status,
              send_attempts, next_send_at_ms, created_at_ms
            ) VALUES (?, ?, ?, 'pending', 0, ?, ?)
            """,
            ack.ExecutionId,
            ack.AttemptNo,
            JsonSerializer.Serialize(ack, _json),
            now,
            now);
    }

    public IReadOnlyList<VNextAgentOutboxItem> DueOutbox(int limit = 20)
    {
        return _database.Query(
                """
                SELECT id, payload_json, send_attempts
                FROM outbox
                WHERE delivery_status = 'pending' AND next_send_at_ms <= ?
                ORDER BY id
                LIMIT ?
                """,
                NowMs,
                limit)
            .Select(row => new VNextAgentOutboxItem(
                ReadLong(row, "id"),
                JsonSerializer.Deserialize<VNextAgentAck>(ReadString(row, "payload_json"), _json)
                    ?? throw new InvalidOperationException("SQLite ACK payload를 해석하지 못했습니다."),
                ReadInt(row, "send_attempts")))
            .ToList();
    }

    public void MarkOutboxSent(long id)
    {
        _database.Execute(
            """
            UPDATE outbox
            SET delivery_status = 'sent', sent_at_ms = ?, last_error = NULL
            WHERE id = ? AND delivery_status = 'pending'
            """,
            NowMs,
            id);
    }

    public void MarkOutboxStale(long id, string error) => SetOutboxTerminal(id, "stale", error);
    public void MarkOutboxRejected(long id, string error) => SetOutboxTerminal(id, "rejected", error);

    private void SetOutboxTerminal(long id, string status, string error)
    {
        _database.Execute(
            "UPDATE outbox SET delivery_status = ?, last_error = ? WHERE id = ? AND delivery_status = 'pending'",
            status,
            Limit(error),
            id);
    }

    public void RescheduleOutbox(long id, int previousAttempts, string error)
    {
        var attempts = previousAttempts + 1;
        var delayMs = Math.Min(60_000, 1000 * (1 << Math.Min(attempts - 1, 6)));
        _database.Execute(
            """
            UPDATE outbox
            SET send_attempts = ?, next_send_at_ms = ?, last_error = ?
            WHERE id = ? AND delivery_status = 'pending'
            """,
            attempts,
            NowMs + delayMs,
            Limit(error),
            id);
    }

    public bool IsAckSent(string executionId)
    {
        var row = _database.QuerySingle(
            "SELECT 1 AS found FROM outbox WHERE execution_id = ? AND delivery_status = 'sent' LIMIT 1",
            executionId);
        return row is not null;
    }

    public VNextAgentAck? GetSentAck(string executionId)
    {
        var row = _database.QuerySingle(
            """
            SELECT payload_json
            FROM outbox
            WHERE execution_id = ? AND delivery_status = 'sent'
            ORDER BY attempt_no DESC
            LIMIT 1
            """,
            executionId);
        return row is null
            ? null
            : JsonSerializer.Deserialize<VNextAgentAck>(ReadString(row, "payload_json"), _json);
    }

    public VNextAgentAck? GetRecordedAck(string executionId)
    {
        var row = _database.QuerySingle(
            """
            SELECT payload_json
            FROM outbox
            WHERE execution_id = ?
            ORDER BY attempt_no DESC
            LIMIT 1
            """,
            executionId);
        return row is null
            ? null
            : JsonSerializer.Deserialize<VNextAgentAck>(ReadString(row, "payload_json"), _json);
    }

    internal static bool IsFinalLocalOutcome(VNextAgentAck ack) =>
        ack.Succeeded || !ack.Retryable;

    public VNextAgentExecutionEvidence? FindFirstObsTimedMuteSince(DateTimeOffset sinceUtc)
    {
        var row = _database.QuerySingle(
            """
            SELECT i.action_type, i.state, i.latest_attempt_no,
                   i.received_at_ms, i.completed_at_ms,
                   i.overlay_asset_id, i.overlay_asset_version, i.overlay_asset_sha256,
                   i.result_json,
                   CASE WHEN EXISTS (
                     SELECT 1 FROM outbox o
                     WHERE o.execution_id = i.execution_id
                       AND o.delivery_status = 'sent'
                   ) THEN 1 ELSE 0 END AS ack_sent
            FROM inbox i
            WHERE i.action_type = 'obs.mute_for'
              AND i.received_at_ms >= ?
            ORDER BY i.received_at_ms ASC, i.execution_id ASC
            LIMIT 1
            """,
            sinceUtc.ToUnixTimeMilliseconds());
        if (row is null) return null;

        var result = ReadJson(row, "result_json");
        return new VNextAgentExecutionEvidence(
            ReadString(row, "action_type"),
            ReadString(row, "state"),
            ReadInt(row, "latest_attempt_no"),
            DateTimeOffset.FromUnixTimeMilliseconds(ReadLong(row, "received_at_ms")),
            row["completed_at_ms"] is null
                ? null
                : DateTimeOffset.FromUnixTimeMilliseconds(ReadLong(row, "completed_at_ms")),
            ReadNullableString(row, "overlay_asset_id"),
            ReadNullableInt(row, "overlay_asset_version"),
            ReadNullableString(row, "overlay_asset_sha256"),
            ReadLong(row, "ack_sent") != 0,
            result is JsonElement element ? element : null);
    }

    public VNextAgentStoreStats Stats()
    {
        var pending = _database.QuerySingle("SELECT count(*) AS value FROM outbox WHERE delivery_status = 'pending'");
        var uncertain = _database.QuerySingle("SELECT count(*) AS value FROM inbox WHERE state = 'uncertain'");
        var succeeded = _database.QuerySingle("SELECT count(*) AS value FROM inbox WHERE state = 'succeeded'");
        return new VNextAgentStoreStats(
            pending is null ? 0 : ReadInt(pending, "value"),
            uncertain is null ? 0 : ReadInt(uncertain, "value"),
            succeeded is null ? 0 : ReadInt(succeeded, "value"));
    }

    public VNextAgentStoreHealth Health()
    {
        var quickCheck = _database.QuerySingle("PRAGMA quick_check(1)");
        var quickCheckValue = quickCheck?.Values.FirstOrDefault()?.ToString() ?? "";
        var foreignKeyViolations = _database.Query("PRAGMA foreign_key_check");
        var versionRow = _database.QuerySingle("PRAGMA user_version");
        var stats = Stats();
        return new VNextAgentStoreHealth(
            string.Equals(quickCheckValue, "ok", StringComparison.OrdinalIgnoreCase),
            foreignKeyViolations.Count == 0,
            versionRow is null ? 0 : ReadInt(versionRow, "user_version"),
            stats.PendingAcks,
            stats.Uncertain,
            stats.Succeeded);
    }

    private IReadOnlyDictionary<string, object?> RequireInbox(string executionId)
    {
        return _database.QuerySingle("SELECT * FROM inbox WHERE execution_id = ?", executionId)
            ?? throw new InvalidOperationException("SQLite inbox 항목을 찾지 못했습니다.");
    }

    private object? ReadJson(IReadOnlyDictionary<string, object?> row, string key)
    {
        var text = ReadNullableString(row, key);
        if (text is null) return null;
        using var document = JsonDocument.Parse(text);
        return document.RootElement.Clone();
    }

    private static string ReadString(IReadOnlyDictionary<string, object?> row, string key) =>
        Convert.ToString(row[key]) ?? "";

    private static string? ReadNullableString(IReadOnlyDictionary<string, object?> row, string key) =>
        row[key] is null ? null : Convert.ToString(row[key]);

    private static long ReadLong(IReadOnlyDictionary<string, object?> row, string key) =>
        Convert.ToInt64(row[key]);

    private static int ReadInt(IReadOnlyDictionary<string, object?> row, string key) =>
        checked((int)ReadLong(row, key));

    private static int? ReadNullableInt(IReadOnlyDictionary<string, object?> row, string key) =>
        row[key] is null ? null : ReadInt(row, key);

    private static bool? ReadNullableBool(IReadOnlyDictionary<string, object?> row, string key) =>
        row[key] is null ? null : ReadLong(row, key) != 0;

    private static string Limit(string value) => value.Length <= 2000 ? value : value[..2000];

    public void Dispose() => _database.Dispose();
}
