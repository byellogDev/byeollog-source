using System.Text.Json;

namespace HurogiCollector;

internal sealed record ObsVoiceAnonymizerProvisionResult(
    bool DownCreated,
    bool UpCreated,
    string PluginPath)
{
    public int CreatedCount => (DownCreated ? 1 : 0) + (UpCreated ? 1 : 0);
}

internal static class ObsVoiceAnonymizerProvisioner
{
    private const int DownSemitones = -4;
    private const int UpSemitones = 4;
    private const string LegacyReaJsFileName = "reajs.dll";
    private const string LegacyFilterKind = "vst_filter";

    private sealed record LegacyFilterBackup(string Name, string Kind, JsonElement Settings);

    public static async Task<ObsVoiceAnonymizerProvisionResult> EnsureAsync(
        ObsWebSocketClient obs,
        ObsServerInfo info,
        ObsConnectionSettings settings,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(obs);
        ArgumentNullException.ThrowIfNull(info);
        ArgumentNullException.ThrowIfNull(settings);
        if (string.IsNullOrWhiteSpace(settings.MicrophoneInputName))
            throw new InvalidOperationException("OBS 마이크 입력을 먼저 선택해주세요.");
        if (string.Equals(settings.VoiceAnonymizerFilterName, settings.VoiceAnonymizerUpFilterName, StringComparison.Ordinal))
            throw new InvalidOperationException("다운톤과 업톤 필터 이름은 서로 달라야 합니다.");

        RequireRequests(info.AvailableRequests);
        var install = await ObsVoiceFilterInstaller.EnsureInstalledAsync(cancellationToken);
        if (install.Changed && install.ObsRestartRequired)
            throw new InvalidOperationException(
                "별록 전용 OBS 음성 필터를 설치했습니다. OBS를 완전히 종료했다가 다시 실행한 후 두 필터 자동 준비를 다시 눌러주세요.");

        var kinds = await obs.GetSourceFilterKindListAsync(cancellationToken);
        if (!kinds.Contains(ObsVoiceFilterInstaller.FilterKind, StringComparer.Ordinal))
            throw new InvalidOperationException(
                "OBS가 별록 전용 음성 필터를 아직 불러오지 않았습니다. OBS를 완전히 종료했다가 다시 실행해주세요.");

        var filters = await obs.GetSourceFilterListAsync(settings.MicrophoneInputName, cancellationToken);
        var down = filters.FirstOrDefault(item => string.Equals(item.FilterName, settings.VoiceAnonymizerFilterName, StringComparison.Ordinal));
        var up = filters.FirstOrDefault(item => string.Equals(item.FilterName, settings.VoiceAnonymizerUpFilterName, StringComparison.Ordinal));
        var legacyBackups = new List<LegacyFilterBackup>(2);
        var created = new List<string>(2);
        try
        {
            down = await PrepareExistingSlotAsync(
                obs, settings.MicrophoneInputName, down, "다운톤", DownSemitones, legacyBackups, cancellationToken);
            up = await PrepareExistingSlotAsync(
                obs, settings.MicrophoneInputName, up, "업톤", UpSemitones, legacyBackups, cancellationToken);

            if (down is null)
            {
                await CreateAndVerifyAsync(
                    obs, settings.MicrophoneInputName, settings.VoiceAnonymizerFilterName, DownSemitones, created, cancellationToken);
            }
            if (up is null)
            {
                await CreateAndVerifyAsync(
                    obs, settings.MicrophoneInputName, settings.VoiceAnonymizerUpFilterName, UpSemitones, created, cancellationToken);
            }

            return new(
                created.Contains(settings.VoiceAnonymizerFilterName, StringComparer.Ordinal),
                created.Contains(settings.VoiceAnonymizerUpFilterName, StringComparer.Ordinal),
                install.PluginPath);
        }
        catch (Exception creationFailure)
        {
            Exception? rollbackFailure = null;
            foreach (var filterName in created.AsEnumerable().Reverse())
            {
                try
                {
                    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                    await obs.RemoveSourceFilterAsync(settings.MicrophoneInputName, filterName, timeout.Token);
                }
                catch (Exception ex) { rollbackFailure ??= ex; }
            }
            foreach (var backup in legacyBackups.AsEnumerable().Reverse())
            {
                try
                {
                    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                    await obs.CreateSourceFilterAsync(
                        settings.MicrophoneInputName,
                        backup.Name,
                        backup.Kind,
                        backup.Settings,
                        filterEnabled: false,
                        timeout.Token);
                }
                catch (Exception ex) { rollbackFailure ??= ex; }
            }
            if (rollbackFailure is not null)
                throw new InvalidOperationException(
                    "신원보호 필터 자동 준비에 실패했고 기존 필터 원복도 완료하지 못했습니다. OBS 필터 목록을 확인해주세요.",
                    new AggregateException(creationFailure, rollbackFailure));
            throw;
        }
    }

