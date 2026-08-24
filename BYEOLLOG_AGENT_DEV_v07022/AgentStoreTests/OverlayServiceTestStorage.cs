namespace HurogiCollector;

// ByeollogOverlayService의 동시성 계약만 독립 실행하기 위한 최소 test double입니다.
// 실제 Agent 프로젝트에서는 production CollectorStorage가 사용됩니다.
internal sealed class CollectorStorage
{
    public void Log(string message)
    {
    }
}
