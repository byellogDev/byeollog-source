# 별록 v0.7.0.53 추첨 액션 Codex 인계

## 기준선

- Agent: `0.7.0.53`
- 서버 소스: `BYEOLLOG_SERVER_DEV_20260823_SUBSCRIPTION_FIX`
- Vercel Production: `dpl_bBCwAE565ropHhQLLiSS1nF2toau` (`READY`)
- Supabase Production: `offslvwaugvjotkywlus`
- Supabase migration: `add_raffle_action`
- Edge Function: `agent-runtime-g3a` v5, `ACTIVE`, `verify_jwt=true`

## 구현된 사용자 기능

별록 액션에 `추첨`을 추가했다.

- 스트리머가 `추첨권 1장 기준 후원 수량`을 직접 설정한다.
- 지급 수량은 `floor(후원 수량 / 기준 수량)`이다. 기준 33개에서 100개 후원은 3장이다.
- 한 후원 이벤트는 원장 고유키로 한 번만 지급된다.
- 스트리머는 열린 회차의 총 추첨권, 참여자, 참여자별 보유권과 이력을 확인한다.
- 당첨 횟수는 1~100회로 설정한다.
- 같은 시청자의 중복 당첨 허용 여부를 체크박스로 선택한다.
- 중복 미허용 시 한 시청자는 최대 한 번 당첨된다. 당첨 횟수가 참여자 수보다 많으면 서버가 거부한다.
- 중복 허용 시 당첨될 때마다 해당 시청자의 추첨권 한 장을 소비한다. 당첨 횟수가 총 추첨권보다 많으면 서버가 거부한다.
- 추첨 완료 후 회차를 닫고 다음 추첨권부터 새 회차를 연다.
- 열린 회차에 추첨권이 있으면 관련 규칙의 수정·비활성화·삭제를 막아 표가 유실되지 않게 한다.

## 오버레이

- 지급 애니메이션: `Assets/byeollog_raffle_ticket_granted.gif`
- 추첨 애니메이션: `Assets/byeollog_raffle_draw.gif`
- 두 파일은 실제 GIF89a 640×640, 각 24프레임이다.
- 추첨 3회면 Agent가 `추첨 1/3`, `추첨 2/3`, `추첨 3/3`을 각 4초씩 순차 송출한다.
- 결과 문자열은 HTML로 삽입하지 않고 text node만 사용한다.

## 서버 구조와 보안 경계

마이그레이션: `supabase/migrations/20260823103000_add_raffle_action.sql`

- private schema의 round/entry/grant/draw/candidate/winner 6개 테이블
- 전 테이블 RLS 활성화, public/anon/authenticated/service_role 직접 테이블 권한 회수
- 공개 RPC는 `save_guided_rule_v9`, `get_raffle_state_v1`, `draw_raffle_v1` 세 개
- 각 RPC는 기존 `assert_canary_manager_v1`로 활성 인증 세션과 workspace 관리자 권한을 검사한다.
- donation event AFTER INSERT trigger는 추첨 장애가 원 후원 이벤트를 롤백하지 않도록 예외를 격리한다.
- local action은 `raffle.overlay` capability가 있는 온라인 Agent만 선택한다.
- 기존 추첨 외 규칙 저장은 v9가 v8에 위임한다.

## 검증 결과

- Agent Node 계약: 125/125 PASS
- AgentStore: 342 assertions PASS
- Server Node 계약: 27/27 PASS
- Agent Release build: PASS (기존 WindowsBase MSB3277 경고 1개만 존재)
- Production Supabase rollback transaction E2E: PASS
  - 실제 사용자 workspace/device를 트랜잭션 안에서만 사용
  - 100개 donation → 3 tickets
  - ticket overlay execution 1개
  - draw 3회 → winner record 3개 + ordered overlay payload
  - 명시적 ROLLBACK 후 테스트 rule/grant 0개 확인
- 공개 피드: HTTP 200, ETag 조건 요청 304
- 공개 ZIP: HTTP 200, Range 206, immutable 1년 캐시
- 공개 피드·ZIP 전체 다운로드 SHA-256이 봉인본과 일치
- Vercel Production error log: 배포 후 오류 0건

## v0.7.0.53 불변 산출물

- ZIP: `byeollog_agent_v07053_RAFFLE_ACTION_WIN_X64.zip`
  - 76,390,980 bytes
  - SHA-256 `fe72330d0e0eaada23dfe28aa312fb5cfb87c092a988a216d5fae61c9177a58f`
- EXE SHA-256: `d024bc59299e4c76c4c71fdb59086e7b28a073ec3ff86a958c662d152402f641`
- inner manifest SHA-256: `cf63ff845360d7b5854bec79cf23b6dc2503f37c7b48ffc217b562b87b3db86a`
- signed feed SHA-256: `dfa889bbd6f527de0d0bc9235bf8c1f193c7cb4237fad4031f5d88250da59bc9`
- feed release sequence: `7053`
- Setup EXE SHA-256: `99744da26948a3eae6c1484d9a423a0100e524d7a3bf5f8b61e65591294a38a8`

## 운영 상태

- 자동 업데이트 피드: `https://byeollog.com/agent-updates/stable/win-x64.json`
- 패키지: `https://byeollog.com/agent-updates/releases/0.7.0.53/byeollog_agent_v07053_RAFFLE_ACTION_WIN_X64.zip`
- 기존 v0.7.0.52 이하의 불변 파일은 유지했다.
- 기존 관리형 설치 사용자는 다음 실행 시 서명된 피드를 통해 v0.7.0.53을 받는다.
- 신규 사용자는 `RELEASE_v07053/byeollog_agent_setup_v07053_WIN_X64.exe`를 사용한다.

## 남은 실기기 확인

- 실제 OBS 브라우저 소스에서 지급 GIF가 움직이는지 확인
- 실제 후원 100개/기준 33개에서 3장 안내가 뜨는지 확인
- 3회 추첨이 1/3→2/3→3/3 순서로 보이는지 확인
- Setup/Agent는 Authenticode 미서명이라 Windows SmartScreen 경고가 남을 수 있다. 업데이트 피드 RSA 서명과 ZIP 무결성 검증은 정상이다.

실기기 확인 전에도 서버 데이터와 기존 후원 처리에는 비파괴적으로 격리되어 있으나, 공개 안내에는 위 OBS canary 미수행 상태를 숨기지 말 것.