    private static void RequireRequests(IReadOnlySet<string> available)
    {
        foreach (var request in new[]
                 {
                     "GetSourceFilterKindList", "GetSourceFilterList", "GetSourceFilter",
                     "CreateSourceFilter", "RemoveSourceFilter", "SetSourceFilterEnabled"
                 })
        {
            if (!available.Contains(request))
                throw new InvalidOperationException("연결된 OBS가 신원보호 필터 자동 생성을 지원하지 않습니다.");
        }
    }

    private static async Task<ObsSourceFilterSummary?> PrepareExistingSlotAsync(
        ObsWebSocketClient obs,
        string sourceName,
        ObsSourceFilterSummary? filter,
        string label,
        int expectedSemitones,
        ICollection<LegacyFilterBackup> legacyBackups,
        CancellationToken cancellationToken)
    {
        if (filter is null) return null;
        if (string.Equals(filter.FilterKind, ObsVoiceFilterInstaller.FilterKind, StringComparison.Ordinal))
        {
            await VerifySettingsAsync(obs, sourceName, filter.FilterName, expectedSemitones, cancellationToken);
            return filter;
        }
        if (!string.Equals(filter.FilterKind, LegacyFilterKind, StringComparison.Ordinal))
            throw new InvalidOperationException(
                $"'{filter.FilterName}' {label} 필터가 이미 있지만 별록 음성 필터가 아닙니다. 기존 필터는 변경하지 않았습니다.");
        if (filter.FilterEnabled)
            throw new InvalidOperationException(
                $"기존 '{filter.FilterName}' ReaJS 필터가 켜져 있습니다. 필터를 끈 뒤 다시 준비해주세요.");

        var legacySettings = await obs.GetSourceFilterSettingsAsync(sourceName, filter.FilterName, cancellationToken);
        var pluginPath = OptionalString(legacySettings, "plugin_path");
        if (!string.Equals(Path.GetFileName(pluginPath), LegacyReaJsFileName, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException(
                $"'{filter.FilterName}' {label} VST 필터가 ReaJS인지 확인할 수 없어 변경하지 않았습니다.");

        await obs.RemoveSourceFilterAsync(sourceName, filter.FilterName, cancellationToken);
        // Only record a backup after OBS confirms removal. If removal itself fails,
        // the original filter is still authoritative and must not be recreated over it.
        legacyBackups.Add(new(filter.FilterName, filter.FilterKind, legacySettings.Clone()));
        return null;
    }

    private static async Task CreateAndVerifyAsync(
        ObsWebSocketClient obs,
        string sourceName,
        string filterName,
        int semitones,
        ICollection<string> createdFilters,
        CancellationToken cancellationToken)
    {
        await obs.CreateSourceFilterAsync(
            sourceName,
            filterName,
            ObsVoiceFilterInstaller.FilterKind,
            new { semitones, engine = "signalsmith", schemaVersion = 1 },
            filterEnabled: false,
            cancellationToken);
        // Track immediately after the mutating request succeeds so any later
        // verification failure still removes this new filter during rollback.
        createdFilters.Add(filterName);
        var created = await obs.GetSourceFilterAsync(sourceName, filterName, cancellationToken);
        if (!string.Equals(created.FilterKind, ObsVoiceFilterInstaller.FilterKind, StringComparison.Ordinal))
            throw new InvalidOperationException("생성된 신원보호 필터 종류를 확인하지 못했습니다.");
        if (created.FilterEnabled)
        {
            await obs.SetSourceFilterEnabledAsync(sourceName, filterName, false, cancellationToken);
            created = await obs.GetSourceFilterAsync(sourceName, filterName, cancellationToken);
            if (created.FilterEnabled)
                throw new InvalidOperationException("생성된 신원보호 필터를 안전한 꺼짐 상태로 만들지 못했습니다.");
        }
        await VerifySettingsAsync(obs, sourceName, filterName, semitones, cancellationToken);
    }

    private static async Task VerifySettingsAsync(
        ObsWebSocketClient obs,
        string sourceName,
        string filterName,
        int expectedSemitones,
        CancellationToken cancellationToken)
    {
        var settings = await obs.GetSourceFilterSettingsAsync(sourceName, filterName, cancellationToken);
        if (!settings.TryGetProperty("semitones", out var value)
            || !value.TryGetDouble(out var semitones)
            || Math.Abs(semitones - expectedSemitones) > 0.001)
            throw new InvalidOperationException(
                $"'{filterName}' 필터의 음정 설정이 별록 프리셋과 일치하지 않습니다.");
    }

    private static string OptionalString(JsonElement value, string propertyName) =>
        value.ValueKind == JsonValueKind.Object
        && value.TryGetProperty(propertyName, out var property)
        && property.ValueKind == JsonValueKind.String
            ? property.GetString() ?? ""
            : "";
}
