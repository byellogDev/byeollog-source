import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const start = fs.readFileSync(path.join(root, "Start-ByeollogTtsRelay.ps1"), "utf8");
const startLocal = fs.readFileSync(path.join(root, "Start-ByeollogTtsLocal.ps1"), "utf8");
const configure = fs.readFileSync(path.join(root, "Configure-ByeollogTtsRelay.ps1"), "utf8");
const install = fs.readFileSync(path.join(root, "Install-ByeollogTtsStartup.ps1"), "utf8");
const status = fs.readFileSync(path.join(root, "Get-ByeollogTtsStatus.ps1"), "utf8");

test("relay startup accepts only Quick Tunnel origins and signs exact bodies", () => {
  assert.match(start, /trycloudflare\\\.com/);
  assert.match(start, /x-byeollog-timestamp/);
  assert.match(start, /x-byeollog-nonce/);
  assert.match(start, /x-byeollog-signature/);
  assert.match(start, /HMACSHA256/);
  assert.match(start, /ConvertTo-Json -Compress/);
});

test("relay secret is random, DPAPI protected, ACL restricted, and never printed", () => {
  assert.match(configure, /New-Object byte\[\] 32/);
  assert.match(configure, /RandomNumberGenerator\]::Create\(\)/);
  assert.match(configure, /DataProtectionScope\]::CurrentUser/);
  assert.match(configure, /\/inheritance:r/);
  assert.match(configure, /identity\.User\.Value/);
  assert.match(configure, /S-1-5-18:\(F\)/);
  assert.match(configure, /wrangler@4\.125\.0' 'secret' 'bulk'/);
  assert.doesNotMatch(configure, /Write-(?:Host|Output).*\$secret/i);
});

test("startup survives a stopped Docker engine and periodically repairs the full relay path", () => {
  assert.match(startLocal, /Diagnostics\.ProcessStartInfo/);
  assert.match(startLocal, /RedirectStandardError\s*=\s*\$true/);
  assert.match(startLocal, /catch\s*\{\s*return \$false\s*\}/);
  assert.match(startLocal, /Get-HealthyRelaySnapshot/);
  assert.match(startLocal, /Stable TTS relay is already healthy; refresh skipped\./);
  assert.match(install, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(install, /-RepetitionInterval \(\[TimeSpan\]::FromMinutes\(\$RepairIntervalMinutes\)\)/);
  assert.match(install, /-RepetitionDuration \(\[TimeSpan\]::FromDays\(\$RepairDurationDays\)\)/);
  assert.match(install, /-Trigger \$triggers/);
});

test("status keeps relay metadata visible when proxied health is unavailable", () => {
  const healthIndex = status.indexOf('$relayHealth = Invoke-RestMethod');
  const metaIndex = status.indexOf('$relayMeta = Invoke-RestMethod');
  assert.ok(healthIndex > 0 && metaIndex > healthIndex);
  assert.match(status.slice(healthIndex, metaIndex), /catch\s*\{\s*\}/);
});
