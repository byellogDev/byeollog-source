using System.Text.Json;
using System.Text.RegularExpressions;

namespace HurogiCollector;

internal sealed record TimedMuteOverlayPlacement(int XBasisPoints, int YBasisPoints, int ScalePercent = 100);

internal static class TimedMuteContract
{
    public const int MinimumDurationMs = 1_000;
    // 사용자가 저장하는 기본 아봉은 240초 이하이지만, 다음 룰렛 보상 배수가
    // 적용된 단일 실행은 연속 세션 상한(15분)까지 안전하게 수용합니다.
    public const int MaximumDurationMs = 900_000;
    // 여러 아봉이 연속으로 들어와도 하나의 방송을 무기한 잠그지 않도록
    // 한 번의 연속 음소거 세션에는 명시적인 상한을 둡니다.
    public const int MaximumAccumulatedDurationMs = 900_000;
    public const string MicrophoneOffOverlayAssetKey = "mic_off";
    private static readonly Regex OverlayAssetKeyPattern = new(
        "^[a-z0-9][a-z0-9_-]{1,63}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    public static bool WasOverlayDisplayObserved(
        long activeStateRequestsBefore,
        long activeStateRequestsAfter,
        DateTimeOffset? lastActiveStateRequestAtUtc) =>
        activeStateRequestsAfter > activeStateRequestsBefore
        && lastActiveStateRequestAtUtc is not null;

    public static bool TryReadStrictParameters(
        JsonElement value,
        string expectedTarget,
        out int durationMs)
    {
        durationMs = 0;
        if (value.ValueKind != JsonValueKind.Object) return false;

        var count = 0;
        foreach (var property in value.EnumerateObject())
        {
            count++;
            if (property.Name is not ("target" or "durationMs")) return false;
        }

        if (count != 2) return false;
        if (!value.TryGetProperty("target", out var targetValue)
            || targetValue.ValueKind != JsonValueKind.String
            || !string.Equals(targetValue.GetString(), expectedTarget, StringComparison.Ordinal))
            return false;
        if (!value.TryGetProperty("durationMs", out var durationValue)
            || durationValue.ValueKind != JsonValueKind.Number
            || !durationValue.TryGetInt32(out durationMs))
            return false;
        return durationMs is >= MinimumDurationMs and <= MaximumDurationMs;
    }

    public static bool TryReadObsParameters(
        JsonElement value,
        out int durationMs,
        out string? overlayAssetKey) =>
        TryReadOverlayParameters(value, "microphone", out durationMs, out overlayAssetKey, out _);

    public static bool TryReadObsParameters(
        JsonElement value,
        out int durationMs,
        out string? overlayAssetKey,
        out TimedMuteOverlayPlacement? overlayPlacement) =>
        TryReadOverlayParameters(value, "microphone", out durationMs, out overlayAssetKey, out overlayPlacement);

    public static bool TryReadWindowsParameters(
        JsonElement value,
        out int durationMs,
        out string? overlayAssetKey) =>
        TryReadOverlayParameters(value, "selected_capture_device", out durationMs, out overlayAssetKey, out _);

    public static bool TryReadWindowsParameters(
        JsonElement value,
        out int durationMs,
        out string? overlayAssetKey,
        out TimedMuteOverlayPlacement? overlayPlacement) =>
        TryReadOverlayParameters(value, "selected_capture_device", out durationMs, out overlayAssetKey, out overlayPlacement);

