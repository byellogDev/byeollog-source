namespace HurogiCollector;

internal static class ObsVoiceFilterProvisionCommand
{
    internal static async Task<int> RunAsync(bool runPreviews = false)
    {
        CollectorStorage? storage = null;
        try
        {
            _ = AgentDataPaths.PrepareDataRoot();
            storage = new CollectorStorage();
            storage.LoadState();
            var settings = storage.LoadObsSettings() with { Enabled = true };
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(runPreviews ? 40 : 20));
            await using var obs = await ObsWebSocketClient.ConnectAsync(settings, timeout.Token);
            var info = await obs.GetVersionAsync(timeout.Token);
            var result = await ObsVoiceAnonymizerProvisioner.EnsureAsync(
                obs,
                info,
                settings,
                timeout.Token);
            var prepared = await obs.GetSourceFilterListAsync(settings.MicrophoneInputName, timeout.Token);
            var down = prepared.Single(item => string.Equals(
                item.FilterName,
                settings.VoiceAnonymizerFilterName,
                StringComparison.Ordinal));
            var up = prepared.Single(item => string.Equals(
                item.FilterName,
                settings.VoiceAnonymizerUpFilterName,
                StringComparison.Ordinal));
            if (!string.Equals(down.FilterKind, ObsVoiceFilterInstaller.FilterKind, StringComparison.Ordinal)
                || !string.Equals(up.FilterKind, ObsVoiceFilterInstaller.FilterKind, StringComparison.Ordinal)
                || down.FilterEnabled
                || up.FilterEnabled)
            {
                throw new InvalidOperationException("생성된 두 신원보호 필터의 종류 또는 꺼짐 상태를 재검증하지 못했습니다.");
            }
            storage.Log(
                $"별록 전용 OBS 음성 필터 준비 완료 · created={result.CreatedCount} · downReady=True · upReady=True");
            if (runPreviews)
            {
                var adapter = new TimedMuteActionAdapter(storage);
                var downPreview = await adapter.RunLocalVoiceAnonymizerPreviewAsync(
                    ObsVoiceAnonymizerContract.DownPreset,
                    timeout.Token);
                var upPreview = await adapter.RunLocalVoiceAnonymizerPreviewAsync(
                    ObsVoiceAnonymizerContract.UpPreset,
                    timeout.Token);
                if (!downPreview.MutedVerified || !downPreview.RestoredVerified
                    || !upPreview.MutedVerified || !upPreview.RestoredVerified)
                {
                    throw new InvalidOperationException("두 신원보호 필터의 켜짐 또는 원상복구 검증에 실패했습니다.");
                }
                storage.Log("별록 전용 OBS 음성 필터 실동작 검증 완료 · downRestored=True · upRestored=True");
                Console.WriteLine("VOICE_FILTER_PREVIEW_PASS downRestored=True upRestored=True");
            }
            Console.WriteLine(
                $"VOICE_FILTER_READY created={result.CreatedCount} downEnabled={down.FilterEnabled} upEnabled={up.FilterEnabled}");
            return 0;
        }
        catch (Exception ex)
        {
            storage?.Log("별록 전용 OBS 음성 필터 준비 실패 · " + ex.GetType().Name + " · " + ex.Message);
            return 1;
        }
    }
}
