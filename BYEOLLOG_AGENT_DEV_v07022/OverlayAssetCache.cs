using System.Buffers.Binary;
using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml;

namespace HurogiCollector;

internal sealed record OverlayAssetCacheSyncResult(
    int Available,
    int Downloaded,
    int Reused,
    int Unavailable,
    int RequiredUnavailable,
    int Pruned);

internal sealed record OverlayAssetCacheStatus(
    DateTimeOffset? ManifestGeneratedAt,
    int BuiltInCount,
    int ManagedCount,
    long ManagedBytes,
    bool RequiredReady);

internal sealed record OverlayAssetContent(
    VNextOverlayAssetDescriptor Descriptor,
    byte[] Bytes,
    string MimeType);

internal static class OverlayAssetValidator
{
    internal const int MaximumBytes = 10 * 1024 * 1024;
    private static readonly Regex AssetKeyPattern = new(
        "^[a-z0-9][a-z0-9_-]{1,63}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex Sha256Pattern = new(
        "^[0-9a-f]{64}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex DownloadPathPattern = new(
        "^assets/[0-9a-f-]{36}/v[1-9][0-9]*/[0-9a-f]{64}\\.(svg|png|webp|gif)$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly HashSet<string> MimeTypes = new(StringComparer.Ordinal)
    {
        "image/svg+xml",
        "image/png",
        "image/webp",
        "image/gif"
    };

    public static void ValidateDescriptor(VNextOverlayAssetDescriptor asset, bool manifestItem)
    {
        if (!Guid.TryParseExact(asset.AssetId, "D", out _)
            || !AssetKeyPattern.IsMatch(asset.AssetKey)
            || asset.VersionNumber < 1
            || string.IsNullOrWhiteSpace(asset.DisplayName)
            || asset.DisplayName.Length > 120
            || asset.DisplayName.Any(char.IsControl)
            || !MimeTypes.Contains(asset.MimeType)
            || !Sha256Pattern.IsMatch(asset.ContentSha256)
            || asset.ByteSize is < 1 or > MaximumBytes
            || asset.WidthPx is < 1 or > 7_680
            || asset.HeightPx is < 1 or > 7_680
            || asset.DeliveryMode is not ("agent_builtin" or "managed_bundle"))
            throw new InvalidDataException("오버레이 이미지 메타데이터가 올바르지 않습니다.");

        if (!manifestItem) return;
        if (asset.DeliveryMode == "agent_builtin" && asset.DownloadPath is not null)
            throw new InvalidDataException("내장 이미지는 다운로드 경로를 가질 수 없습니다.");
        if (asset.DeliveryMode == "managed_bundle"
            && (string.IsNullOrWhiteSpace(asset.DownloadPath)
                || !DownloadPathPattern.IsMatch(asset.DownloadPath)))
            throw new InvalidDataException("관리 이미지 다운로드 경로가 올바르지 않습니다.");
    }

    public static string Sha256Hex(ReadOnlySpan<byte> bytes) =>
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    public static void VerifyBytes(ReadOnlySpan<byte> bytes, VNextOverlayAssetDescriptor asset)
    {
        ValidateDescriptor(asset, manifestItem: asset.DownloadPath is not null || asset.DeliveryMode == "agent_builtin");
        if (bytes.Length != asset.ByteSize)
            throw new InvalidDataException("오버레이 이미지 크기가 manifest와 다릅니다.");
        if (!string.Equals(Sha256Hex(bytes), asset.ContentSha256, StringComparison.Ordinal))
            throw new InvalidDataException("오버레이 이미지 SHA-256이 manifest와 다릅니다.");
        var dimensions = Inspect(bytes, asset.MimeType);
        if (dimensions.Width != asset.WidthPx || dimensions.Height != asset.HeightPx)
            throw new InvalidDataException("오버레이 이미지 해상도가 manifest와 다릅니다.");
    }

    public static (int Width, int Height) Inspect(ReadOnlySpan<byte> bytes, string mimeType) => mimeType switch
    {
        "image/svg+xml" => InspectSvg(bytes),
        "image/png" => InspectPng(bytes),
        "image/gif" => InspectGif(bytes),
        "image/webp" => InspectWebP(bytes),
        _ => throw new InvalidDataException("지원하지 않는 오버레이 이미지 형식입니다.")
    };

    private static (int Width, int Height) InspectSvg(ReadOnlySpan<byte> bytes)
    {
        string text;
        try { text = new UTF8Encoding(false, true).GetString(bytes); }
        catch (DecoderFallbackException ex) { throw new InvalidDataException("SVG가 올바른 UTF-8이 아닙니다.", ex); }

        var settings = new XmlReaderSettings
        {
            DtdProcessing = DtdProcessing.Prohibit,
            XmlResolver = null,
            MaxCharactersInDocument = MaximumBytes,
            MaxCharactersFromEntities = 0,
            IgnoreComments = true
        };
        using var reader = XmlReader.Create(new StringReader(text), settings);
        reader.MoveToContent();
        if (!string.Equals(reader.LocalName, "svg", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("SVG 루트 요소가 없습니다.");
        var widthText = reader.GetAttribute("width");
        var heightText = reader.GetAttribute("height");
        if (!TryPixelDimension(widthText, out var width) || !TryPixelDimension(heightText, out var height))
            throw new InvalidDataException("SVG는 정수 픽셀 해상도를 선언해야 합니다.");

        do
        {
            if (reader.NodeType != XmlNodeType.Element) continue;
            if (reader.LocalName.Equals("script", StringComparison.OrdinalIgnoreCase)
                || reader.LocalName.Equals("foreignObject", StringComparison.OrdinalIgnoreCase)
                || reader.LocalName.Equals("image", StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("SVG에 허용되지 않는 요소가 있습니다.");
            if (!reader.HasAttributes) continue;
            while (reader.MoveToNextAttribute())
            {
                if (reader.LocalName.StartsWith("on", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("SVG 이벤트 속성은 허용되지 않습니다.");
                if ((reader.LocalName.Equals("href", StringComparison.OrdinalIgnoreCase)
                        || reader.Name.Equals("xlink:href", StringComparison.OrdinalIgnoreCase))
                    && !reader.Value.StartsWith('#'))
                    throw new InvalidDataException("SVG 외부 참조는 허용되지 않습니다.");
                foreach (Match match in Regex.Matches(reader.Value, "url\\(\\s*['\"]?([^)'\"]+)", RegexOptions.IgnoreCase))
                {
                    if (!match.Groups[1].Value.TrimStart().StartsWith('#'))
                        throw new InvalidDataException("SVG 외부 URL은 허용되지 않습니다.");
                }
            }
            reader.MoveToElement();
        } while (reader.Read());

        return (width, height);
    }

    private static bool TryPixelDimension(string? value, out int pixels)
    {
        pixels = 0;
        if (string.IsNullOrWhiteSpace(value)) return false;
        var normalized = value.EndsWith("px", StringComparison.OrdinalIgnoreCase)
            ? value[..^2]
            : value;
        return int.TryParse(normalized, NumberStyles.None, CultureInfo.InvariantCulture, out pixels)
            && pixels is >= 1 and <= 7_680;
    }

    private static (int Width, int Height) InspectPng(ReadOnlySpan<byte> bytes)
    {
        ReadOnlySpan<byte> signature = [137, 80, 78, 71, 13, 10, 26, 10];
        if (bytes.Length < 24 || !bytes[..8].SequenceEqual(signature)
            || !bytes.Slice(12, 4).SequenceEqual("IHDR"u8))
            throw new InvalidDataException("PNG 헤더가 올바르지 않습니다.");
        return (
            checked((int)BinaryPrimitives.ReadUInt32BigEndian(bytes.Slice(16, 4))),
            checked((int)BinaryPrimitives.ReadUInt32BigEndian(bytes.Slice(20, 4))));
    }

    private static (int Width, int Height) InspectGif(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length < 10
            || (!bytes[..6].SequenceEqual("GIF87a"u8) && !bytes[..6].SequenceEqual("GIF89a"u8)))
            throw new InvalidDataException("GIF 헤더가 올바르지 않습니다.");
        return (
            BinaryPrimitives.ReadUInt16LittleEndian(bytes.Slice(6, 2)),
            BinaryPrimitives.ReadUInt16LittleEndian(bytes.Slice(8, 2)));
    }

    private static (int Width, int Height) InspectWebP(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length < 30 || !bytes[..4].SequenceEqual("RIFF"u8) || !bytes.Slice(8, 4).SequenceEqual("WEBP"u8))
            throw new InvalidDataException("WebP 헤더가 올바르지 않습니다.");
        var chunk = Encoding.ASCII.GetString(bytes.Slice(12, 4));
        if (chunk == "VP8X")
            return (ReadUInt24(bytes.Slice(24, 3)) + 1, ReadUInt24(bytes.Slice(27, 3)) + 1);
        if (chunk == "VP8L" && bytes[20] == 0x2f)
        {
            var bits = BinaryPrimitives.ReadUInt32LittleEndian(bytes.Slice(21, 4));
            return ((int)(bits & 0x3fff) + 1, (int)((bits >> 14) & 0x3fff) + 1);
        }
        if (chunk == "VP8 " && bytes[23] == 0x9d && bytes[24] == 0x01 && bytes[25] == 0x2a)
            return (
                BinaryPrimitives.ReadUInt16LittleEndian(bytes.Slice(26, 2)) & 0x3fff,
                BinaryPrimitives.ReadUInt16LittleEndian(bytes.Slice(28, 2)) & 0x3fff);
        throw new InvalidDataException("지원하지 않는 WebP 헤더입니다.");
    }

    private static int ReadUInt24(ReadOnlySpan<byte> bytes) => bytes[0] | bytes[1] << 8 | bytes[2] << 16;
}

internal static class OverlayAssetCatalogCompatibility
{
    private const string LegacyBuiltInAssetKey = "microphone_off";
    private const string LegacyBuiltInDeliveryMode = "builtin";

    /// <summary>
    /// The first public automation catalog used shorter server-side labels for
    /// the one embedded microphone overlay. Accept those labels only when the
    /// immutable ID, version, digest, size, MIME type, and dimensions all match
    /// the bytes compiled into this Agent. No arbitrary remote asset can use
    /// this compatibility path.
    /// </summary>
    internal static bool TryNormalizeExactBuiltIn(
        string assetId,
        int versionNumber,
        string mimeType,
        string contentSha256,
        int byteSize,
        int widthPx,
        int heightPx,
        ref string assetKey,
        ref string deliveryMode)
    {
        var usesLegacyLabel = string.Equals(assetKey, LegacyBuiltInAssetKey, StringComparison.Ordinal)
            || string.Equals(deliveryMode, LegacyBuiltInDeliveryMode, StringComparison.Ordinal);
        if (!usesLegacyLabel) return true;

        if (!OverlayAssetCache.TryNormalizeServerBuiltIn(
                assetId,
                versionNumber,
                mimeType,
                contentSha256,
                byteSize,
                widthPx,
                heightPx,
                ref assetKey))
            return false;
        deliveryMode = "agent_builtin";
        return true;
    }
}

internal sealed class OverlayAssetCache
{
    internal const string MicrophoneOffAssetKey = "mic_off";
    internal const string BuiltInAssetId = "27ace87d-7ffa-5cfc-9c76-36c30cc1e2bc";
    internal const string BuiltInContentSha256 = "e1bcc594283f8307b9b681794618666bc9927b5efc1a2922523629c2c352873b";
    internal const string MicrophoneOffCenterAssetKey = "mic_off_center";
    internal const string MicrophoneOffTopLeftAssetKey = "mic_off_top_left";
    internal const string MicrophoneOffTopRightAssetKey = "mic_off_top_right";
    internal const string MicrophoneOffCenterAssetId = "f7ae3370-5e3c-5061-958b-c7c402c590c6";
    internal const string MicrophoneOffTopLeftAssetId = "f831caee-6953-51f9-9eee-9cfb66e96fc4";
    internal const string MicrophoneOffTopRightAssetId = "e745492e-4420-52e8-9a2b-36f53144c1c8";
    internal const string MicrophoneOffIconContentSha256 = "70b19130e6807a364172eb129bfce03f5cae598cfde8242b762de7274476c464";
    internal const string MicrophoneOffBadgeAssetKey = "mic_off_badge";
    internal const string MicrophoneOffQuietAssetKey = "mic_off_quiet";
    internal const string MicrophoneOffBadgeAssetId = "b3bbf63e-4464-560d-aaa6-87bb7477ffa9";
    internal const string MicrophoneOffQuietAssetId = "d2c2798e-643c-57e6-a0fa-495380e24553";
    internal const string MicrophoneOffBadgeContentSha256 = "c18ca005d58c084739af8cbe8b93f26154cc4199f21da27faa919920bad7206c";
    internal const string MicrophoneOffQuietContentSha256 = "2a5150bdc57ed43f0ea970e21b888a87a1ecf65d241f413d419e12cb60c9d2b8";
    internal const string MicrophoneOffSignalPanelAssetKey = "mic_off_signal_panel";
    internal const string MicrophoneOffScreenprintAssetKey = "mic_off_screenprint";
    internal const string MicrophoneOffSignalPanelAssetId = "2ca97f54-54c6-4b38-bc0f-019cec269f19";
    internal const string MicrophoneOffScreenprintAssetId = "8667c74b-0370-4ef5-a402-49affdf9664f";
    internal const string MicrophoneOffSignalPanelContentSha256 = "b62c2855b315c201cecdf53621d1200806a81fa2f3cc292945081fc313ec4888";
    internal const string MicrophoneOffScreenprintContentSha256 = "b2d94f9dba81ccbd9642961ec5bbb5bfc2f51da24cd72d0ac1c302de3ff59ccf";
    internal const string RaffleTicketGrantedAssetKey = "raffle_ticket_granted";
    internal const string RaffleDrawAssetKey = "raffle_draw";
    internal const string RaffleTicketGrantedAssetId = "956a73da-1eda-496f-a3fa-d0687f5a9b91";
    internal const string RaffleDrawAssetId = "9a3c7159-dcfe-49fa-b086-dcc6518c3512";
    internal const string RaffleTicketGrantedContentSha256 = "104470fa1839c6b8711863aed35d6a33ff52c6fb1dabc93e616da0441c190b86";
    internal const string RaffleDrawContentSha256 = "4a21dcdb62ac5bae96159dcebb33dd0215a4cedd17218561cac5d04004923d80";
    internal const string FlashbangSoftAssetKey = "flashbang_soft";
    internal const string FlashbangStandardAssetKey = "flashbang_standard";
    internal const string FlashbangStrongAssetKey = "flashbang_strong";
    internal const string FlashbangSoftAssetId = "dea5ef9d-51a9-4b28-b30a-8ef2146a134f";
    internal const string FlashbangStandardAssetId = "5a6b8c0d-1a6b-41e8-856b-187b435c1ea9";
    internal const string FlashbangStrongAssetId = "cbe68b82-fe27-4d2a-9b3f-922fe15b553d";
    internal const string FlashbangSoftContentSha256 = "68066dc4778d70ef85f9c48639b306353fd3f8bb2959c952157820362b2d3374";
    internal const string FlashbangStandardContentSha256 = "1933b6cf667ff7b10edf22c056fc757cb38155c27746d92b5d4da3ce24fa3b71";
    internal const string FlashbangStrongContentSha256 = "e18d5069154cda112af9eba60ec52ea273ee9301252a4cab2e210506fca584b0";
    internal const string WaterSplashAssetKey = "water_splash";
    internal const string FireworksAssetKey = "fireworks";
    internal const string EarthquakeAudioAssetKey = "earthquake_audio";
    internal const string WaterSplashAssetId = "f4abf066-d0aa-4b57-8a9f-6d0cbcb956e0";
    internal const string FireworksAssetId = "74346d77-6fe6-4cf9-af9b-afb80ff57fdc";
    internal const string EarthquakeAudioAssetId = "0f28aaef-8336-41bc-8d96-71405cbd7de0";
    internal const string WaterSplashContentSha256 = "6348579b7f309bb83e06d34d70e6db059f54c5d9824b6a9aaae2e6c4a179ea53";
    internal const string WaterRunoffContentSha256 = "d059b9e5d45fb638b764ea6c8cb3cb794490edc9c2a9587873fa5e1ec0c802ee";
    internal const string WaterSplashMotionContentSha256 = "553531218503cf9d79963944900e82c6184eba87bf7e516e414a231b405f3775";
    internal const string FireworksMotionContentSha256 = "ba683b68b1da3b2e110b3bc29a9e5c2fedac6abf2416b808d0b74cf837b4bedd";
    internal const string FireworksContentSha256 = "16c9c3a09100a48a3c9818efc91335d109d96ba985709e9b5a6439d3f37a1c57";
    internal const string EarthquakeAudioContentSha256 = "bc83d5c814fc3b98389e4fa41818cf01f581c01c0b2b39190967ba7169f2e6fe";
    private const string LegacyBuiltInResourceName = "HurogiCollector.Assets.byeollog_mic_off_overlay.svg";
    private const string IconBuiltInResourceName = "HurogiCollector.Assets.byeollog_mic_off_icon.png";
    private const string BadgeBuiltInResourceName = "HurogiCollector.Assets.byeollog_mic_off_badge.png";
    private const string QuietBuiltInResourceName = "HurogiCollector.Assets.byeollog_mic_off_quiet.png";
    private const string SignalPanelBuiltInResourceName = "HurogiCollector.Assets.byeollog_mic_off_signal_panel.png";
    private const string ScreenprintBuiltInResourceName = "HurogiCollector.Assets.byeollog_mic_off_screenprint.png";
    private const string RaffleTicketGrantedResourceName = "HurogiCollector.Assets.byeollog_raffle_ticket_granted.gif";
    private const string RaffleDrawResourceName = "HurogiCollector.Assets.byeollog_raffle_draw.gif";
    private const string FlashbangSoftResourceName = "HurogiCollector.Assets.byeollog_flashbang_soft.gif";
    private const string FlashbangStandardResourceName = "HurogiCollector.Assets.byeollog_flashbang_standard.gif";
    private const string FlashbangStrongResourceName = "HurogiCollector.Assets.byeollog_flashbang_strong.gif";
    private const string WaterSplashResourceName = "HurogiCollector.Assets.byeollog_water_splash.png";
    internal const string WaterRunoffResourceName = "HurogiCollector.Assets.byeollog_water_runoff_v2.png";
    internal const string WaterSplashMotionResourceName = "HurogiCollector.Assets.byeollog_water_splash_flip_v4.webm";
    internal const string FireworksMotionResourceName = "HurogiCollector.Assets.byeollog_bodyless_confetti_v1.webm";
    private const string FireworksResourceName = "HurogiCollector.Assets.byeollog_fireworks.png";
    private const string EarthquakeAudioResourceName = "HurogiCollector.Assets.byeollog_earthquake_audio.svg";
    private const long DefaultCacheLimitBytes = 50L * 1024 * 1024;
    private static readonly BuiltInDefinition[] BuiltInDefinitions =
    [
        new(BuiltInAssetId, "microphone_off", MicrophoneOffAssetKey, "별록 마이크 OFF · 기존 화면(호환용)", "image/svg+xml", BuiltInContentSha256, 1_926, 1_200, 360, true, LegacyBuiltInResourceName),
        new(MicrophoneOffCenterAssetId, MicrophoneOffCenterAssetKey, MicrophoneOffCenterAssetKey, "마이크 OFF · 중앙 출력형", "image/png", MicrophoneOffIconContentSha256, 335_254, 1_254, 1_254, false, IconBuiltInResourceName),
        new(MicrophoneOffTopLeftAssetId, MicrophoneOffTopLeftAssetKey, MicrophoneOffTopLeftAssetKey, "마이크 OFF · 좌측 상단형", "image/png", MicrophoneOffIconContentSha256, 335_254, 1_254, 1_254, false, IconBuiltInResourceName),
        new(MicrophoneOffTopRightAssetId, MicrophoneOffTopRightAssetKey, MicrophoneOffTopRightAssetKey, "마이크 OFF · 우측 상단형", "image/png", MicrophoneOffIconContentSha256, 335_254, 1_254, 1_254, false, IconBuiltInResourceName),
        new(MicrophoneOffBadgeAssetId, MicrophoneOffBadgeAssetKey, MicrophoneOffBadgeAssetKey, "마이크 OFF · 방송 배지", "image/png", MicrophoneOffBadgeContentSha256, 1_324_404, 1_254, 1_254, false, BadgeBuiltInResourceName),
        new(MicrophoneOffQuietAssetId, MicrophoneOffQuietAssetKey, MicrophoneOffQuietAssetKey, "마이크 OFF · 조용한 구름", "image/png", MicrophoneOffQuietContentSha256, 777_095, 1_254, 1_254, false, QuietBuiltInResourceName),
        new(MicrophoneOffSignalPanelAssetId, MicrophoneOffSignalPanelAssetKey, MicrophoneOffSignalPanelAssetKey, "마이크 OFF · 신호 패널", "image/png", MicrophoneOffSignalPanelContentSha256, 538_609, 1_672, 941, false, SignalPanelBuiltInResourceName),
        new(MicrophoneOffScreenprintAssetId, MicrophoneOffScreenprintAssetKey, MicrophoneOffScreenprintAssetKey, "마이크 OFF · 스크린 프린트", "image/png", MicrophoneOffScreenprintContentSha256, 2_378_428, 1_024, 1_536, false, ScreenprintBuiltInResourceName),
        new(RaffleTicketGrantedAssetId, RaffleTicketGrantedAssetKey, RaffleTicketGrantedAssetKey, "추첨권 지급 애니메이션", "image/gif", RaffleTicketGrantedContentSha256, 907_149, 640, 400, false, RaffleTicketGrantedResourceName),
        new(RaffleDrawAssetId, RaffleDrawAssetKey, RaffleDrawAssetKey, "추첨 진행 애니메이션", "image/gif", RaffleDrawContentSha256, 759_930, 640, 640, false, RaffleDrawResourceName),
        new(FlashbangSoftAssetId, FlashbangSoftAssetKey, FlashbangSoftAssetKey, "섬광탄 · 약하게", "image/gif", FlashbangSoftContentSha256, 1_921_621, 1_920, 1_080, false, FlashbangSoftResourceName),
        new(FlashbangStandardAssetId, FlashbangStandardAssetKey, FlashbangStandardAssetKey, "섬광탄 · 보통", "image/gif", FlashbangStandardContentSha256, 1_209_872, 1_920, 1_080, false, FlashbangStandardResourceName),
        new(FlashbangStrongAssetId, FlashbangStrongAssetKey, FlashbangStrongAssetKey, "섬광탄 · 강하게", "image/gif", FlashbangStrongContentSha256, 712_706, 1_920, 1_080, false, FlashbangStrongResourceName),
        new(WaterSplashAssetId, WaterSplashAssetKey, WaterSplashAssetKey, "물벼락", "image/png", WaterSplashContentSha256, 2_987_888, 1_672, 941, false, WaterSplashResourceName),
        new(FireworksAssetId, FireworksAssetKey, FireworksAssetKey, "축포", "image/png", FireworksContentSha256, 1_282_788, 1_672, 941, false, FireworksResourceName),
        new(EarthquakeAudioAssetId, EarthquakeAudioAssetKey, EarthquakeAudioAssetKey, "지진 효과음 연결", "image/svg+xml", EarthquakeAudioContentSha256, 147, 1, 1, false, EarthquakeAudioResourceName)
    ];

    internal static bool TryMapBuiltInAssetIdToKey(string? assetId, out string assetKey)
    {
        assetKey = assetId?.Trim().ToLowerInvariant() switch
        {
            BuiltInAssetId => MicrophoneOffAssetKey,
            MicrophoneOffCenterAssetId => MicrophoneOffCenterAssetKey,
            MicrophoneOffTopLeftAssetId => MicrophoneOffTopLeftAssetKey,
            MicrophoneOffTopRightAssetId => MicrophoneOffTopRightAssetKey,
            MicrophoneOffBadgeAssetId => MicrophoneOffBadgeAssetKey,
            MicrophoneOffQuietAssetId => MicrophoneOffQuietAssetKey,
            MicrophoneOffSignalPanelAssetId => MicrophoneOffSignalPanelAssetKey,
            MicrophoneOffScreenprintAssetId => MicrophoneOffScreenprintAssetKey,
            RaffleTicketGrantedAssetId => RaffleTicketGrantedAssetKey,
            RaffleDrawAssetId => RaffleDrawAssetKey,
            FlashbangSoftAssetId => FlashbangSoftAssetKey,
            FlashbangStandardAssetId => FlashbangStandardAssetKey,
            FlashbangStrongAssetId => FlashbangStrongAssetKey,
            WaterSplashAssetId => WaterSplashAssetKey,
            FireworksAssetId => FireworksAssetKey,
            EarthquakeAudioAssetId => EarthquakeAudioAssetKey,
            _ => ""
        };
        return assetKey.Length > 0;
    }

    internal static bool IsPackagedImageKey(string? assetKey) =>
        !string.IsNullOrWhiteSpace(assetKey)
        && BuiltInDefinitions.Any(item =>
            string.Equals(item.ClientAssetKey, assetKey.Trim(), StringComparison.Ordinal));

    internal IReadOnlyList<VNextOverlayAssetDescriptor> PackagedImageDescriptors() =>
        _builtInsByKey.Values
            .Select(item => item.Descriptor)
            .OrderBy(item => item.DisplayName, StringComparer.CurrentCulture)
            .ToArray();
    private readonly string _rootPath;
    private readonly string _indexPath;
    private readonly long _cacheLimitBytes;
    private readonly Action<string>? _log;
    private readonly object _gate = new();
    private readonly IReadOnlyDictionary<string, BuiltInAsset> _builtInsById;
    private readonly IReadOnlyDictionary<string, BuiltInAsset> _builtInsByKey;
    private Dictionary<string, CacheEntry> _entries = new(StringComparer.OrdinalIgnoreCase);
    private VNextOverlayAssetManifest? _manifest;

    public OverlayAssetCache(string rootPath, Action<string>? log = null, long cacheLimitBytes = DefaultCacheLimitBytes)
    {
        if (string.IsNullOrWhiteSpace(rootPath)) throw new ArgumentException("Cache path is required.", nameof(rootPath));
        if (cacheLimitBytes is < OverlayAssetValidator.MaximumBytes or > 1024L * 1024 * 1024)
            throw new ArgumentOutOfRangeException(nameof(cacheLimitBytes));
        _rootPath = rootPath;
        _indexPath = Path.Combine(rootPath, "index.json");
        _cacheLimitBytes = cacheLimitBytes;
        _log = log;
        Directory.CreateDirectory(rootPath);
        var bytesByResource = new Dictionary<string, byte[]>(StringComparer.Ordinal);
        var builtIns = new List<BuiltInAsset>(BuiltInDefinitions.Length);
        foreach (var definition in BuiltInDefinitions)
        {
            if (!bytesByResource.TryGetValue(definition.ResourceName, out var bytes))
            {
                bytes = ReadEmbeddedResource(definition.ResourceName);
                bytesByResource[definition.ResourceName] = bytes;
            }
            var descriptor = new VNextOverlayAssetDescriptor(
                definition.AssetId,
                definition.ClientAssetKey,
                1,
                definition.DisplayName,
                definition.MimeType,
                OverlayAssetValidator.Sha256Hex(bytes),
                bytes.Length,
                definition.WidthPx,
                definition.HeightPx,
                "agent_builtin",
                definition.Required,
                null);
            OverlayAssetValidator.VerifyBytes(bytes, descriptor);
            if (!string.Equals(descriptor.ContentSha256, definition.ContentSha256, StringComparison.Ordinal)
                || descriptor.ByteSize != definition.ByteSize)
                throw new InvalidDataException("내장 오버레이 이미지의 SHA-256 또는 크기가 일치하지 않습니다.");
            builtIns.Add(new BuiltInAsset(descriptor, bytes));
        }
        _builtInsById = builtIns.ToDictionary(item => item.Descriptor.AssetId, StringComparer.OrdinalIgnoreCase);
        _builtInsByKey = builtIns.ToDictionary(item => item.Descriptor.AssetKey, StringComparer.Ordinal);
        LoadIndex();
    }

    internal static bool TryNormalizeServerBuiltIn(
        string assetId,
        int versionNumber,
        string mimeType,
        string contentSha256,
        int byteSize,
        int widthPx,
        int heightPx,
        ref string assetKey)
    {
        var candidateAssetKey = assetKey;
        var definition = BuiltInDefinitions.FirstOrDefault(item =>
            string.Equals(item.AssetId, assetId, StringComparison.OrdinalIgnoreCase)
            && versionNumber == 1
            && string.Equals(item.MimeType, mimeType, StringComparison.Ordinal)
            && string.Equals(item.ContentSha256, contentSha256, StringComparison.Ordinal)
            && item.ByteSize == byteSize
            && item.WidthPx == widthPx
            && item.HeightPx == heightPx
            && (string.Equals(item.ServerAssetKey, candidateAssetKey, StringComparison.Ordinal)
                || string.Equals(item.ClientAssetKey, candidateAssetKey, StringComparison.Ordinal)));
        if (definition is null) return false;
        assetKey = definition.ClientAssetKey;
        return true;
    }

    public async Task<OverlayAssetCacheSyncResult> SyncAsync(
        VNextOverlayAssetManifest manifest,
        Func<VNextOverlayAssetDescriptor, CancellationToken, Task<byte[]>> download,
        CancellationToken cancellationToken)
    {
        if (manifest.SchemaVersion != 1 || manifest.Assets.Count > 100)
            throw new InvalidDataException("오버레이 이미지 manifest 경계가 올바르지 않습니다.");
        if (manifest.Assets.Select(asset => asset.AssetId).Distinct(StringComparer.OrdinalIgnoreCase).Count() != manifest.Assets.Count)
            throw new InvalidDataException("오버레이 이미지 manifest ID가 중복되었습니다.");
        if (manifest.Assets.Select(asset => (asset.AssetKey, asset.VersionNumber)).Distinct().Count() != manifest.Assets.Count)
            throw new InvalidDataException("오버레이 이미지 manifest 버전이 중복되었습니다.");
        foreach (var asset in manifest.Assets) OverlayAssetValidator.ValidateDescriptor(asset, manifestItem: true);
        if (manifest.Assets.Where(asset => asset.DeliveryMode == "managed_bundle").Sum(asset => (long)asset.ByteSize) > _cacheLimitBytes)
            throw new InvalidDataException("오버레이 이미지 manifest가 로컬 캐시 한도를 초과했습니다.");

        var downloaded = 0;
        var reused = 0;
        var available = 0;
        var unavailable = 0;
        var requiredUnavailable = 0;
        Dictionary<string, CacheEntry> next;
        lock (_gate) next = new Dictionary<string, CacheEntry>(_entries, StringComparer.OrdinalIgnoreCase);

        foreach (var asset in manifest.Assets)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (asset.DeliveryMode == "agent_builtin")
            {
                if (_builtInsById.TryGetValue(asset.AssetId, out var builtIn)
                    && SameContent(builtIn.Descriptor, asset))
                {
                    available++;
                    reused++;
                }
                else
                {
                    unavailable++;
                    if (asset.Required) requiredUnavailable++;
                }
                continue;
            }

            var relativePath = RelativePath(asset);
            var absolutePath = AbsolutePath(relativePath);
            var validExisting = false;
            if (next.TryGetValue(asset.AssetId, out var existing)
                && SameRevision(existing, asset)
                && string.Equals(existing.RelativePath, relativePath, StringComparison.Ordinal))
            {
                try
                {
                    var bytes = await File.ReadAllBytesAsync(absolutePath, cancellationToken);
                    OverlayAssetValidator.VerifyBytes(bytes, asset);
                    next[asset.AssetId] = existing with { LastUsedAt = DateTimeOffset.UtcNow };
                    validExisting = true;
                }
                catch
                {
                    TryDelete(absolutePath);
                    next.Remove(asset.AssetId);
                }
            }
            if (validExisting)
            {
                available++;
                reused++;
                continue;
            }

            try
            {
                var bytes = await download(asset, cancellationToken);
                OverlayAssetValidator.VerifyBytes(bytes, asset);
                await AtomicWriteAsync(absolutePath, bytes, cancellationToken);
                next[asset.AssetId] = CacheEntry.From(asset, relativePath);
                available++;
                downloaded++;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                unavailable++;
                if (asset.Required) requiredUnavailable++;
                _log?.Invoke($"오버레이 이미지 동기화 실패 · key={asset.AssetKey} · {ex.GetType().Name}");
            }
        }

        lock (_gate)
        {
            _entries = next;
            _manifest = manifest;
        }
        var pruned = Prune(manifest);
        await SaveIndexAsync(cancellationToken);
        return new OverlayAssetCacheSyncResult(available, downloaded, reused, unavailable, requiredUnavailable, pruned);
    }

    public bool TryResolve(
        string assetKey,
        VNextOverlayAssetDescriptor? expected,
        out VNextOverlayAssetDescriptor descriptor)
    {
        lock (_gate)
        {
            if (expected is null)
            {
                if (_builtInsByKey.TryGetValue(assetKey, out var builtIn))
                {
                    descriptor = builtIn.Descriptor;
                    return true;
                }
                var required = _manifest?.Assets.FirstOrDefault(asset =>
                    asset.Required && string.Equals(asset.AssetKey, assetKey, StringComparison.Ordinal));
                if (required is null)
                {
                    descriptor = null!;
                    return false;
                }
                expected = required;
            }

            if (!string.Equals(assetKey, expected.AssetKey, StringComparison.Ordinal))
            {
                descriptor = null!;
                return false;
            }
            if (expected.DeliveryMode == "agent_builtin")
            {
                descriptor = expected;
                return _builtInsById.TryGetValue(expected.AssetId, out var builtIn)
                    && SameContent(builtIn.Descriptor, expected);
            }
            if (_entries.TryGetValue(expected.AssetId, out var entry) && SameRevision(entry, expected))
            {
                descriptor = expected;
                return true;
            }
            descriptor = null!;
            return false;
        }
    }

    public bool TryResolveByAssetId(
        string assetId,
        string expectedContentSha256,
        out VNextOverlayAssetDescriptor descriptor)
    {
        if (!Guid.TryParseExact(assetId?.Trim(), "D", out var parsed)
            || expectedContentSha256 is null
            || expectedContentSha256.Length != 64)
        {
            descriptor = null!;
            return false;
        }
        var normalized = parsed.ToString("D");
        lock (_gate)
        {
            if (_builtInsById.TryGetValue(normalized, out var builtIn))
            {
                if (!string.Equals(
                        builtIn.Descriptor.ContentSha256,
                        expectedContentSha256,
                        StringComparison.Ordinal))
                {
                    descriptor = null!;
                    return false;
                }
                descriptor = builtIn.Descriptor;
                return true;
            }
            var expected = _manifest?.Assets.FirstOrDefault(asset =>
                string.Equals(asset.AssetId, normalized, StringComparison.OrdinalIgnoreCase));
            if (expected is not null
                && expected.DeliveryMode == "managed_bundle"
                && _entries.TryGetValue(expected.AssetId, out var entry)
                && SameRevision(entry, expected)
                && string.Equals(
                    expected.ContentSha256,
                    expectedContentSha256,
                    StringComparison.Ordinal))
            {
                descriptor = expected;
                return true;
            }
            descriptor = null!;
            return false;
        }
    }

    public OverlayAssetContent Read(VNextOverlayAssetDescriptor descriptor)
    {
        OverlayAssetValidator.ValidateDescriptor(descriptor, manifestItem: false);
        if (descriptor.DeliveryMode == "agent_builtin")
        {
            if (!_builtInsById.TryGetValue(descriptor.AssetId, out var builtIn)
                || !SameContent(builtIn.Descriptor, descriptor))
                throw new FileNotFoundException("내장 오버레이 이미지 버전이 일치하지 않습니다.");
            // 표시 직전에도 ID/SHA/크기/이미지 안전성 계약을 다시 확인하고,
            // 내부 고정 바이트가 외부 호출자에게 노출되지 않도록 복사합니다.
            OverlayAssetValidator.VerifyBytes(builtIn.Bytes, descriptor);
            return new OverlayAssetContent(descriptor, builtIn.Bytes.ToArray(), descriptor.MimeType);
        }

        CacheEntry entry;
        lock (_gate)
        {
            if (!_entries.TryGetValue(descriptor.AssetId, out var found) || !SameRevision(found, descriptor))
                throw new FileNotFoundException("동기화된 오버레이 이미지를 찾지 못했습니다.");
            entry = found;
        }
        try
        {
            var bytes = File.ReadAllBytes(AbsolutePath(entry.RelativePath));
            OverlayAssetValidator.VerifyBytes(bytes, descriptor);
            lock (_gate)
            {
                if (_entries.TryGetValue(descriptor.AssetId, out var current) && SameRevision(current, descriptor))
                    _entries[descriptor.AssetId] = current with { LastUsedAt = DateTimeOffset.UtcNow };
            }
            return new OverlayAssetContent(descriptor, bytes, descriptor.MimeType);
        }
        catch (Exception ex)
        {
            var removed = false;
            lock (_gate)
            {
                // 동시 sync가 더 새 exact revision을 교체했다면 그 항목은 제거하지
                // 않습니다. 파일도 삭제하지 않아 atomic replace 직후의 새 검증본을
                // TOCTOU 무효화가 지우는 경합을 피합니다.
                if (_entries.TryGetValue(descriptor.AssetId, out var current)
                    && SameRevision(current, descriptor)
                    && current.VerifiedAt == entry.VerifiedAt)
                {
                    _entries.Remove(descriptor.AssetId);
                    removed = true;
                }
            }
            if (removed)
                _log?.Invoke($"표시 직전 손상된 오버레이 이미지 제거 · asset={descriptor.AssetId} · {ex.GetType().Name}");
            throw new InvalidDataException("오버레이 이미지가 표시 직전 exact 검증을 통과하지 못했습니다.", ex);
        }
    }

    public bool RequiredReady()
    {
        lock (_gate)
        {
            if (_manifest is null) return true;
            return _manifest.Assets.Where(asset => asset.Required).All(asset =>
                asset.DeliveryMode == "agent_builtin"
                    ? _builtInsById.TryGetValue(asset.AssetId, out var builtIn)
                        && SameContent(builtIn.Descriptor, asset)
                    : _entries.TryGetValue(asset.AssetId, out var entry) && SameRevision(entry, asset));
        }
    }

    public OverlayAssetCacheStatus Status()
    {
        lock (_gate)
        {
            return new OverlayAssetCacheStatus(
                _manifest?.GeneratedAt,
                _builtInsById.Count,
                _entries.Count,
                _entries.Values.Sum(entry => (long)entry.ByteSize),
                RequiredReady());
        }
    }

    public async Task<IReadOnlyList<VNextReadyOverlayAsset>> ReadyRevisionsAsync(
        CancellationToken cancellationToken = default)
    {
        CacheEntry[] snapshot;
        lock (_gate) snapshot = _entries.Values.ToArray();

        var ready = _builtInsById.Values
            .Select(item => new VNextReadyOverlayAsset(
                item.Descriptor.AssetId,
                item.Descriptor.ContentSha256))
            .ToList();
        var indexChanged = false;
        foreach (var entry in snapshot)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                var descriptor = entry.ToDescriptor();
                var bytes = await File.ReadAllBytesAsync(AbsolutePath(entry.RelativePath), cancellationToken);
                OverlayAssetValidator.VerifyBytes(bytes, descriptor);
                ready.Add(new VNextReadyOverlayAsset(
                    descriptor.AssetId.ToLowerInvariant(),
                    descriptor.ContentSha256));
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                lock (_gate)
                {
                    if (_entries.TryGetValue(entry.AssetId, out var current)
                        && SameRevision(current, entry.ToDescriptor())
                        && current.VerifiedAt == entry.VerifiedAt)
                    {
                        _entries.Remove(entry.AssetId);
                        indexChanged = true;
                    }
                }
                _log?.Invoke($"손상된 오버레이 이미지 준비 상태 제거 · asset={entry.AssetId} · {ex.GetType().Name}");
            }
        }
        if (indexChanged) await SaveIndexAsync(cancellationToken);
        return ready.OrderBy(item => item.AssetId, StringComparer.Ordinal).ToArray();
    }

    private void LoadIndex()
    {
        try
        {
            if (!File.Exists(_indexPath)) return;
            var index = JsonSerializer.Deserialize<CacheIndex>(File.ReadAllText(_indexPath));
            if (index is null || index.SchemaVersion != 2) throw new InvalidDataException("캐시 인덱스 버전이 올바르지 않습니다.");
            if (index.Manifest is null
                || index.Manifest.SchemaVersion != 1
                || index.Manifest.Assets.Count > 100
                || index.Manifest.Assets.Select(asset => asset.AssetId).Distinct(StringComparer.OrdinalIgnoreCase).Count() != index.Manifest.Assets.Count
                || index.Manifest.Assets.Select(asset => (asset.AssetKey, asset.VersionNumber)).Distinct().Count() != index.Manifest.Assets.Count)
                throw new InvalidDataException("캐시 manifest가 올바르지 않습니다.");
            foreach (var asset in index.Manifest.Assets)
                OverlayAssetValidator.ValidateDescriptor(asset, manifestItem: true);
            var loaded = new Dictionary<string, CacheEntry>(StringComparer.OrdinalIgnoreCase);
            foreach (var entry in index.Entries ?? [])
            {
                try
                {
                    var descriptor = entry.ToDescriptor();
                    OverlayAssetValidator.ValidateDescriptor(descriptor, manifestItem: false);
                    if (entry.DeliveryMode != "managed_bundle"
                        || !string.Equals(entry.RelativePath, RelativePath(descriptor), StringComparison.Ordinal))
                        continue;
                    var bytes = File.ReadAllBytes(AbsolutePath(entry.RelativePath));
                    OverlayAssetValidator.VerifyBytes(bytes, descriptor);
                    loaded[entry.AssetId] = entry;
                }
                catch (Exception ex)
                {
                    // 인덱스의 다른 exact entry와 manifest는 보존하되 손상된 한
                    // revision만 readiness에서 제외합니다.
                    try
                    {
                        _log?.Invoke($"시작 시 손상된 오버레이 이미지 제외 · asset={entry.AssetId} · {ex.GetType().Name}");
                    }
                    catch
                    {
                        // 진단 기록 실패가 manifest/readiness 경계를 다시 열면 안 됩니다.
                    }
                }
            }
            _entries = loaded;
            _manifest = index.Manifest;
        }
        catch (Exception ex)
        {
            _entries.Clear();
            _log?.Invoke("오버레이 이미지 캐시 인덱스 무시 · " + ex.GetType().Name);
        }
    }

    private async Task SaveIndexAsync(CancellationToken cancellationToken)
    {
        CacheIndex index;
        lock (_gate)
            index = new CacheIndex(
                2,
                DateTimeOffset.UtcNow,
                _manifest,
                _entries.Values.OrderBy(entry => entry.AssetId).ToArray());
        var bytes = JsonSerializer.SerializeToUtf8Bytes(index, new JsonSerializerOptions { WriteIndented = true });
        await AtomicWriteAsync(_indexPath, bytes, cancellationToken);
    }

    private int Prune(VNextOverlayAssetManifest manifest)
    {
        HashSet<string> protectedIds = manifest.Assets
            .Where(asset => asset.DeliveryMode == "managed_bundle")
            .Select(asset => asset.AssetId)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        lock (_gate)
        {
            var total = _entries.Values.Sum(entry => (long)entry.ByteSize);
            if (total <= _cacheLimitBytes) return 0;
            var pruned = 0;
            foreach (var entry in _entries.Values
                .Where(entry => !protectedIds.Contains(entry.AssetId))
                .OrderBy(entry => entry.LastUsedAt)
                .ToArray())
            {
                if (total <= _cacheLimitBytes) break;
                TryDelete(AbsolutePath(entry.RelativePath));
                _entries.Remove(entry.AssetId);
                total -= entry.ByteSize;
                pruned++;
            }
            return pruned;
        }
    }

    private static bool SameContent(VNextOverlayAssetDescriptor left, VNextOverlayAssetDescriptor right) =>
        left.AssetId.Equals(right.AssetId, StringComparison.OrdinalIgnoreCase)
        && left.AssetKey == right.AssetKey
        && left.VersionNumber == right.VersionNumber
        && left.MimeType == right.MimeType
        && left.ContentSha256 == right.ContentSha256
        && left.ByteSize == right.ByteSize
        && left.WidthPx == right.WidthPx
        && left.HeightPx == right.HeightPx
        && left.DeliveryMode == right.DeliveryMode;

    private sealed record BuiltInDefinition(
        string AssetId,
        string ServerAssetKey,
        string ClientAssetKey,
        string DisplayName,
        string MimeType,
        string ContentSha256,
        int ByteSize,
        int WidthPx,
        int HeightPx,
        bool Required,
        string ResourceName);

    private sealed record BuiltInAsset(
        VNextOverlayAssetDescriptor Descriptor,
        byte[] Bytes);

    private static bool SameRevision(CacheEntry entry, VNextOverlayAssetDescriptor asset) =>
        entry.AssetId.Equals(asset.AssetId, StringComparison.OrdinalIgnoreCase)
        && entry.AssetKey == asset.AssetKey
        && entry.VersionNumber == asset.VersionNumber
        && entry.MimeType == asset.MimeType
        && entry.ContentSha256 == asset.ContentSha256
        && entry.ByteSize == asset.ByteSize
        && entry.WidthPx == asset.WidthPx
        && entry.HeightPx == asset.HeightPx
        && entry.DeliveryMode == asset.DeliveryMode;

    private static string Extension(string mimeType) => mimeType switch
    {
        "image/svg+xml" => "svg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => throw new InvalidDataException("지원하지 않는 오버레이 이미지 MIME입니다.")
    };

    private static string RelativePath(VNextOverlayAssetDescriptor asset) =>
        $"assets/{asset.AssetId.ToLowerInvariant()}/v{asset.VersionNumber}/{asset.ContentSha256}.{Extension(asset.MimeType)}";

    private string AbsolutePath(string relativePath)
    {
        var segments = relativePath.Split('/');
        return segments.Aggregate(_rootPath, Path.Combine);
    }

    private static async Task AtomicWriteAsync(string path, ReadOnlyMemory<byte> bytes, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            await using (var stream = new FileStream(
                temporary,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                64 * 1024,
                FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                await stream.WriteAsync(bytes, cancellationToken);
                await stream.FlushAsync(cancellationToken);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporary, path, overwrite: true);
        }
        finally
        {
            TryDelete(temporary);
        }
    }

    private static void TryDelete(string path)
    {
        try { File.Delete(path); } catch (FileNotFoundException) { } catch (DirectoryNotFoundException) { }
    }

    private static byte[] ReadEmbeddedResource(string resourceName)
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException($"Embedded overlay resource is missing: {resourceName}");
        using var memory = new MemoryStream();
        stream.CopyTo(memory);
        return memory.ToArray();
    }

    private sealed record CacheIndex(
        int SchemaVersion,
        DateTimeOffset UpdatedAt,
        VNextOverlayAssetManifest? Manifest,
        CacheEntry[]? Entries);

    private sealed record CacheEntry(
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
        string RelativePath,
        DateTimeOffset VerifiedAt,
        DateTimeOffset LastUsedAt)
    {
        public static CacheEntry From(VNextOverlayAssetDescriptor asset, string relativePath)
        {
            var now = DateTimeOffset.UtcNow;
            return new CacheEntry(
                asset.AssetId,
                asset.AssetKey,
                asset.VersionNumber,
                asset.DisplayName,
                asset.MimeType,
                asset.ContentSha256,
                asset.ByteSize,
                asset.WidthPx,
                asset.HeightPx,
                asset.DeliveryMode,
                relativePath,
                now,
                now);
        }

        public VNextOverlayAssetDescriptor ToDescriptor() => new(
            AssetId,
            AssetKey,
            VersionNumber,
            DisplayName,
            MimeType,
            ContentSha256,
            ByteSize,
            WidthPx,
            HeightPx,
            DeliveryMode,
            false,
            null);
    }
}
