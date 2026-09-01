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

test("v104 release preparation is immutable and packages modern restrained confetti motion", async () => {
  const [build, notes] = await Promise.all([
    source("Build-v07104-AutoUpdate.ps1"),
    source("RELEASE_v07104_MODERN_CONFETTI_VFX_KO.txt")
  ]);
  assert.match(build, /\$releaseSequence = 7104/);
  assert.match(build, /byeollog_agent_v07104_MODERN_CONFETTI_VFX_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.104'/);
  assert.match(notes, /252개에서 186개/);
  assert.match(notes, /얇고 불규칙한 종이 조각/);
});

test("v105 release preparation is immutable and packages photoreal confetti motion", async () => {
  const [build, notes] = await Promise.all([
    source("Build-v07105-AutoUpdate.ps1"),
    source("RELEASE_v07105_PHOTOREAL_CONFETTI_VFX_KO.txt")
  ]);
  assert.match(build, /\$releaseSequence = 7105/);
  assert.match(build, /byeollog_agent_v07105_PHOTOREAL_CONFETTI_VFX_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.105'/);
  assert.match(notes, /실사 촬영 질감/);
  assert.match(notes, /54개/);
});

test("v106 release preparation is immutable and doubles only photoreal confetti count", async () => {
  const [build, notes] = await Promise.all([
    source("Build-v07106-AutoUpdate.ps1"),
    source("RELEASE_v07106_DOUBLE_PHOTOREAL_CONFETTI_VFX_KO.txt")
  ]);
  assert.match(build, /\$releaseSequence = 7106/);
  assert.match(build, /byeollog_agent_v07106_DOUBLE_PHOTOREAL_CONFETTI_VFX_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.106'/);
  assert.match(notes, /54개에서 108개/);
  assert.match(notes, /질감과 파티클 크기, 회전, 낙하 속도는 그대로/);
});

test("v107 release preparation is immutable and doubles photoreal confetti at 1.2x", async () => {
  const [build, notes] = await Promise.all([
    source("Build-v07107-AutoUpdate.ps1"),
    source("RELEASE_v07107_QUAD_PHOTOREAL_CONFETTI_FAST_VFX_KO.txt")
  ]);
  assert.match(build, /\$releaseSequence = 7107/);
  assert.match(build, /byeollog_agent_v07107_QUAD_PHOTOREAL_CONFETTI_FAST_VFX_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.107'/);
  assert.match(notes, /108개에서 216개/);
  assert.match(notes, /1\.2배/);
});

test("v111 release preparation is immutable and packages the single OBS wallpaper layer", async () => {
  const [build, notes] = await Promise.all([
    source("Build-v07111-AutoUpdate.ps1"),
    source("RELEASE_v07111_SINGLE_OVERLAY_WALLPAPER_KO.txt")
  ]);
  assert.match(build, /\$releaseSequence = 7111/);
  assert.match(build, /byeollog_agent_v07111_SINGLE_OVERLAY_WALLPAPER_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.111'/);
  assert.match(notes, /기존 OBS 주소 하나/);
  assert.match(notes, /풍벽지보다 항상 위/);
});

test("v112 refreshes the existing OBS local overlay once after Agent startup", async () => {
  const [build, notes, agent] = await Promise.all([
    source("Build-v07112-AutoUpdate.ps1"),
    source("RELEASE_v07112_OBS_REFRESH_FIX_KO.txt"),
    source("VNextLocalAgent.cs")
  ]);
  assert.match(build, /\$releaseSequence = 7112/);
  assert.match(build, /byeollog_agent_v07112_OBS_REFRESH_FIX_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.112'/);
  assert.match(notes, /한 번만 캐시 없이 새로고침/);
  assert.match(agent, /RefreshOverlayBrowserSourceAfterStartupAsync\(cancellationToken\)/);
  assert.match(agent, /Interlocked\.Exchange\(ref _startupOverlayRefreshPending, 0\)/);
});

test("v113 renders the Agent wallpaper with the restored web visual language", async () => {
  const [build, notes, overlay] = await Promise.all([
    source("Build-v07113-AutoUpdate.ps1"),
    source("RELEASE_v07113_WEB_WALLPAPER_VISUAL_PARITY_KO.txt"),
    source("ByeollogOverlayService.cs")
  ]);
  assert.match(build, /\$releaseSequence = 7113/);
  assert.match(build, /byeollog_agent_v07113_WEB_WALLPAPER_VISUAL_PARITY_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.113'/);
  assert.match(notes, /이전 웹 풍벽지 디자인/);
  assert.match(overlay, /"Noto Sans KR",Pretendard,"Malgun Gothic",sans-serif/);
  assert.match(overlay, /--label-size/);
});

test("v114 stacks merged donation amounts as one continuous amount-time ordered group", async () => {
  const [build, notes, overlay] = await Promise.all([
    source("Build-v07114-AutoUpdate.ps1"),
    source("RELEASE_v07114_MERGED_WALLPAPER_CONTINUOUS_STACK_KO.txt"),
    source("ByeollogOverlayService.cs")
  ]);
  assert.match(build, /\$releaseSequence = 7114/);
  assert.match(build, /byeollog_agent_v07114_MERGED_WALLPAPER_CONTINUOUS_STACK_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.114'/);
  assert.match(notes, /하나의 동일 그룹/);
  assert.match(notes, /별풍선 개수 오름차순/);
  assert.doesNotMatch(overlay, /function wallpaperRuns/);
  assert.match(overlay, /const cards = group\.tiles\.map\(\(tile, index\) =>/);
});

test("v115 keeps every wallpaper donation label above every wallpaper image", async () => {
  const [build, notes, overlay] = await Promise.all([
    source("Build-v07115-AutoUpdate.ps1"),
    source("RELEASE_v07115_WALLPAPER_LABEL_LAYER_PRIORITY_KO.txt"),
    source("ByeollogOverlayService.cs")
  ]);
  assert.match(build, /\$releaseSequence = 7115/);
  assert.match(build, /byeollog_agent_v07115_WALLPAPER_LABEL_LAYER_PRIORITY_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.115'/);
  assert.match(notes, /후원정보.*이미지/);
  assert.match(overlay, /\.wallpaper-tile img[^}]*z-index:1/);
  assert.match(overlay, /\.wallpaper-meta[^}]*z-index:1000/);
  assert.match(overlay, /node\.style\.zIndex = 'auto'/);
});

test("v116 clips the native login window to the same rounded shell as the main window", async () => {
  const [build, notes, login] = await Promise.all([
    source("Build-v07116-AutoUpdate.ps1"),
    source("RELEASE_v07116_LOGIN_WINDOW_ROUNDED_CORNERS_KO.txt"),
    source("CollectorLoginWebForm.cs")
  ]);
  assert.match(build, /\$releaseSequence = 7116/);
  assert.match(build, /byeollog_agent_v07116_LOGIN_WINDOW_ROUNDED_CORNERS_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.116'/);
  assert.match(notes, /실제 Windows 창 영역/);
  assert.match(notes, /24px/);
  assert.match(login, /ApplyRoundedRegion\(24\);/);
  assert.match(login, /Resize \+= \(_, _\) => ApplyRoundedRegion\(24\);/);
});

test("v117 separates action and wallpaper overlays and exposes the Agent guide", async () => {
  const [build, notes, service, ui] = await Promise.all([
    source("Build-v07117-AutoUpdate.ps1"),
    source("RELEASE_v07117_SPLIT_ACTION_WALLPAPER_OVERLAY_KO.txt"),
    source("ByeollogOverlayService.cs"),
    source("Ui/agent_automation.html")
  ]);
  assert.match(build, /\$releaseSequence = 7117/);
  assert.match(build, /byeollog_agent_v07117_SPLIT_ACTION_WALLPAPER_OVERLAY_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.117'/);
  assert.match(notes, /액션 OBS 주소.*액션만/);
  assert.match(service, /WallpaperOverlayUrl/);
  assert.match(ui, /id="wallpaperNav"/);
  assert.match(ui, /풍벽지는 액션 아래/);
});

test("v118 seals the split-overlay guide layout fix", async () => {
  const [build, notes] = await Promise.all([
    source("Build-v07118-AutoUpdate.ps1"),
    source("RELEASE_v07118_SPLIT_ACTION_WALLPAPER_GUIDE_KO.txt")
  ]);
  assert.match(build, /\$releaseSequence = 7118/);
  assert.match(build, /byeollog_agent_v07118_SPLIT_ACTION_WALLPAPER_GUIDE_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.118'/);
  assert.match(notes, /창 아래에서 잘리지 않도록/);
});

test("v119 replaces idle polling with private Realtime wake hints", async () => {
  const [build, notes] = await Promise.all([
    source("Build-v07119-AutoUpdate.ps1"),
    source("RELEASE_v07119_REALTIME_WAKE_TRAFFIC_KO.txt")
  ]);
  assert.match(build, /\$releaseSequence = 7119/);
  assert.match(build, /byeollog_agent_v07119_REALTIME_WAKE_TRAFFIC_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.119'/);
  assert.match(notes, /Realtime/);
  assert.match(notes, /30초/);
  assert.match(notes, /2초/);
});

test("v120 coalesces only background status and asset traffic", async () => {
  const [build, notes] = await Promise.all([
    source("Build-v07120-AutoUpdate.ps1"),
    source("RELEASE_v07120_BACKGROUND_TRAFFIC_KO.txt")
  ]);
  assert.match(build, /\$releaseSequence = 7120/);
  assert.match(build, /byeollog_agent_v07120_BACKGROUND_TRAFFIC_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.120'/);
  assert.match(notes, /Realtime 즉시 깨우기/);
  assert.match(notes, /30초 안전 claim/);
  assert.match(notes, /5분/);
  assert.match(notes, /15분/);
});

test("v121 makes Realtime authoritative and retains only bounded recovery polling", async () => {
  const [build, notes, agent] = await Promise.all([
    source("Build-v07121-AutoUpdate.ps1"),
    source("RELEASE_v07121_EVENT_DRIVEN_RECOVERY_KO.txt"),
    source("VNextLocalAgent.cs")
  ]);
  assert.match(build, /\$releaseSequence = 7121/);
  assert.match(build, /byeollog_agent_v07121_EVENT_DRIVEN_RECOVERY_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.121'/);
  assert.match(notes, /Realtime 신호를 받는 즉시 claim/);
  assert.match(notes, /10분 누락 복구/);
  assert.match(notes, /2초 안전 claim/);
  assert.match(agent, /RealtimeConnectedRecoveryInterval = TimeSpan\.FromSeconds\(30\)/);
  assert.match(agent, /RealtimeDisconnectedClaimFallback = TimeSpan\.FromSeconds\(2\)/);
});

test("v122 preserves every wallpaper wake until its snapshot is applied", async () => {
  const [build, notes, agent, tracker] = await Promise.all([
    source("Build-v07122-AutoUpdate.ps1"),
    source("RELEASE_v07122_WALLPAPER_WAKE_RECOVERY_KO.txt"),
    source("VNextLocalAgent.cs"),
    source("WallpaperOverlayState.cs")
  ]);
  assert.match(build, /\$releaseSequence = 7122/);
  assert.match(build, /byeollog_agent_v07122_WALLPAPER_WAKE_RECOVERY_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.122'/);
  assert.match(notes, /풍벽지 변경 세대/);
  assert.match(notes, /5초 주기 제한을 우회/);
  assert.match(agent, /_wallpaperRequests\.Pending/);
  assert.match(agent, /CompleteThrough\(requestGeneration\)/);
  assert.match(tracker, /class WallpaperSyncRequestTracker/);
});

test("v123 detects actual SOOP image bytes and keeps the last complete OBS snapshot", async () => {
  const [build, notes, wallpaper] = await Promise.all([
    source("Build-v07123-AutoUpdate.ps1"),
    source("RELEASE_v07123_WALLPAPER_IMAGE_FORMAT_FIX_KO.txt"),
    source("WallpaperOverlayState.cs")
  ]);
  assert.match(build, /\$releaseSequence = 7123/);
  assert.match(build, /byeollog_agent_v07123_WALLPAPER_IMAGE_FORMAT_FIX_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.123'/);
  assert.match(notes, /파일 서명/);
  assert.match(notes, /기존 OBS 화면/);
  assert.match(wallpaper, /DetectAndValidateImageBytes/);
  assert.match(wallpaper, /previousByKey\[imageKey\] = token/);
  assert.doesNotMatch(wallpaper, /tile\["imageUrl"\] = null;\s*\}\s*catch/);
});

test("v124 automatically reclaims incomplete wallpaper snapshots left by older Agents", async () => {
  const [build, notes, wallpaper] = await Promise.all([
    source("Build-v07124-AutoUpdate.ps1"),
    source("RELEASE_v07124_WALLPAPER_IMAGE_SELF_HEAL_KO.txt"),
    source("WallpaperOverlayState.cs")
  ]);
  assert.match(build, /\$releaseSequence = 7124/);
  assert.match(build, /byeollog_agent_v07124_WALLPAPER_IMAGE_SELF_HEAL_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.124'/);
  assert.match(notes, /전체 스냅샷을 자동으로 다시 받아 복구/);
  assert.match(wallpaper, /StateNeedsAssetRepair/);
  assert.match(wallpaper, /_revision = StateNeedsAssetRepair\(document\.RootElement\) \? 0 : value/);
});

test("v125 renders image-free subscription month wallpaper cards without touching the action hot path", async () => {
  const [build, notes, overlay, wallpaper] = await Promise.all([
    source("Build-v07125-AutoUpdate.ps1"),
    source("RELEASE_v07125_WALLPAPER_SUBSCRIPTION_CARDS_KO.txt"),
    source("ByeollogOverlayService.cs"),
    source("WallpaperOverlayState.cs")
  ]);
  assert.match(build, /\$releaseSequence = 7125/);
  assert.match(build, /byeollog_agent_v07125_WALLPAPER_SUBSCRIPTION_CARDS_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.125'/);
  assert.match(notes, /n개월 구독/);
  assert.match(notes, /이미지.*내려받지 않/);
  assert.match(overlay, /displayKind === 'subscription'/);
  assert.match(overlay, /개월 구독/);
  assert.match(overlay, /\.wallpaper-tile\.text-only/);
  assert.match(wallpaper, /if \(imageKey is null\) \{ tile\["imageUrl"\] = null; continue; \}/);
});

test("v126 restores subscription label size parity without changing wallpaper data flow", async () => {
  const [build, notes, overlay] = await Promise.all([
    source("Build-v07126-AutoUpdate.ps1"),
    source("RELEASE_v07126_WALLPAPER_SUBSCRIPTION_FONT_PARITY_KO.txt"),
    source("ByeollogOverlayService.cs")
  ]);
  assert.match(build, /\$releaseSequence = 7126/);
  assert.match(build, /byeollog_agent_v07126_WALLPAPER_SUBSCRIPTION_FONT_PARITY_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.126'/);
  assert.match(notes, /일반 후원정보 카드와 비슷한 시각 크기/);
  assert.match(overlay, /\.wallpaper-tile\.text-only \.wallpaper-meta[^}]*42cqh/);
});

test("v127 renders and locally caches SOOP official subscription wallpaper images", async () => {
  const [build, notes, overlay, wallpaper] = await Promise.all([
    source("Build-v07127-AutoUpdate.ps1"),
    source("RELEASE_v07127_WALLPAPER_SUBSCRIPTION_OFFICIAL_IMAGE_KO.txt"),
    source("ByeollogOverlayService.cs"),
    source("WallpaperOverlayState.cs")
  ]);
  assert.match(build, /\$releaseSequence = 7127/);
  assert.match(build, /byeollog_agent_v07127_WALLPAPER_SUBSCRIPTION_OFFICIAL_IMAGE_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.127'/);
  assert.match(notes, /SOOP 구독 이벤트가 제공하는 공식 구독 이미지/);
  assert.match(notes, /최초 1회 로컬 캐시/);
  assert.match(overlay, /card\.displayKind === 'subscription' && !\(typeof card\.imageUrl === 'string' && card\.imageUrl\)/);
  assert.match(wallpaper, /CacheRemoteImageAsync\(remoteUrl, tile, cancellationToken\)/);
  assert.match(wallpaper, /HostMatches\(host, "sooplive\.com"\)/);
});

test("v128 restores reference two-line cards, strict OBS bounds, and compact fallback", async () => {
  const [build, notes, overlay] = await Promise.all([
    source("Build-v07128-AutoUpdate.ps1"),
    source("RELEASE_v07128_WALLPAPER_REFERENCE_CARD_UNIFORM_WIDTH_KO.txt"),
    source("ByeollogOverlayService.cs")
  ]);
  assert.match(build, /\$releaseSequence = 7128/);
  assert.match(build, /byeollog_agent_v07128_WALLPAPER_REFERENCE_CARD_UNIFORM_WIDTH_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.128'/);
  assert.match(notes, /후원자명.*두 줄 카드/);
  assert.match(notes, /극단적으로 작아진 카드만 한 줄/);
  assert.match(overlay, /wallpaper-meta-name/);
  assert.match(overlay, /info:'별풍선 ' \+ amount \+ '개'/);
  assert.match(overlay, /card\.width < 150 \|\| card\.height < 160/);
  assert.match(overlay, /layout\.x >= 0 && layout\.y >= 0/);
  assert.doesNotMatch(overlay, /Math\.max\(-160|2080 - x/);
});

test("v129 removes the middle dot from compact wallpaper card labels", async () => {
  const [build, notes, overlay] = await Promise.all([
    source("Build-v07129-AutoUpdate.ps1"),
    source("RELEASE_v07129_WALLPAPER_COMPACT_LABEL_SPACING_KO.txt"),
    source("ByeollogOverlayService.cs")
  ]);
  assert.match(build, /\$releaseSequence = 7129/);
  assert.match(build, /byeollog_agent_v07129_WALLPAPER_COMPACT_LABEL_SPACING_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.129'/);
  assert.match(notes, /가운데 점 없이 공백 한 칸/);
  assert.match(overlay, /compact:actor \+ ' ' \+ amount \+ '개'/);
  assert.match(overlay, /compact:actor \+ ' ' \+ amount \+ '개월'/);
  assert.match(overlay, /compact:'도전미션 ' \+ amount \+ '개'/);
  assert.doesNotMatch(overlay, /compact:[^;}]*·/);
});

test("v131 removes wallpaper seams and syncs new cards independently from action slots", async () => {
  const [build, notes, overlay, agent, client] = await Promise.all([
    source("Build-v07131-AutoUpdate.ps1"),
    source("RELEASE_v07131_WALLPAPER_SIZE_RULES_NO_SHADOW_KO.txt"),
    source("ByeollogOverlayService.cs"),
    source("VNextLocalAgent.cs"),
    source("VNextDevelopmentClient.cs")
  ]);
  assert.match(build, /\$releaseSequence = 7131/);
  assert.match(build, /byeollog_agent_v07131_WALLPAPER_SIZE_RULES_NO_SHADOW_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.131'/);
  assert.match(notes, /외부 그림자.*어두운 이음선/);
  assert.match(overlay, /\.wallpaper-tile img[^}]*filter:none/);
  assert.match(overlay, /\.wallpaper-meta[^}]*filter:none/);
  assert.match(overlay, /setTimeout\(refreshWallpaper, 100\)/);
  assert.match(agent, /ScheduleDirectWallpaperSync\(requestGeneration/);
  assert.match(agent, /_wallpaperFetchGate/);
  assert.match(client, /operation = "wallpaper"/);
  assert.match(client, /GetWallpaperSnapshotAsync/);
});

test("wallpaper transfer compaction is negotiated and expands before the OBS renderer", async () => {
  const [build, notes, client, wallpaper] = await Promise.all([
    source("Build-v07132-AutoUpdate.ps1"),
    source("RELEASE_v07132_WALLPAPER_SNAPSHOT_COMPACTION_KO.txt"),
    source("VNextDevelopmentClient.cs"),
    source("WallpaperOverlayState.cs")
  ]);
  assert.match(build, /\$releaseSequence = 7132/);
  assert.match(build, /byeollog_agent_v07132_WALLPAPER_SNAPSHOT_COMPACTION_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.132'/);
  assert.match(notes, /한 번만 전송/);
  assert.match(notes, /액션 claim.*변경하지 않았/);
  assert.match(client, /WallpaperSchemaVersion = 2/);
  assert.match(client, /wallpaperSchemaVersion = WallpaperSchemaVersion/g);
  assert.match(client, /schemaVersion is not \(1 or 2\)/);
  assert.match(wallpaper, /if \(schemaVersion == 2\) ExpandCompactState\(root\)/);
  assert.match(wallpaper, /root\["schemaVersion"\] = 1/);
  assert.match(wallpaper, /previousByKey\.TryGetValue/);
});

test("v133 moves only non-critical sync traffic off Edge and preserves action leasing", async () => {
  const [build, notes, client, agent, mapper] = await Promise.all([
    source("Build-v07133-AutoUpdate.ps1"),
    source("RELEASE_v07133_DIRECT_SYNC_TRAFFIC_KO.txt"),
    source("VNextDevelopmentClient.cs"),
    source("VNextLocalAgent.cs"),
    source("AgentWallpaperSnapshotMapper.cs")
  ]);
  assert.match(build, /\$releaseSequence = 7133/);
  assert.match(build, /byeollog_agent_v07133_DIRECT_SYNC_TRAFFIC_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.133'/);
  assert.match(notes, /액션.*lease/);
  assert.match(notes, /기존 2초 복구 claim/);
  assert.match(client, /g3a_agent_direct_report_v1/);
  assert.match(client, /g3a_agent_direct_pending_v1/);
  assert.match(client, /g3a_agent_direct_wallpaper_snapshot_v1/);
  assert.match(agent, /DeviceStatusInterval = TimeSpan\.FromMinutes\(4\)/);
  assert.match(agent, /RealtimeDisconnectedClaimFallback = TimeSpan\.FromSeconds\(2\)/);
  assert.match(agent, /RequestExecutionClaim/);
  assert.match(mapper, /class AgentWallpaperSnapshotMapper/);
});

test("v134 bounds silent Realtime wake recovery without delaying the hot path", async () => {
  const [build, notes, agent] = await Promise.all([
    source("Build-v07134-AutoUpdate.ps1"),
    source("RELEASE_v07134_REALTIME_RECOVERY_KO.txt"),
    source("VNextLocalAgent.cs")
  ]);
  assert.match(build, /\$releaseSequence = 7134/);
  assert.match(build, /byeollog_agent_v07134_REALTIME_RECOVERY_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.134'/);
  assert.match(notes, /30초 이내/);
  assert.match(notes, /즉시 실행/);
  assert.match(agent, /RealtimeConnectedRecoveryInterval = TimeSpan\.FromSeconds\(30\)/);
  assert.match(agent, /RealtimeDisconnectedClaimFallback = TimeSpan\.FromSeconds\(2\)/);
});

test("v135 measures rendered latency without entering the action hot path", async () => {
  const [build, notes, service, client, agent] = await Promise.all([
    source("Build-v07135-AutoUpdate.ps1"),
    source("RELEASE_v07135_DISPLAY_LATENCY_OBSERVABILITY_KO.txt"),
    source("ByeollogOverlayService.cs"),
    source("VNextDevelopmentClient.cs"),
    source("VNextLocalAgent.cs")
  ]);
  assert.match(build, /\$releaseSequence = 7135/);
  assert.match(build, /byeollog_agent_v07135_DISPLAY_LATENCY_OBSERVABILITY_WIN_X64/);
  assert.match(build, /Version = '0\.7\.0\.135'/);
  assert.match(notes, /별도 비동기 큐/);
  assert.match(notes, /개인정보와 콘텐츠는 계측 데이터에 포함하지 않습니다/);
  assert.match(service, /requestVideoFrameCallback/);
  assert.match(service, /requestAnimationFrame\(\(\) => requestAnimationFrame\(resolve\)\)/);
  assert.match(client, /g3a_agent_direct_display_observation_v1/);
  assert.match(agent, /_pendingDisplayObservations\) > 16/);
});
