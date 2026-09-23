# 별록 Agent 단일 로컬 오버레이 설계·인계

기준일: 2026-08-31 KST
상태: 운영 배포 완료 (`Agent 0.7.0.111`, Edge `agent-runtime-g3a` v15)

## 결정

- OBS에는 기존 주소 `http://127.0.0.1:43120/overlay` 하나만 등록한다.
- 같은 문서 안에서 풍벽지는 지속 레이어, 액션은 일시 레이어로 합성한다.
- 레이어 우선순위는 `풍벽지(1) < 일반 액션(100) < 추첨(110) < 섬광(120) < 화면 효과(130)`로 고정한다.
- 웹 편집은 서버 revision을 증가시킨다.
- Agent의 기존 claim 요청이 보유 revision을 함께 보내며, 서버는 revision이 달라졌을 때만 스냅샷을 응답한다.
- Agent가 이미지를 한 번 내려받아 검증·캐시하고 OBS에는 localhost 자산 주소만 제공한다.
- 서버는 최종 원본이고 로컬 상태는 삭제 후 다시 받을 수 있는 복구 가능한 투영본이다.
- SOOP SDK 연결은 중앙 게이트웨이에 유지해 같은 계정에 중복 연결하지 않는다.

## 실행 흐름

```text
웹 배치/표시/합병 수정
  → DB 저장 + wallpaper revision 증가
  → 기존 Agent claim에 knownWallpaperRevision을 최대 5초 간격으로 동승
  → revision 동일: 작은 unchanged 응답
  → revision 변경: 장치 인증된 snapshot 응답
  → Agent 이미지 검증·content-addressed cache·상태 원자 저장
  → 기존 localhost /overlay 문서가 풍벽지 레이어만 갱신
  → 액션 발생 시 동일 문서의 상위 레이어에서 재생
```

## 서버 계약

신규 service-role 전용 RPC:

- `g3a_get_wallpaper_snapshot_v1`
- 기존 Agent 장치 ID/secret, 사용자 세션, runtime release를 모두 검증한다.
- `knownRevision == currentRevision`이면 tile이나 이미지 정보를 읽지 않고 `{changed:false, revision}`만 반환한다.
- 변경 시 선택 방송 회차, 표시 허용 목록, 합병 규칙, 최대 216개 카드, 최신 시그풍/룰렛 자산 참조를 반환한다.
- 브라우저 역할 `public`, `anon`, `authenticated`에는 실행 권한이 없다.

기존 `agent-runtime-g3a`의 `claim` 응답은 새 Agent가 `knownWallpaperRevision`을 보낸 경우에만 `wallpaper` 필드를 추가한다. 구버전 Agent에는 큰 응답을 보내지 않는다.

## 2026-08-31 액션/풍벽지 분리 확정

- `http://127.0.0.1:43120/overlay`: 액션 전용. 풍벽지 상태를 조회하거나 풍벽지 이미지를 로드하지 않는다.
- `http://127.0.0.1:43120/overlay/wallpaper`: 풍벽지 전용. 액션 상태를 조회하거나 액션 영상을 로드하지 않는다.
- OBS 소스 순서는 `별록 액션`이 위, `별록 풍벽지`가 아래다.
- 서버 claim은 액션 RPC를 먼저 실행한다. 실행할 액션이 있으면 풍벽지 스냅샷 RPC를 건너뛰고 즉시 반환한다.
- 풍벽지 변경 확인은 Agent 유휴 poll 중 최대 5초 간격으로만 수행한다. 이 때문에 풍벽지 데이터 경로가 액션 실행 임계 경로에 들어가지 않는다.

## Agent 계약

- 마지막 정상 상태: Agent 데이터 루트 아래 `wallpaper-overlay-state-v1.json`
- 이미지 캐시: `wallpaper-assets-v1/<sha256>.<ext>`
- 허용 이미지 호스트는 운영 Supabase와 공식 SOOP 자산 도메인으로 제한한다.
- 리다이렉트, HTTP, 자격 증명이 포함된 URL, 12MB 초과 파일을 거부한다.
- PNG/WebP/GIF/JPEG 헤더와 가능한 경우 서버의 크기·SHA-256을 검증한다.
- 새 이미지가 준비되지 않으면 실행 중인 액션은 영향받지 않으며 풍벽지 동기화만 재시도한다.
- Agent 재시작 중에도 마지막 정상 풍벽지를 먼저 localhost에서 제공한다.

## localhost HTTP 표면

- `/overlay`: 기존 액션과 풍벽지를 합성한 유일한 OBS 문서
- `/overlay/state`: 기존 액션 상태
- `/overlay/wallpaper-state`: 로컬 풍벽지 상태
- `/overlay/assets/<token>`: 기존 액션 자산
- `/overlay/wallpaper-assets/<sha256>`: 검증된 풍벽지 자산

모든 경로는 기존처럼 `127.0.0.1`에만 바인딩한다. 외부 요청으로 상태를 바꾸는 API는 추가하지 않는다.

## 배포 순서

1. DB RPC 배포
2. Edge Function 배포 — 구버전 Agent는 새 필드를 요청하지 않으므로 호환
3. 웹 미리보기 배포와 확인 후 운영 승격
4. Agent 새 버전 게시 — `0.7.0.111 / releaseSequence 7111`
5. 기존 액션 회귀, 빈 풍벽지, 다중 이미지, 오프라인 재시작, 웹 변경 반영 확인
6. 운영 지표에서 기존 Vercel 풍벽지 1초 폴링이 사라졌는지 확인

롤백은 Agent stable feed를 직전 버전으로 다시 서명해 되돌리면 된다. DB 함수와 Edge 응답 필드는 additive라서 구버전 Agent 동작을 바꾸지 않는다.
