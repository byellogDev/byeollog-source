namespace HurogiCollector;

/// <summary>
/// 사용자 표시명은 별록 에이전트로 전환하되, 서버·설치·데이터 호환 식별자는 유지합니다.
/// </summary>
internal static class BuildInfo
{
    // Installer/wire identity remains numeric for the existing immutable
    // release-manifest and legacy Collector version parsers.
    internal const string Version = "0.7.0.74";
    internal const string InformationalVersion = "0.7.0.74";
    internal const string DisplayVersion = "0.7.0.74";
    internal const string ProductName = "별록 에이전트";
    internal const string EnglishProductName = "BYEOLLOG AGENT";
    // readonly로 두어 일반 배포에서는 숨기되 컴파일러가 해당 분기 자체를 제거하지 않게 합니다.
    internal static readonly bool ShowInternalTesterTools = false;
}
