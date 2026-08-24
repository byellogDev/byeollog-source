namespace HurogiCollector;

internal sealed record VNextOverlayAssetDescriptor(
    string AssetId,
    string AssetKey,
    int VersionNumber,
    string DisplayName,
    string MimeType,
    string ContentSha256,
    int ByteSize,
    int WidthPx,
    int HeightPx,
    string DeliveryMode,
    bool Required,
    string? DownloadPath);

internal sealed record VNextOverlayAssetManifest(
    int SchemaVersion,
    DateTimeOffset GeneratedAt,
    IReadOnlyList<VNextOverlayAssetDescriptor> Assets);

internal sealed record VNextReadyOverlayAsset(
    string AssetId,
    string ContentSha256);
