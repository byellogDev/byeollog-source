using System.Text.Json;

namespace HurogiCollector;

internal static partial class Program
{
    private static async Task WallpaperBaekdusanTestsAsync(string root)
    {
        const string session = "11111111-1111-4111-8111-111111111111";
        const string other = "22222222-2222-4222-8222-222222222222";
        WallpaperBaekdusan.Tip Tip(int seq, int amount, string room = session) =>
            new($"00000000-0000-4000-8000-{seq:D12}", room, seq, "참여자 " + seq, amount, "2026-09-29T01:00:00Z");
        var run = new WallpaperBaekdusan.Run(Guid.NewGuid().ToString(), session, 31, 34, [Tip(1, 31)]);
        var advanced = WallpaperBaekdusan.Advance(run, [Tip(2,33),Tip(3,32),Tip(4,100),Tip(5,33),Tip(6,33),Tip(7,34,other),Tip(8,34)], false,false,8);
        Equal("1,3,5,8",string.Join(',',advanced.Members.Select(t=>t.SequenceNo)),"only next number after preceding selected tip; mixed donors and intervening amounts allowed");
        Equal(4,WallpaperBaekdusan.Advance(advanced,advanced.Members,false,false,8).Members.Count,"duplicate replay does not add twice");
        WallpaperBaekdusan.Validate([advanced]);
        var partial=WallpaperBaekdusan.Advance(run,[Tip(3,32)],true,true,3);
        Equal(false,partial.Closed,"closed historical broadcast still drains all pages");
        var closed=WallpaperBaekdusan.Advance(partial,[],true,false,3);
        Equal(true,closed.Closed,"closed incomplete broadcast remains partial");
        Equal(2,closed.Members.Count,"missing number never marked filled");

        var path=Path.Combine(root,"baekdusan");Directory.CreateDirectory(path);
        var calls=0;var page=0;
        Task<JsonElement> Send(JsonElement? body,CancellationToken token)
        {
            calls++;var b=body!.Value;
            if(b.TryGetProperty("tileId",out _))return Task.FromResult(JsonSerializer.SerializeToElement(new {tiles=new[]{new {id=Tip(1,31).Id,sessionId=session,sequenceNo=1,actorName="참여자",amount=31,receivedAt="2026-09-29T00:00:00Z"}}}));
            page++;
            return Task.FromResult(JsonSerializer.SerializeToElement(new {closed=page>1,hasMore=page==1,nextSequence=page==1?3:8,
                tiles=page==1?new[]{Tip(2,33),Tip(3,32)}:new[]{Tip(5,33),Tip(8,34)}},new JsonSerializerOptions{PropertyNamingPolicy=JsonNamingPolicy.CamelCase}));
        }
        using(var state=new WallpaperBaekdusan(path,()=>true,Send,()=>{},false))
        {
            await state.PollOnceAsync(CancellationToken.None);Equal(0,calls,"no run means no extra network request");
            await state.SelectAsync(JsonSerializer.SerializeToElement(new {selectedSessionIds=new[]{session}}),CancellationToken.None);
            await state.ControlAsync(JsonSerializer.SerializeToElement(new {action="baekdusan-create",sessionId=session,tileId=Tip(1,31).Id,target=34}),CancellationToken.None);
            await state.PollOnceAsync(CancellationToken.None);
            Equal(2,state.View.GetProperty("runs")[0].GetProperty("members").GetArrayLength(),"first history page filled");
            try { await state.ControlAsync(JsonSerializer.SerializeToElement(new {action="baekdusan-create",sessionId=session,tileId=Tip(1,31).Id,target=34}),CancellationToken.None);throw new Exception("duplicate accepted"); }
            catch(InvalidDataException){_assertions++;}
        }
        using(var state=new WallpaperBaekdusan(path,()=>true,Send,()=>{},false))
        {
            Equal(2,state.View.GetProperty("runs")[0].GetProperty("members").GetArrayLength(),"restart keeps members and paged cursor");
            await state.PollOnceAsync(CancellationToken.None);
            Equal(4,state.View.GetProperty("runs")[0].GetProperty("members").GetArrayLength(),"restarted run resumes history and completes");
            var before=calls;await state.PollOnceAsync(CancellationToken.None);Equal(before,calls,"completed run stops polling");
            var id=state.View.GetProperty("runs")[0].GetProperty("id").GetString();
            await state.ControlAsync(JsonSerializer.SerializeToElement(new {action="baekdusan-layout",id,x=960,y=520,width=960,height=560,columns=10}),CancellationToken.None);
            Equal(960,state.View.GetProperty("runs")[0].GetProperty("x").GetInt32(),"region can reach right boundary");
            await state.ControlAsync(JsonSerializer.SerializeToElement(new {action="baekdusan-remove",id}),CancellationToken.None);
            Equal(0,state.View.GetProperty("runs").GetArrayLength(),"ungroup clears only local membership");
        }
        var separate=Path.Combine(root,"baekdusan-other");Directory.CreateDirectory(separate);
        using(var state=new WallpaperBaekdusan(separate,()=>true,Send,()=>{},false))Equal(0,state.View.GetProperty("runs").GetArrayLength(),"workspace files are separate");
        foreach(var invalid in new[]{run with {Target=531},run with {Width=1921},run with {Columns=0},run with {Members=[Tip(1,31),Tip(2,33)]}})
        {
            try { WallpaperBaekdusan.Validate([invalid]);throw new Exception("invalid run accepted"); }
            catch(InvalidDataException){_assertions++;}
        }
        File.WriteAllText(Path.Combine(path,"wallpaper-baekdusan-v1.json"),"{broken");
        using(var state=new WallpaperBaekdusan(path,()=>true,Send,()=>{},false))
        {
            await state.SelectAsync(JsonSerializer.SerializeToElement(new {selectedSessionIds=new[]{session}}),CancellationToken.None);
            Equal("{broken",File.ReadAllText(Path.Combine(path,"wallpaper-baekdusan-v1.json")),"corrupt evidence is not overwritten");
        }
        var racingPath=Path.Combine(root,"baekdusan-race");Directory.CreateDirectory(racingPath);
        var entered=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release=new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        async Task<JsonElement> Delayed(JsonElement? body,CancellationToken token)
        {
            if(body!.Value.TryGetProperty("tileId",out _))return await Send(body,token);
            entered.TrySetResult();return await release.Task.WaitAsync(token);
        }
        using(var state=new WallpaperBaekdusan(racingPath,()=>true,Delayed,()=>{},false))
        {
            await state.ControlAsync(JsonSerializer.SerializeToElement(new {action="baekdusan-create",sessionId=session,tileId=Tip(1,31).Id,target=34}),CancellationToken.None);
            var poll=state.PollOnceAsync(CancellationToken.None);await entered.Task;
            var id=state.View.GetProperty("runs")[0].GetProperty("id").GetString();
            await state.ControlAsync(JsonSerializer.SerializeToElement(new {action="baekdusan-remove",id}),CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(2));
            Equal(0,state.View.GetProperty("runs").GetArrayLength(),"slow background read cannot block ungroup");
            release.SetResult(JsonSerializer.SerializeToElement(new {closed=false,hasMore=false,nextSequence=3,tiles=new[]{Tip(3,32)}},new JsonSerializerOptions{PropertyNamingPolicy=JsonNamingPolicy.CamelCase}));
            await poll;
            Equal(0,state.View.GetProperty("runs").GetArrayLength(),"late read cannot resurrect a removed run");
        }
        var contextRoot=Path.Combine(root,"baekdusan-context");
        var scoped=Path.Combine(contextRoot,"wallpaper-workspaces-v1",session);Directory.CreateDirectory(scoped);
        File.WriteAllText(Path.Combine(scoped,"wallpaper-baekdusan-v1.json"),JsonSerializer.Serialize(new {runs=new[]{run},selected=new[]{session}},new JsonSerializerOptions{PropertyNamingPolicy=JsonNamingPolicy.CamelCase}));
        var prior=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var requested=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var count=0;
        using(var context=new WallpaperWorkspaceContext(contextRoot,session,()=>true,(_,_)=>
        {
            Interlocked.Increment(ref count);requested.TrySetResult();
            return Task.FromResult(JsonSerializer.SerializeToElement(new {closed=true,hasMore=false,nextSequence=1,tiles=Array.Empty<object>()}));
        },()=>1,_=>{},()=>{},priorRetirement:prior.Task))
        {
            var preparing=context.PrepareAsync(CancellationToken.None);
            Equal(false,preparing.IsCompleted,"workspace waits for prior retirement");
            Equal(0,count,"restored run cannot start before workspace preparation");
            prior.SetResult();await preparing;await requested.Task.WaitAsync(TimeSpan.FromSeconds(2));
            Equal(true,count>0,"restored run starts after workspace preparation");
        }
    }
}
