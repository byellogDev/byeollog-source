import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");

test("automatic updates require a pinned offline signature and immutable version install", async () => {
  const [core, program, launcher, release, signer] = await Promise.all([
    source("AgentUpdateCore.cs"),
    source("Program.cs"),
    source("Byeollog-Launcher.ps1"),
    source("RELEASE_v07032_AUTO_UPDATE_BOOTSTRAP_KO.txt"),
    source("New-AgentUpdateCatalog.ps1")
  ]);

  assert.match(core, /CatalogUrl = "https:\/\/byeollog\.com\/agent-updates\/stable\/win-x64\.json"/);
  assert.match(core, /LegacyKeyId = "rsa3072-[0-9a-f]{16}"/);
  assert.match(core, /PrimaryKeyId = "rsa3072-[0-9a-f]{16}"/);
  assert.match(core, /RecoveryKeyId = "rsa3072-[0-9a-f]{16}"/);
  assert.match(core, /VerifyCatalogWithPinnedTrust/);
  assert.match(core, /VerifyPinnedKeySelfTest/);
  assert.match(core, /RSASignaturePadding\.Pss/);
  assert.match(core, /VerifyData\(/);
  assert.match(core, /AllowAutoRedirect = false/);
  assert.match(core, /AutomaticDecompression = DecompressionMethods\.None/);
  assert.match(core, /packageUri\.IdnHost, "byeollog\.com"/);
  assert.match(core, /CryptographicOperations\.FixedTimeEquals/);
  assert.match(core, /\.staging-update-/);
  assert.match(core, /Directory\.Move\(staging, target\)/);
  assert.match(core, /WritePointerAtomic\([^\n]+"previous\.json"/);
  assert.match(core, /WritePointerAtomic\([^\n]+"current\.json"/);
  assert.match(core, /update_zip_ratio/);
  assert.match(core, /IsUnixSymbolicLink/);
  assert.match(core, /--update-preflight/);
  assert.match(core, /return 0; \/\/ Update failures must never block/);
  assert.doesNotMatch(core, /GetProcessesByName|Stop-Process|taskkill/i);

  const updateBranch = program.indexOf('args[0], "--update-check"');
  const preflightBranch = program.indexOf('args[0], "--update-preflight"');
  const uiInitialization = program.indexOf("ApplicationConfiguration.Initialize()");
  assert.ok(updateBranch >= 0 && updateBranch < uiInitialization);
  assert.ok(preflightBranch >= 0 && preflightBranch < uiInitialization);
  assert.match(launcher, /Start-Process[^\n]+--update-check/);
  assert.match(release, /이번 한 번은 ZIP/);
  assert.match(release, /다음 실행/);
  assert.match(signer, /Cert:\\CurrentUser\\My/);
  assert.match(signer, /CertificatePfxPath/);
  assert.match(signer, /PasswordDpapiPath/);
  assert.match(signer, /ProtectedData\]::Unprotect/);
  assert.match(signer, /AllowRecoverySigning/);
  assert.match(signer, /update-trust-anchors\.public\.json/);
  assert.match(signer, /RSASignaturePadding\]::Pss/);
  assert.match(signer, /GetRSAPrivateKey/);
  assert.match(signer, /VerifyData/);
  assert.match(signer, /actualModulus/);
  assert.match(signer, /actualExponent/);
  assert.match(signer, /actualKeyId/);
  assert.match(signer, /immutable-output-conflict/);
  assert.doesNotMatch(signer, /Export-PfxCertificate|ExportParameters\(\$true\)|BEGIN PRIVATE KEY/i);
});

test("primary loss can be recovered without distributing either private key", async () => {
  const [core, anchors, generator, completer] = await Promise.all([
    source("AgentUpdateCore.cs"),
    source("Signing/update-trust-anchors.public.json"),
    source("Signing/New-ByeollogUpdateTrustSet.ps1"),
    source("Signing/Complete-ByeollogUpdateTrustSet.ps1")
  ]);
  const parsed = JSON.parse(anchors);
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(parsed.keys.map((entry) => entry.role), ["primary", "recovery"]);
  for (const entry of parsed.keys) {
    assert.match(entry.keyId, /^rsa3072-[0-9a-f]{16}$/);
    assert.match(entry.modulusBase64, /^[A-Za-z0-9+/=]+$/);
    assert.match(entry.selfTestSignatureBase64, /^[A-Za-z0-9+/=]+$/);
    assert.ok(core.includes(entry.keyId));
    assert.ok(core.includes(entry.modulusBase64));
  }
  assert.match(generator, /OperationalRoot/);
  assert.match(generator, /PasswordRecoveryFile/);
  assert.match(generator, /ProtectedData\]::Protect/);
  assert.match(completer, /both-private-keys-sign-and-verify/);
  for (const contents of [core, anchors, generator, completer]) {
    assert.doesNotMatch(contents, /BEGIN (?:RSA )?PRIVATE KEY/);
  }
});

test("updater keys and payloads never contain a private signing key", async () => {
  const [core, project, signerReferences] = await Promise.all([
    source("AgentUpdateCore.cs"),
    source("HurogiCollector.csproj"),
    source("RELEASE_v07032_AUTO_UPDATE_BOOTSTRAP_KO.txt")
  ]);
  for (const contents of [core, project, signerReferences]) {
    assert.doesNotMatch(contents, /BEGIN (?:RSA )?PRIVATE KEY|privateExponent|\.Pfx|ExportParameters\(true\)/i);
  }
});
