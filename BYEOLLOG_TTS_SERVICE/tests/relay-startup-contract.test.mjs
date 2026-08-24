import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const start = fs.readFileSync(path.join(root, "Start-ByeollogTtsRelay.ps1"), "utf8");
const configure = fs.readFileSync(path.join(root, "Configure-ByeollogTtsRelay.ps1"), "utf8");

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
  assert.match(configure, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(configure, /wrangler@4\.125\.0 secret put ADMIN_SECRET/);
  assert.doesNotMatch(configure, /Write-(?:Host|Output).*\$secret/i);
});
