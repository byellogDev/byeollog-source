import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = path => readFile(new URL(path, root), "utf8");

test("next roulette reward multiplier is a direct numeric, same-donor, one-use action", async () => {
  const [ui, client, contract] = await Promise.all([
    source("Ui/agent_automation.html"),
    source("VNextAutomationClient.cs"),
    source("VNextAutomationRpcContract.cs")
  ]);

  assert.match(ui, /다음 룰렛 보상 증가/);
  assert.match(ui, /id="rewardMultiplier"[^>]+type="number"[^>]+min="2"[^>]+max="100"/);
  assert.match(ui, /id="allowMultiplierStacking"[^>]+type="checkbox"/);
  assert.match(ui, /같은 후원자의 다음 실제 룰렛 보상 1회/);
  assert.match(ui, /연속 증가 결과의 배수를 중첩 적용/);
  assert.match(ui, /연속 증가 결과는 배수를 중첩합니다/);
  assert.match(ui, /연속 증가 결과는 가장 최근 배수로 갱신합니다/);

  assert.match(client, /save_guided_rule_v13/);
  assert.match(client, /"roulette\.reward_multiplier_next"/);
  assert.match(client, /RequiredInt\(payload, "rewardMultiplier", 2, 100, "배수 설정"\)/);
  assert.match(client, /OptionalBool\(payload, "allowMultiplierStacking", false\)/);
  assert.match(contract, /JsonPropertyName\("p_reward_multiplier"\)/);
  assert.match(contract, /JsonPropertyName\("p_allow_multiplier_stacking"\)/);
});

test("multiplied Abong duration is bounded to fifteen minutes while the saved base stays at 240 seconds", async () => {
  const [core, client, ui] = await Promise.all([
    source("TimedMuteActionCore.cs"),
    source("VNextAutomationClient.cs"),
    source("Ui/agent_automation.html")
  ]);
  assert.match(core, /MaximumDurationMs = 900_000/);
  assert.match(client, /RequiredInt\(payload, "durationSeconds", 1, 240, "음소거 시간"\)/);
  assert.match(ui, /durationSeconds[^\n]+max="240"/);
});
