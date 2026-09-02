import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("Realtime is a private wake hint while authenticated claim remains authoritative", async () => {
  const [listener, agent, client] = await Promise.all([
    readFile(new URL("VNextRealtimeWakeListener.cs", root), "utf8"),
    readFile(new URL("VNextLocalAgent.cs", root), "utf8"),
    readFile(new URL("VNextDevelopmentClient.cs", root), "utf8")
  ]);

  assert.match(listener, /wss:\/\//);
  assert.match(listener, /\/realtime\/v1\/websocket\?apikey=/);
  assert.match(listener, /agent-wake:/);
  assert.match(listener, /@private = true/);
  assert.match(listener, /access_token = credentials\.AccessToken/);
  assert.match(listener, /HeartbeatInterval = TimeSpan\.FromSeconds\(20\)/);
  assert.match(listener, /MaximumMessageBytes = 64 \* 1024/);
  assert.match(listener, /broadcastEvent == "wallpaper_changed"/);
  assert.match(listener, /_wallpaperWake\(\)/);
  assert.match(listener, /SetConnected\(true\);[\s\S]{0,500}_wake\(\);[\s\S]{0,500}_wallpaperWake\(\);/);
  assert.match(listener, /broadcastEvent != "execution_changed"/);
  assert.doesNotMatch(listener, /actionParams|action_params|deviceSecret|device_secret/);

  assert.match(agent, /RealtimeConnectedRecoveryInterval = TimeSpan\.FromSeconds\(30\)/);
  assert.match(agent, /RealtimeDisconnectedClaimFallback = TimeSpan\.FromSeconds\(2\)/);
  assert.match(agent, /WallpaperRecoveryInterval = TimeSpan\.FromMinutes\(10\)/);
  assert.match(agent, /DeviceStatusInterval = TimeSpan\.FromMinutes\(4\)/);
  assert.match(agent, /OverlayAssetSyncInterval = TimeSpan\.FromHours\(6\)/);
  assert.match(agent, /_wakeListener\.Connected[\s\S]{0,120}RealtimeConnectedRecoveryInterval[\s\S]{0,120}RealtimeDisconnectedClaimFallback/);
  assert.match(agent, /ClaimAgentExecutionWithWallpaperAsync/);
  assert.match(agent, /ScheduleDirectWallpaperSync/);
  assert.match(agent, /GetWallpaperSnapshotAsync/);
  assert.match(agent, /WallpaperSyncRequestTracker _wallpaperRequests/);
  assert.match(agent, /HasPendingAgentExecutionAsync/);
  assert.match(agent, /knownWallpaperRevision:\s*null/);
  assert.match(agent, /RequestWallpaperSync\(\)[\s\S]{0,500}ScheduleDirectWallpaperSync/);
  assert.match(agent, /DateTimeOffset\.UtcNow >= _nextWallpaperSyncAtUtc[\s\S]{0,160}_wallpaperRequests\.Request\(\)/);
  assert.match(agent, /_nextWallpaperSyncAtUtc = DateTimeOffset\.UtcNow \+ WallpaperRecoveryInterval/);
  assert.match(agent, /CompleteThrough\(requestGeneration\)/);
  assert.match(agent, /if \(applied && _wallpaperRequests\.Pending\)[\s\S]{0,160}ScheduleDirectWallpaperSync/);
  assert.match(client, /g3a_agent_direct_pending_v1/);
  assert.match(client, /g3a_agent_direct_wallpaper_snapshot_v1/);
  assert.match(agent, /_wakeListener\.Start\(\)/);
  assert.match(agent, /_wakeListener\.Reconnect\(\)/);
  assert.match(agent, /_wakeListener\.Dispose\(\)/);

  assert.match(client, /GetRealtimeCredentialsAsync/);
  assert.match(client, /GetValidAccessTokenAsync/);
  assert.match(client, /IsSessionEpochCurrent\(epoch\)/);
});