    private static bool TryReadOverlayParameters(
        JsonElement value,
        string expectedTarget,
        out int durationMs,
        out string? overlayAssetKey,
        out TimedMuteOverlayPlacement? overlayPlacement)
    {
        durationMs = 0;
        overlayAssetKey = null;
        overlayPlacement = null;
        if (value.ValueKind != JsonValueKind.Object) return false;

        var count = 0;
        foreach (var property in value.EnumerateObject())
        {
            count++;
            if (property.Name is not ("target" or "durationMs" or "overlayAssetKey" or "overlayImageKey" or "overlayAssetId" or "overlayPositionX" or "overlayPositionY" or "overlayScalePercent"))
                return false;
        }

        if (count is < 2 or > 6) return false;
        if (!value.TryGetProperty("target", out var targetValue)
            || targetValue.ValueKind != JsonValueKind.String
            || !string.Equals(targetValue.GetString(), expectedTarget, StringComparison.Ordinal))
            return false;
        if (!value.TryGetProperty("durationMs", out var durationValue)
            || durationValue.ValueKind != JsonValueKind.Number
            || !durationValue.TryGetInt32(out durationMs)
            || durationMs is < MinimumDurationMs or > MaximumDurationMs)
            return false;

        var hasAssetKey = value.TryGetProperty("overlayAssetKey", out var legacyOverlayValue);
        var hasImageKey = value.TryGetProperty("overlayImageKey", out var packagedOverlayValue);
        var hasAssetId = value.TryGetProperty("overlayAssetId", out var overlayIdValue);
        if ((hasAssetKey && hasImageKey) || ((hasAssetKey || hasImageKey) && hasAssetId)) return false;
        if (!hasAssetKey && !hasImageKey && !hasAssetId)
            return count == 2;
        if (hasAssetKey || hasImageKey)
        {
            var overlayValue = hasImageKey ? packagedOverlayValue : legacyOverlayValue;
            if (overlayValue.ValueKind != JsonValueKind.String) return false;
            overlayAssetKey = overlayValue.GetString();
            if (overlayAssetKey is null || !OverlayAssetKeyPattern.IsMatch(overlayAssetKey)) return false;
        }
        else
        {
            if (overlayIdValue.ValueKind != JsonValueKind.String
                || !OverlayAssetCache.TryMapBuiltInAssetIdToKey(overlayIdValue.GetString(), out overlayAssetKey))
                return false;
        }

        var hasX = value.TryGetProperty("overlayPositionX", out var xValue);
        var hasY = value.TryGetProperty("overlayPositionY", out var yValue);
        if (hasX != hasY) return false;
        var hasScale = value.TryGetProperty("overlayScalePercent", out var scaleValue);
        var scale = 100;
        if (hasScale
            && (scaleValue.ValueKind != JsonValueKind.Number
                || !scaleValue.TryGetInt32(out scale)
                || scale is < 25 or > 200))
            return false;
        var expectedCount = 3 + (hasX ? 2 : 0) + (hasScale ? 1 : 0);
        if (count != expectedCount) return false;
        if (!hasX)
        {
            if (hasScale) overlayPlacement = new TimedMuteOverlayPlacement(5_000, 5_000, scale);
            return true;
        }
        if (xValue.ValueKind != JsonValueKind.Number
            || yValue.ValueKind != JsonValueKind.Number
            || !xValue.TryGetInt32(out var x)
            || !yValue.TryGetInt32(out var y)
            || x is < 0 or > 10_000
            || y is < 0 or > 10_000)
            return false;
        overlayPlacement = new TimedMuteOverlayPlacement(x, y, scale);
        return true;
    }
}

internal static class ObsVoiceAnonymizerContract
{
    public const int MinimumDurationMs = 3_000;
    public const int MaximumDurationMs = 60_000;
    public const string ActionLabel = "(신원보호모드/개발중)";
    public const string ControlType = "voice_anonymize";
    public const string Target = "microphone";
    public const string Preset = "anonymous_low";
    private const char TargetKeySeparator = '\u001f';

    public static bool TryReadParameters(JsonElement value, out int durationMs)
    {
        durationMs = 0;
        if (value.ValueKind != JsonValueKind.Object) return false;

        var count = 0;
        foreach (var property in value.EnumerateObject())
        {
            count++;
            if (property.Name is not (
                "label" or
                "controlType" or
                "target" or
                "durationMs" or
                "preset" or
                "requiresObsMicInput" or
                "requiresObsFilter"))
                return false;
        }
        if (count != 7) return false;

        return ExactString(value, "label", ActionLabel)
            && ExactString(value, "controlType", ControlType)
            && ExactString(value, "target", Target)
            && ExactString(value, "preset", Preset)
            && ExactTrue(value, "requiresObsMicInput")
            && ExactTrue(value, "requiresObsFilter")
            && value.TryGetProperty("durationMs", out var duration)
            && duration.ValueKind == JsonValueKind.Number
            && duration.TryGetInt32(out durationMs)
            && durationMs is >= MinimumDurationMs and <= MaximumDurationMs;
    }

