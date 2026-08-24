# 별록 프로젝트 작업공간

이 저장소에서 현재 개발 기준으로 사용하는 소스는 아래 두 디렉터리뿐입니다.

- Windows Agent: `BYEOLLOG_AGENT_DEV_v07022` (디렉터리 이름은 과거 이름이지만 내부 버전이 권위 기준)
- Web/Vercel/Supabase: `BYEOLLOG_SERVER_DEV_20260823_SUBSCRIPTION_FIX`

그 밖의 `RELEASE_*`, `PRODUCTION_CHECKPOINT_*`, `GROK_REVIEW_*`, `.tmp*`, 대용량 영상·음성·ZIP은 과거 증거 또는 산출물입니다. 삭제하지 않지만 새 개발의 입력으로 사용하거나 Git에 추가하지 않습니다.

## 현재 기준선

- Agent: `0.7.0.71`
- Server package: `0.6.3-g3a.40`
- Server build: `0.6.3.56-g3a-collection-health-visibility`
- Vercel project: `observer_abangseladmin`
- Supabase project: `offslvwaugvjotkywlus`

세부 무결성 값과 운영 배포 기준은 [PROJECT_BASELINE_20260825_KO.md](PROJECT_BASELINE_20260825_KO.md)를 참고합니다.

## 기본 검증

Agent:

```powershell
Set-Location .\BYEOLLOG_AGENT_DEV_v07022
dotnet run --project .\AgentStoreTests\AgentStoreTests.csproj -c Release
node --test
dotnet build .\HurogiCollector.csproj -c Release --no-restore
```

Server:

```powershell
Set-Location .\BYEOLLOG_SERVER_DEV_20260823_SUBSCRIPTION_FIX
npm test
```

## 운영 원칙

1. Production은 검증한 Preview 산출물만 승격합니다. Production에서 다시 빌드하지 않습니다.
2. Supabase 변경은 추가형 migration과 Preview/행동 검증을 먼저 수행합니다.
3. `.env*`, 인증서·개인키·DPAPI 파일은 저장소에 넣지 않습니다.
4. Agent release ZIP은 기존 자동 업데이트 서명 절차로 만들며, 같은 버전의 바이트를 덮어쓰지 않습니다.
5. 방송 중 Agent 강제 재시작, 데이터 삭제, Auth·Storage·DNS·결제 변경은 별도 승인 없이 수행하지 않습니다.
