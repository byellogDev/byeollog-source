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
  assert.match(core, /UseCookies = false/);
  assert.match(core, /AutomaticDecompression = DecompressionMethods\.None/);
  assert.match(core, /uri\.IdnHost, "byeollog\.com"/);
  assert.match(core, /MaximumRedirects = 2/);
  assert.match(core, /GithubHost = "github\.com"/);
  assert.match(core, /ReleaseAssetsHost = "release-assets\.githubusercontent\.com"/);
  assert.match(core, /agent-v\{context\.Version\}\/\{context\.EscapedPackageFileName\}/);
  assert.match(core, /update_package_redirect_loop/);
  assert.match(core, /update_package_redirect_limit/);
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

test("v85 release preparation is immutable and identifies the redirect compatibility build", async () => {
  const [build, notes] = await Promise.all([
    source("Build-v07085-AutoUpdate.ps1"),
    source("RELEASE_v07085_VOICE_ANONYMIZER_REDIRECT_FIX_KO.txt")
  ]);

  assert.match(build, /\$releaseSequence = 7085/);
  assert.match(build, /byeollog_agent_v07085_VOICE_ANONYMIZER_REDIRECT_FIX_WIN_X64/);
  assert.match(build, /FileVersion -ne '0\.7\.0\.85'/);
  assert.match(build, /New-ReleaseManifest\.ps1'\) -PackageRoot \$staging -Version '0\.7\.0\.85'/);
  assert.match(build, /immutable-output-conflict/);
  assert.match(notes, /v0\.7\.0\.85/);
  assert.match(notes, /GitHub Releases/);
  assert.match(notes, /최대 2회/);
  assert.match(notes, /SHA-256/);
});

test("v86 release preparation is immutable and identifies the OBS filter response hotfix", async () => {
  const [build, notes] = await Promise.all([
    source("Build-v07086-AutoUpdate.ps1"),
    source("RELEASE_v07086_OBS_FILTER_RESPONSE_FIX_KO.txt")
  ]);

  assert.match(build, /\$releaseSequence = 7086/);
  assert.match(build, /byeollog_agent_v07086_OBS_FILTER_RESPONSE_FIX_WIN_X64/);
  assert.match(build, /FileVersion -ne '0\.7\.0\.86'/);
  assert.match(build, /New-ReleaseManifest\.ps1'\) -PackageRoot \$staging -Version '0\.7\.0\.86'/);
  assert.match(build, /immutable-output-conflict/);
  assert.match(notes, /v0\.7\.0\.86/);
  assert.match(notes, /GetSourceFilter/);
  assert.match(notes, /OBS 32\.2\.1/);
});

test("v87 release preparation is immutable and identifies the voice pitch presets build", async () => {
  const [build, notes] = await Promise.all([
    source("Build-v07087-AutoUpdate.ps1"),
    source("RELEASE_v07087_VOICE_PITCH_PRESETS_KO.txt")
  ]);

  assert.match(build, /\$releaseSequence = 7087/);
  assert.match(build, /byeollog_agent_v07087_VOICE_PITCH_PRESETS_WIN_X64/);
  assert.match(build, /FileVersion -ne '0\.7\.0\.87'/);
  assert.match(build, /New-ReleaseManifest\.ps1'\) -PackageRoot \$staging -Version '0\.7\.0\.87'/);
  assert.match(build, /immutable-output-conflict/);
  assert.match(notes, /v0\.7\.0\.87/);
  assert.match(notes, /업톤과 다운톤/);
  assert.match(notes, /5초/);
});

test("v88 release preparation is immutable and identifies the Weflab recovery fix", async () => {
  const [build, notes] = await Promise.all([
    source("Build-v07088-AutoUpdate.ps1"),
    source("RELEASE_v07088_WEFLAB_SESSION_RECOVERY_KO.txt")
  ]);

  assert.match(build, /\$releaseSequence = 7088/);
  assert.match(build, /byeollog_agent_v07088_WEFLAB_SESSION_RECOVERY_WIN_X64/);
  assert.match(build, /FileVersion -ne '0\.7\.0\.88'/);
  assert.match(build, /New-ReleaseManifest\.ps1'\) -PackageRoot \$staging -Version '0\.7\.0\.88'/);
  assert.match(build, /immutable-output-conflict/);
  assert.match(notes, /v0\.7\.0\.88/);
  assert.match(notes, /저장된 위플랩 로그인 상태/);
  assert.match(notes, /실제 후원 API/);
});

test("v89 release preparation is immutable and identifies action-session self recovery", async () => {
  const [build, notes] = await Promise.all([
    source("Build-v07089-AutoUpdate.ps1"),
    source("RELEASE_v07089_ACTION_SESSION_SELF_RECOVERY_KO.txt")
  ]);

  assert.match(build, /\$releaseSequence = 7089/);
  assert.match(build, /byeollog_agent_v07089_ACTION_SESSION_SELF_RECOVERY_WIN_X64/);
  assert.match(build, /FileVersion -ne '0\.7\.0\.89'/);
  assert.match(build, /New-ReleaseManifest\.ps1'\) -PackageRoot \$staging -Version '0\.7\.0\.89'/);
  assert.match(build, /immutable-output-conflict/);
  assert.match(notes, /v0\.7\.0\.89/);
  assert.match(notes, /한 번만 강제 갱신/);
  assert.match(notes, /DPAPI/);
});

test("v90 release preparation is immutable and identifies the native voice filter build", async () => {
  const [build, notes] = await Promise.all([
    source("Build-v07090-AutoUpdate.ps1"),
    source("RELEASE_v07090_NATIVE_VOICE_FILTER_KO.txt")
  ]);

  assert.match(build, /\$releaseSequence = 7090/);
  assert.match(build, /byeollog_agent_v07090_NATIVE_VOICE_FILTER_WIN_X64/);
  assert.match(build, /FileVersion -ne '0\.7\.0\.90'/);
  assert.match(build, /New-ReleaseManifest\.ps1'\) -PackageRoot \$staging -Version '0\.7\.0\.90'/);
  assert.match(build, /immutable-output-conflict/);
  assert.match(notes, /v0\.7\.0\.90/);
  assert.match(notes, /별록 전용 OBS 음성 필터/);
  assert.match(notes, /ReaJS/);
  assert.match(notes, /다운톤과 업톤/);
});

test("v91 release preparation is immutable and identifies the voice readiness UI fix", async () => {
  const [build, notes] = await Promise.all([
    source("Build-v07091-AutoUpdate.ps1"),
    source("RELEASE_v07091_VOICE_READINESS_UI_FIX_KO.txt")
  ]);

  assert.match(build, /\$releaseSequence = 7091/);
  assert.match(build, /byeollog_agent_v07091_VOICE_READINESS_UI_FIX_WIN_X64/);
  assert.match(build, /FileVersion -ne '0\.7\.0\.91'/);
  assert.match(build, /New-ReleaseManifest\.ps1'\) -PackageRoot \$staging -Version '0\.7\.0\.91'/);
  assert.match(build, /immutable-output-conflict/);
  assert.match(notes, /v0\.7\.0\.91/);
  assert.match(notes, /두 톤 준비됨/);
  assert.match(notes, /5초 미리보기/);
});

test("v92 release preparation is immutable and identifies the voice controls UI build", async () => {
  const [build, notes] = await Promise.all([
    source("Build-v07092-AutoUpdate.ps1"),
    source("RELEASE_v07092_VOICE_CONTROLS_UI_KO.txt")
  ]);

  assert.match(build, /\$releaseSequence = 7092/);
  assert.match(build, /byeollog_agent_v07092_VOICE_CONTROLS_UI_WIN_X64/);
  assert.match(build, /FileVersion -ne '0\.7\.0\.92'/);
  assert.match(build, /New-ReleaseManifest\.ps1'\) -PackageRoot \$staging -Version '0\.7\.0\.92'/);
  assert.match(build, /immutable-output-conflict/);
  assert.match(notes, /v0\.7\.0\.92/);
  assert.match(notes, /버튼 배치/);
  assert.match(notes, /5초 미리보기/);
});

test("v93 release preparation is immutable and identifies the public voice-filter copy build", async () => {
  const [build, notes] = await Promise.all([
    source("Build-v07093-AutoUpdate.ps1"),
    source("RELEASE_v07093_VOICE_FILTER_COPY_KO.txt")
  ]);

  assert.match(build, /\$releaseSequence = 7093/);
  assert.match(build, /byeollog_agent_v07093_VOICE_FILTER_COPY_WIN_X64/);
  assert.match(build, /FileVersion -ne '0\.7\.0\.93'/);
  assert.match(build, /New-ReleaseManifest\.ps1'\) -PackageRoot \$staging -Version '0\.7\.0\.93'/);
  assert.match(build, /immutable-output-conflict/);
  assert.match(notes, /v0\.7\.0\.93/);
  assert.match(notes, /신원보호 필터/);
  assert.match(notes, /필터 자동 준비/);
});

test("v94 release preparation is immutable and identifies the inline microphone setup build", async () => {
  const [build, notes] = await Promise.all([
    source("Build-v07094-AutoUpdate.ps1"),
    source("RELEASE_v07094_INLINE_MIC_SETUP_KO.txt")
  ]);

  assert.match(build, /\$releaseSequence = 7094/);
  assert.match(build, /byeollog_agent_v07094_INLINE_MIC_SETUP_WIN_X64/);
  assert.match(build, /FileVersion -ne '0\.7\.0\.94'/);
  assert.match(build, /New-ReleaseManifest\.ps1'\) -PackageRoot \$staging -Version '0\.7\.0\.94'/);
  assert.match(build, /immutable-output-conflict/);
  assert.match(notes, /v0\.7\.0\.94/);
  assert.match(notes, /액션 생성 화면/);
  assert.match(notes, /아봉/);
});

test("v95 release preparation is immutable and identifies categorized screen and effect actions", async () => {
  const [build, notes] = await Promise.all([
    source("Build-v07095-AutoUpdate.ps1"),
    source("RELEASE_v07095_CATEGORIZED_SCREEN_EFFECT_ACTIONS_KO.txt")
  ]);

  assert.match(build, /\$releaseSequence = 7095/);
  assert.match(build, /byeollog_agent_v07095_CATEGORIZED_SCREEN_EFFECT_ACTIONS_WIN_X64/);
  assert.match(build, /FileVersion -ne '0\.7\.0\.95'/);
  assert.match(build, /New-ReleaseManifest\.ps1'\) -PackageRoot \$staging -Version '0\.7\.0\.95'/);
  assert.match(build, /immutable-output-conflict/);
  assert.match(notes, /v0\.7\.0\.95/);
  assert.match(notes, /화면 뒤집기/);
  assert.match(notes, /지진이야!/);
  assert.match(notes, /물벼락과 축포/);
});

test("v96 release preparation is immutable and identifies natural action audio and animated effects", async () => {
  const [build, notes] = await Promise.all([
    source("Build-v07096-AutoUpdate.ps1"),
    source("RELEASE_v07096_NATURAL_ACTION_AUDIO_ANIMATED_EFFECTS_KO.txt")
  ]);

  assert.match(build, /\$releaseSequence = 7096/);
  assert.match(build, /byeollog_agent_v07096_NATURAL_ACTION_AUDIO_ANIMATED_EFFECTS_WIN_X64/);
  assert.match(build, /FileVersion -ne '0\.7\.0\.96'/);
  assert.match(build, /New-ReleaseManifest\.ps1'\) -PackageRoot \$staging -Version '0\.7\.0\.96'/);
  assert.match(build, /immutable-output-conflict/);
  assert.match(notes, /v0\.7\.0\.96/);
  assert.match(notes, /지오폰/);
  assert.match(notes, /콘페티 팝퍼/);
  assert.match(notes, /CC0/);
});

test("v97 release preparation is immutable and identifies earthquake reliability and flowing water", async () => {
  const [build, notes] = await Promise.all([
    source("Build-v07097-AutoUpdate.ps1"),
    source("RELEASE_v07097_EARTHQUAKE_RELIABILITY_FLOWING_WATER_KO.txt")
  ]);
  assert.match(build, /\$releaseSequence = 7097/);
  assert.match(build, /byeollog_agent_v07097_EARTHQUAKE_RELIABILITY_FLOWING_WATER_WIN_X64/);
  assert.match(build, /FileVersion -ne '0\.7\.0\.97'/);
  assert.match(build, /New-ReleaseManifest\.ps1'\) -PackageRoot \$staging -Version '0\.7\.0\.97'/);
  assert.match(build, /immutable-output-conflict/);
  assert.match(notes, /실제 재생 시작/);
  assert.match(notes, /크로스페이드/);
  assert.match(notes, /Canvas 애니메이션/);
});

test("v98 release preparation is immutable and identifies premium water VFX", async () => {
  const [build, notes] = await Promise.all([
    source("Build-v07098-AutoUpdate.ps1"),
    source("RELEASE_v07098_PREMIUM_WATER_VFX_KO.txt")
  ]);
  assert.match(build, /\$releaseSequence = 7098/);
  assert.match(build, /byeollog_agent_v07098_PREMIUM_WATER_VFX_WIN_X64/);
  assert.match(build, /FileVersion -ne '0\.7\.0\.98'/);
  assert.match(build, /New-ReleaseManifest\.ps1'\) -PackageRoot \$staging -Version '0\.7\.0\.98'/);
  assert.match(build, /immutable-output-conflict/);
  assert.match(notes, /고해상도 투명 물보라/);
  assert.match(notes, /직선으로 내려오던 Canvas 물줄기를 전부 제거/);
  assert.match(notes, /렌즈 굴절/);
});

test("v99 release preparation is immutable and identifies FLIP water VFX", async () => {
  const [build, notes] = await Promise.all([
    source("Build-v07099-AutoUpdate.ps1"),
    source("RELEASE_v07099_FLIP_WATER_VFX_KO.txt")
  ]);
  assert.match(build, /\$releaseSequence = 7099/);
  assert.match(build, /byeollog_agent_v07099_FLIP_WATER_VFX_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.99'/);
  assert.match(notes, /FLIP 유체 시뮬레이션/);
  assert.match(notes, /투명 VP9/);
});

test("v100 release preparation is immutable and trims persistent water residue", async () => {
  const [build, notes] = await Promise.all([
    source("Build-v07100-AutoUpdate.ps1"),
    source("RELEASE_v07100_FRONT_IMPACT_WATER_VFX_KO.txt")
  ]);
  assert.match(build, /\$releaseSequence = 7100/);
  assert.match(build, /byeollog_agent_v07100_FRONT_IMPACT_WATER_VFX_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.100'/);
  assert.match(notes, /약 1\.17초/);
  assert.match(notes, /마지막 프레임/);
});

test("v101 release preparation is immutable and slows only the water animation", async () => {
  const [build, notes] = await Promise.all([
    source("Build-v07101-AutoUpdate.ps1"),
    source("RELEASE_v07101_SLOW_WATER_VFX_KO.txt")
  ]);
  assert.match(build, /\$releaseSequence = 7101/);
  assert.match(build, /byeollog_agent_v07101_SLOW_WATER_VFX_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.101'/);
  assert.match(notes, /0\.7배속/);
  assert.match(notes, /약 1\.67초/);
});

test("v102 release preparation is immutable and packages bodyless confetti motion", async () => {
  const [build, notes] = await Promise.all([
    source("Build-v07102-AutoUpdate.ps1"),
    source("RELEASE_v07102_BODYLESS_CONFETTI_VFX_KO.txt")
  ]);
  assert.match(build, /\$releaseSequence = 7102/);
  assert.match(build, /byeollog_agent_v07102_BODYLESS_CONFETTI_VFX_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.102'/);
  assert.match(notes, /폭죽통과 발사기 몸통을 완전히 제거/);
  assert.match(notes, /화면 아래까지 떨어져/);
});

test("v103 release preparation is immutable and packages denser confetti motion", async () => {
  const [build, notes] = await Promise.all([
    source("Build-v07103-AutoUpdate.ps1"),
    source("RELEASE_v07103_DENSE_CONFETTI_VFX_KO.txt")
  ]);
  assert.match(build, /\$releaseSequence = 7103/);
  assert.match(build, /byeollog_agent_v07103_DENSE_CONFETTI_VFX_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.103'/);
  assert.match(notes, /124개에서 252개/);
  assert.match(notes, /중앙 분출/);
});