    private static bool ExactString(JsonElement value, string name, string expected) =>
        value.TryGetProperty(name, out var property)
        && property.ValueKind == JsonValueKind.String
        && string.Equals(property.GetString(), expected, StringComparison.Ordinal);

    private static bool ExactTrue(JsonElement value, string name) =>
        value.TryGetProperty(name, out var property)
        && property.ValueKind == JsonValueKind.True;

    public static string EncodeTargetKey(string sourceName, string filterName)
    {
        ValidateName(sourceName, nameof(sourceName));
        ValidateName(filterName, nameof(filterName));
        return sourceName + TargetKeySeparator + filterName;
    }

    public static bool TryDecodeTargetKey(
        string targetKey,
        out string sourceName,
        out string filterName)
    {
        sourceName = "";
        filterName = "";
        if (string.IsNullOrEmpty(targetKey)) return false;
        var separator = targetKey.IndexOf(TargetKeySeparator);
        if (separator <= 0
            || separator != targetKey.LastIndexOf(TargetKeySeparator)
            || separator == targetKey.Length - 1)
            return false;
        sourceName = targetKey[..separator];
        filterName = targetKey[(separator + 1)..];
        return IsValidName(sourceName) && IsValidName(filterName);
    }

    public static bool IsValidName(string value) =>
        value.Length is >= 1 and <= 128 && !value.Any(char.IsControl);

    private static void ValidateName(string value, string parameterName)
    {
        if (!IsValidName(value))
            throw new ArgumentException("OBS 소스 또는 필터 이름이 올바르지 않습니다.", parameterName);
    }
}

internal sealed record TimedMuteRecoveryRecord(
    int SchemaVersion,
    string OperationId,
    string TargetType,
    string TargetKey,
    bool InitialMuted,
    string Phase,
    DateTimeOffset RestoreDueAtUtc,
    DateTimeOffset UpdatedAtUtc);

internal interface ITimedMuteRecoveryStore
{
    TimedMuteRecoveryRecord? Load();
    void Save(TimedMuteRecoveryRecord record);
    void Clear(string operationId);
}

internal interface ITimedMuteTarget
{
    string TargetType { get; }
    string TargetKey { get; }
    Task<bool> GetMutedAsync(CancellationToken cancellationToken);
    Task SetMutedAsync(bool muted, CancellationToken cancellationToken);
}

internal sealed record TimedMuteRunResult(
    string OperationId,
    string TargetType,
    int DurationMs,
    bool InitialMuted,
    bool Changed,
    bool MutedVerified,
    bool RestoredVerified);

internal sealed record TimedMuteRecoveryResult(
    bool HadPendingOperation,
    string TargetType,
    bool InitialMuted,
    bool RestoredVerified);

internal sealed class TimedMuteRestoreFailedException : Exception
{
    public TimedMuteRestoreFailedException(string targetType, Exception? operationError = null)
        : base($"Timed mute restoration could not be verified for {targetType}.", operationError) { }
}

internal sealed class TimedMuteOperationException : Exception
{
    public TimedMuteOperationException(bool mutationAttempted, Exception innerException)
        : base("Timed mute operation failed after the original state was restored.", innerException)
    {
        MutationAttempted = mutationAttempted;
    }

    public bool MutationAttempted { get; }
}

internal sealed class TimedMuteCanceledAfterRestoreException : OperationCanceledException
{
    public TimedMuteCanceledAfterRestoreException(Exception innerException)
        : base("Timed mute operation was canceled after the original state was restored.", innerException) { }
}

internal sealed class TimedMuteAccumulationLimitException : InvalidOperationException
{
    public TimedMuteAccumulationLimitException()
        : base("연속 아봉 누적 시간이 안전 상한인 15분을 초과합니다.") { }
}

/// <summary>
/// OBS와 Windows 캡처 장치가 공유하는 시간·직렬화·상태 보존·복구 코어입니다.
/// 같은 마이크에 겹쳐 들어온 요청은 하나의 활성 세션에 시간을 더합니다.
/// 중간 복원 없이 모든 시간을 소진한 뒤 한 번만 원래 상태로 복구하며,
/// ACK는 복구가 확인된 뒤에만 가능하도록 성공을 반환합니다.
/// </summary>
internal sealed class TimedMuteCoordinator
{
    private const int RestoreAttempts = 3;
    private static readonly TimeSpan RestoreAttemptTimeout = TimeSpan.FromSeconds(5);
    private readonly ITimedMuteRecoveryStore _recoveryStore;
    private readonly SemaphoreSlim _mutationGate;
    private readonly Func<TimeSpan, CancellationToken, Task> _delay;
    private readonly Func<DateTimeOffset> _utcNow;
    private readonly object _sessionGate = new();
    private ActiveSession? _activeSession;

