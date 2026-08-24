# 별록 v0.7.0.52 공개 배포 인계

## 기준

- Agent: `0.7.0.52` (과거 공개판 번호를 제거한 통합 표기)
- Web: `0.6.3-g3a.19` / `0.6.3.31-g3a-agent-v07052`
- Production: `dpl_3Hq1m8fe4DLfbi3ad1brNbUzxp8J`
- Update sequence: `7052`

## 이번 변경

- 서버가 전달하는 대시보드·가입·비밀번호 URL을 별록 공식 HTTPS same-origin으로 제한
- cross-origin, file URI, 원격 평문 HTTP 실행 차단
- 서버 API의 raw exception detail 응답 제거
- 다음 룰렛 배수 내부 테이블 RLS·명시적 client 거부 정책 적용
- 외래키 커버 인덱스 4개 적용
- 운영 G3A Edge Function 3개의 정확한 현재 source를 회수하고 해시 manifest 추가
- 비밀값을 노출하지 않는 server runtime 환경 검증기 추가

## 검증

- Agent Node `123/123`
- AgentStore `323 assertions`
- Server Node `24/24`
- win-x64 publish, preflight, package 검증, ZIP 왕복 PASS
- DB multiplier rollback-only 기능 감사 PASS
- Vercel Preview/Production build·runtime error 0
- Production v0.7.0.52 ZIP 전체 다운로드 및 SHA-256 일치

## 산출물 식별자

- EXE SHA-256: `2D262F4B868AFA0977D357EA13BE9332405EFA76F8F021832E2A1FB94D535C97`
- Update ZIP SHA-256: `F1C7541251EDC3EA47A0187FE59F426A359BC105336247062C095B710AEDDF44`
- Setup SHA-256: `2465A0BDE64587AA07CAE0D71C945F70AD514D9AFB5BC0791AE30C01DAA72766`
- Feed key: `rsa3072-cc1fb719f3a63774`

## 보존 원칙

- 기존 사용자 데이터 `%LOCALAPPDATA%\ByeollogAgent`를 삭제·이동하지 않는다.
- 같은 버전의 바이트를 덮어쓰지 않는다.
- v0.7.0.32 protocol-v1 launcher/install-root를 임의 변경하지 않는다.
- 방송·수집·마이크 복원 중 강제 재시작하지 않는다.
- 운영 DB는 migration만 사용하고 데이터 삭제·`DROP/TRUNCATE`는 별도 승인한다.
- 실제 운영 데이터 대신 rollback transaction 또는 표준 fixture로 회귀시험한다.

## 남은 위험

- Authenticode 미서명: SmartScreen 경고 가능
- Supabase leaked-password protection 비활성: Auth 변경 승인 필요
- WebView2 포함 전체 메모리 사용량이 저사양 PC에서 높을 수 있음
- multiplier receipt 보존·정리 정책 미정
- 실제 OBS·Windows 마이크·Weflab 장시간 방송 canary 필요

## 다음 시작 순서

1. 본 문서와 최종 공개 배포 보고서, Agent/Server source checkpoint의 SHA-256을 확인한다.
2. 버전을 올리기 전 Agent Node, AgentStore, Server Node 전체 검증을 실행한다.
3. 변경 후 새 4-part 버전으로 publish하고 package→signed feed→Preview full download→Production 순서를 지킨다.
4. 공개 사용자 지원 번들에서 update/startup/action 오류와 메모리 추세를 먼저 확인한다.
