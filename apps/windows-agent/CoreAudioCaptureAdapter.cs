namespace HurogiCollector;

internal sealed record WindowsCaptureSettings(bool Enabled, string EndpointId, string EndpointName)
{
    public static WindowsCaptureSettings Default { get; } = new(false, "", "");
}

internal sealed record WindowsCaptureEndpoint(string Id, string FriendlyName, bool IsDefault)
{
    public override string ToString() => IsDefault ? FriendlyName + " (Windows 기본)" : FriendlyName;
}

internal sealed class CoreAudioCaptureException : Exception
{
    public CoreAudioCaptureException(string step, Exception innerException)
        : base($"Windows Core Audio {step} failed.", innerException)
    {
        Step = step;
        HResult = innerException.HResult;
    }

    public string Step { get; }
}

internal sealed class WindowsCaptureEndpointTarget : ITimedMuteTarget
{
    private readonly string _endpointId;

    public WindowsCaptureEndpointTarget(string endpointId)
    {
        _endpointId = CoreAudioCaptureAdapter.NormalizeEndpointId(endpointId);
    }

    public string TargetType => "windows_capture";
    public string TargetKey => _endpointId;

    public Task<bool> GetMutedAsync(CancellationToken cancellationToken) =>
        Task.Run(
            () => CoreAudioCaptureAdapter.GetMute(_endpointId, cancellationToken),
            cancellationToken);

    public Task SetMutedAsync(bool muted, CancellationToken cancellationToken) =>
        Task.Run(
            () => CoreAudioCaptureAdapter.SetMute(_endpointId, muted, cancellationToken),
            cancellationToken);
}

/// <summary>
/// Windows 캡처 endpoint 제어의 단일 진입점입니다.
/// 관리형 COM/RCW 경로는 사용하지 않으며, 검증된 네이티브 구현으로만 전달합니다.
/// </summary>
internal static class CoreAudioCaptureAdapter
{
    public static IReadOnlyList<WindowsCaptureEndpoint> ListActiveEndpoints() =>
        CoreAudioNativeApi.ListActiveEndpoints();

    public static bool GetMute(string endpointId, CancellationToken cancellationToken = default) =>
        CoreAudioNativeApi.GetMute(NormalizeEndpointId(endpointId), cancellationToken);

    public static void SetMute(
        string endpointId,
        bool muted,
        CancellationToken cancellationToken = default) =>
        CoreAudioNativeApi.SetMute(NormalizeEndpointId(endpointId), muted, cancellationToken);

    internal static string NormalizeEndpointId(string? endpointId)
    {
        var normalized = (endpointId ?? "").Trim();
        if (normalized.Length is < 1 or > 512 || normalized.Any(char.IsControl))
            throw new ArgumentException("Windows capture endpoint ID is invalid.", nameof(endpointId));
        return normalized;
    }
}