    private sealed class ActiveSession
    {
        public ActiveSession(
            ITimedMuteTarget target,
            int durationMs,
            DateTimeOffset? notAfterUtc)
        {
            TargetType = target.TargetType;
            TargetKey = target.TargetKey;
            PendingDurationMs = durationMs;
            TotalDurationMs = durationMs;
            NotAfterUtc = notAfterUtc;
        }

        public string TargetType { get; }
        public string TargetKey { get; }
        public int PendingDurationMs { get; set; }
        public int TotalDurationMs { get; set; }
        public DateTimeOffset? NotAfterUtc { get; set; }
        public bool Accepting { get; set; } = true;
        public bool Active { get; set; }
        public List<Action> ActivatedCallbacks { get; } = new();
        public TimedMuteRecoveryRecord? RecoveryRecord { get; set; }
        public CancellationTokenSource Stop { get; } = new();
        public TaskCompletionSource<TimedMuteRunResult> Completion { get; } = new(
            TaskCreationOptions.RunContinuationsAsynchronously);

        public bool Matches(ITimedMuteTarget target) =>
            string.Equals(TargetType, target.TargetType, StringComparison.Ordinal)
            && string.Equals(TargetKey, target.TargetKey, StringComparison.Ordinal);
    }

    public TimedMuteCoordinator(
        ITimedMuteRecoveryStore recoveryStore,
        SemaphoreSlim mutationGate,
        Func<TimeSpan, CancellationToken, Task>? delay = null,
        Func<DateTimeOffset>? utcNow = null)
    {
        _recoveryStore = recoveryStore;
        _mutationGate = mutationGate;
        _delay = delay ?? Task.Delay;
        _utcNow = utcNow ?? (() => DateTimeOffset.UtcNow);
    }

    public async Task<TimedMuteRunResult> ExecuteAsync(
        ITimedMuteTarget target,
        int durationMs,
        CancellationToken cancellationToken,
        Action? onAccepted = null,
        Action? onActivated = null,
        DateTimeOffset? notAfterUtc = null)
    {
        if (durationMs is < TimedMuteContract.MinimumDurationMs or > TimedMuteContract.MaximumDurationMs)
            throw new ArgumentOutOfRangeException(nameof(durationMs));
        if (notAfterUtc is not null && _utcNow() >= notAfterUtc.Value)
            throw new VNextActionExpiredException();

        ActiveSession session;
        var leader = false;
        var invokeActivatedImmediately = false;
        while (true)
        {
            Task<TimedMuteRunResult>? waitForPrevious = null;
            lock (_sessionGate)
            {
                if (_activeSession is null)
                {
                    session = new ActiveSession(target, durationMs, notAfterUtc);
                    if (onActivated is not null)
                        session.ActivatedCallbacks.Add(onActivated);
                    _activeSession = session;
                    leader = true;
                    break;
                }

                if (_activeSession.Accepting && _activeSession.Matches(target))
                {
                    session = _activeSession;
                    if (!session.Active)
                        TightenActivationDeadlineLocked(session, notAfterUtc);
                    AddDurationLocked(session, durationMs);
                    if (onActivated is not null)
                    {
                        if (session.Active)
                            invokeActivatedImmediately = true;
                        else
                            session.ActivatedCallbacks.Add(onActivated);
                    }
                    break;
                }

                waitForPrevious = _activeSession.Completion.Task;
            }

            try { await waitForPrevious.WaitAsync(cancellationToken); }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
            catch { /* 다른 대상의 복구 결과와 무관하게 gate가 풀린 뒤 새 세션을 시도합니다. */ }
        }

        onAccepted?.Invoke();
        if (invokeActivatedImmediately)
            onActivated!.Invoke();
        using var cancellationRegistration = leader
            ? cancellationToken.Register(
                static value => ((CancellationTokenSource)value!).Cancel(),
                session.Stop)
            : default;
        if (leader)
            await RunLeaderAsync(session, target);

        var aggregate = await session.Completion.Task;
        return aggregate with { DurationMs = durationMs };
    }

