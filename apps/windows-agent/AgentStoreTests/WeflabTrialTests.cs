using System.Text.Json;

namespace HurogiCollector;

internal static partial class Program
{
    private static void WeflabTrialProtocolTests()
    {
        JsonElement Assess(string json,int count=1)=>JsonSerializer.SerializeToElement(WeflabTrialProtocol.Assess(json,count));
        var stored=Assess("{\"result\":\"success\",\"api\":\"sql\",\"data\":\"꽝\"}");
        Equal("stored_result_observed",stored.GetProperty("status").GetString(),"SQL stored result accepted");
        Equal("꽝",stored.GetProperty("results")[0].GetString(),"Korean result preserved");
        var save=Assess("{\"result\":\"success\",\"api\":\"save\",\"data\":\"꽝\"}");
        Equal("possible_result_generation",save.GetProperty("reason").GetString(),"save is generation warning");
        Equal("needs_review",Assess("{\"result\":\"success\",\"api\":\"sql\",\"data\":\"\"}").GetProperty("status").GetString(),"blank rejected");
        Equal("needs_review",Assess("{\"result\":\"success\",\"api\":\"mem\",\"data\":\"꽝\"}",2).GetProperty("status").GetString(),"missing spin rejected");
        Equal("needs_review",Assess("bad-json").GetProperty("status").GetString(),"invalid JSON rejected");
        var multi=Assess("{\"result\":\"success\",\"api\":\"mem\",\"list\":\"[[\\\"꽝\\\",90],[\\\"당첨\\\",10]]\"}",2);
        Equal("stored_result_observed",multi.GetProperty("status").GetString(),"multi result accepted");
        Equal("당첨",multi.GetProperty("results")[1].GetString(),"spin order preserved");
    }
}
