namespace HurogiCollector;

/// <summary>
/// 방송 프로그램의 마이크 상태를 바꾸거나 확인하는 진단이 서로 겹치지 않도록 합니다.
/// OBS와 Windows 캡처 장치 어댑터는 반드시 같은 게이트를 사용합니다.
/// </summary>
internal static class BroadcastMutationGate
{
    internal static readonly SemaphoreSlim Gate = new(1, 1);
}