    private void AddDurationLocked(ActiveSession session, int durationMs)
    {
        if (session.TotalDurationMs > TimedMuteContract.MaximumAccumulatedDurationMs - durationMs)
            throw new TimedMuteAccumulationLimitException();

        session.PendingDurationMs += durationMs;
        session.TotalDurationMs += durationMs;
        if (session.RecoveryRecord is null) return;

        var previous = session.RecoveryRecord;
        var updated = previous with
        {
            RestoreDueAtUtc = previous.RestoreDueAtUtc.AddMilliseconds(durationMs),
            UpdatedAtUtc = _utcNow()
        };
        try
        {
            _recoveryStore.Save(updated);
            session.RecoveryRecord = updated;
        }
        catch
        {
            session.PendingDurationMs -= durationMs;
            session.TotalDurationMs -= durationMs;
            session.Stop.Cancel();
            throw;
        }
    }

    private static void TightenActivationDeadlineLocked(
        ActiveSession session,
        DateTimeOffset? notAfterUtc)
    {
        if (notAfterUtc is null) return;
        if (session.NotAfterUtc is null || notAfterUtc.Value < session.NotAfterUtc.Value)
            session.NotAfterUtc = notAfterUtc;
    }

    private async Task RunLeaderAsync(
        ActiveSession session,
        ITimedMuteTarget target)
    {
        var acquired = false;
        TimedMuteRunResult? result = null;
        Exception? failure = null;
        try
        {
            await _mutationGate.WaitAsync(session.Stop.Token);
            acquired = true;
            result = await RunPhysicalSessionAsync(session, target);
        }
        catch (Exception ex)
        {
            failure = ex;
        }
        finally
        {
            lock (_sessionGate) session.Accepting = false;
            if (acquired) _mutationGate.Release();
            lock (_sessionGate)
            {
                if (ReferenceEquals(_activeSession, session))
                    _activeSession = null;
            }
        }

        if (failure is null)
            session.Completion.TrySetResult(result!);
        else
            session.Completion.TrySetException(failure);
    }

    private async Task<TimedMuteRunResult> RunPhysicalSessionAsync(
        ActiveSession session,
        ITimedMuteTarget target)
    {
        EnsureFreshForActivation(session);

        var initialMuted = await target.GetMutedAsync(session.Stop.Token);
        EnsureFreshForActivation(session);
        var operationId = Guid.NewGuid().ToString("N");
        var now = _utcNow();
        lock (_sessionGate)
        {
            session.RecoveryRecord = new TimedMuteRecoveryRecord(
                1,
                operationId,
                target.TargetType,
                target.TargetKey,
                initialMuted,
                "prepared",
                now.AddMilliseconds(session.TotalDurationMs),
                now);
            _recoveryStore.Save(session.RecoveryRecord);
        }

        var mutationAttempted = false;
        var mutedVerified = false;
        Exception? operationError = null;
        try
        {
            if (!initialMuted)
            {
                // 호출 응답이 유실돼도 실제 변경은 적용됐을 수 있으므로 await 직전에 기록합니다.
                mutationAttempted = true;
                await target.SetMutedAsync(true, session.Stop.Token);
            }

            mutedVerified = await target.GetMutedAsync(session.Stop.Token);
            if (!mutedVerified)
                throw new InvalidDataException("Timed mute target did not enter the muted state.");

            lock (_sessionGate)
            {
                var activeAt = _utcNow();
                session.RecoveryRecord = session.RecoveryRecord! with
                {
                    Phase = "active",
                    RestoreDueAtUtc = activeAt.AddMilliseconds(session.TotalDurationMs),
                    UpdatedAtUtc = activeAt
                };
                _recoveryStore.Save(session.RecoveryRecord);
                session.Active = true;
            }
            Action[] activatedCallbacks;
            lock (_sessionGate)
            {
                activatedCallbacks = session.ActivatedCallbacks.ToArray();
                session.ActivatedCallbacks.Clear();
            }
            foreach (var callback in activatedCallbacks)
                callback();

            while (true)
            {
                int segmentDurationMs;
                lock (_sessionGate)
                {
                    segmentDurationMs = session.PendingDurationMs;
                    session.PendingDurationMs = 0;
                }
                await _delay(TimeSpan.FromMilliseconds(segmentDurationMs), session.Stop.Token);
                lock (_sessionGate)
                {
                    if (session.PendingDurationMs == 0)
                    {
                        session.Accepting = false;
                        break;
                    }
                }
            }
        }
        catch (Exception ex)
        {
            lock (_sessionGate) session.Accepting = false;
            operationError = ex;
        }

        var restored = await TryRestoreAsync(target, initialMuted);
        if (!restored)
            throw new TimedMuteRestoreFailedException(target.TargetType, operationError);

        try
        {
            _recoveryStore.Clear(operationId);
            lock (_sessionGate) session.RecoveryRecord = null;
        }
        catch (Exception ex)
        {
            throw new TimedMuteRestoreFailedException(target.TargetType, ex);
        }

        if (operationError is OperationCanceledException)
            throw new TimedMuteCanceledAfterRestoreException(operationError);
        if (operationError is not null)
            throw new TimedMuteOperationException(mutationAttempted, operationError);

        return new TimedMuteRunResult(
            operationId,
            target.TargetType,
            session.TotalDurationMs,
            initialMuted,
            Changed: !initialMuted,
            MutedVerified: mutedVerified,
            RestoredVerified: true);
    }

    private void EnsureFreshForActivation(ActiveSession session)
    {
        DateTimeOffset? notAfterUtc;
        lock (_sessionGate) notAfterUtc = session.NotAfterUtc;
        if (notAfterUtc is not null && _utcNow() >= notAfterUtc.Value)
            throw new VNextActionExpiredException();
    }

    public async Task<TimedMuteRecoveryResult> RecoverAsync(
        Func<TimedMuteRecoveryRecord, ITimedMuteTarget> targetFactory,
        CancellationToken cancellationToken)
    {
        await _mutationGate.WaitAsync(cancellationToken);
        try
        {
            var pending = _recoveryStore.Load();
            if (pending is null)
                return new TimedMuteRecoveryResult(false, "", false, true);

            ValidateRecoveryRecord(pending);
            var target = targetFactory(pending);
            if (!string.Equals(target.TargetType, pending.TargetType, StringComparison.Ordinal)
                || !string.Equals(target.TargetKey, pending.TargetKey, StringComparison.Ordinal))
                throw new InvalidDataException("Timed mute recovery target does not match the journal.");

            if (!await TryRestoreAsync(target, pending.InitialMuted))
                throw new TimedMuteRestoreFailedException(pending.TargetType);
            _recoveryStore.Clear(pending.OperationId);
            return new TimedMuteRecoveryResult(true, pending.TargetType, pending.InitialMuted, true);
        }
        finally
        {
            _mutationGate.Release();
        }
    }

    private async Task<bool> TryRestoreAsync(ITimedMuteTarget target, bool initialMuted)
    {
        for (var attempt = 1; attempt <= RestoreAttempts; attempt++)
        {
            try
            {
                using var timeout = new CancellationTokenSource(RestoreAttemptTimeout);
                await target.SetMutedAsync(initialMuted, timeout.Token);
                if (await target.GetMutedAsync(timeout.Token) == initialMuted)
                    return true;
            }
            catch
            {
                // 원래 작업의 취소 토큰과 분리된 새 시도로 복구합니다.
            }

            if (attempt < RestoreAttempts)
                await _delay(TimeSpan.FromMilliseconds(250), CancellationToken.None);
        }
        return false;
    }

    internal static void ValidateRecoveryRecord(TimedMuteRecoveryRecord record)
    {
        if (record.SchemaVersion != 1
            || record.OperationId.Length != 32
            || !record.OperationId.All(Uri.IsHexDigit)
            || record.TargetType.Length is < 1 or > 64
            || record.TargetKey.Length is < 1 or > 512
            || record.Phase is not ("prepared" or "active")
            || record.RestoreDueAtUtc == default
            || record.UpdatedAtUtc == default)
            throw new InvalidDataException("Timed mute recovery journal is invalid.");
    }
}
