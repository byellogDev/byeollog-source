# 수집 구조 비교: 별록 · Meloming · Rogi

> 2026-09-25 후속 확인: 아래 180초 읽기 시한의 원칙을 별록 OAuth 후보에서 충분히 검증하지 못했습니다. 정상 유휴 연결을 끊는 합성 사례를 확인하여 무수신 단독 종료를 제거했습니다. 원본의 manager 재연결과 후보의 `needs_review` 중단 정책은 동등하지 않습니다. [수정·구조 대조](../releases/2026-09-25-idle-connection-fix.md).

확인일: 2026-09-23. 문서·소스 정적 검토이며 외부 수집기를 실행하거나 운영 설정을 변경하지 않았다. 외부 프로젝트의 운영 성능·무누락·500개 동시 연결을 독립 검증한 보고서가 아니다.

## 결론

별록의 공식 SDK·OAuth·워크스페이스 권한 경계를 유지하면서, 오류 진단과 수집 공백 표시를 먼저 개선하는 것이 적절하다. 이후 방송 탐색 분리, 워커 담당권·안전한 인계, 후원 전송 처리량을 단계적으로 검증한다. Go로 전면 재작성하거나 외부 API로 운영 후원을 대체할 근거는 없다.

## 비교 대상과 출처

- [Meloming 공개 원본](https://github.com/dylabs/meloming-chat-collector/tree/85b8aa1dd9284ded8717c97dc6aee556b5bcf70a): `85b8aa1dd9284ded8717c97dc6aee556b5bcf70a`.
- [Rogi API 문서](https://docs.rogi.chat/): 관측계정A 한 채널의 공개 방송 상태·채팅 API. 멜로밍과 별개로 완성된 동일 제품으로 취급하면 안 된다.
- 문서가 연결하는 [Rogi 수집기](https://github.com/h66rogi/rogi-collector/tree/48838b91da490d9bad1b41e3f9849279c5fdaeef): `48838b91da490d9bad1b41e3f9849279c5fdaeef`.
- Rogi의 [반입 기록](https://github.com/h66rogi/rogi-collector/blob/48838b91da490d9bad1b41e3f9849279c5fdaeef/docs/source-imports.md)은 위 멜로밍 커밋을 기반으로 후원 내구성·권한·쿠키 인증 등을 추가했다고 명시한다.
- 별록 비교 기준: 현재 `services/soop-gateway`, `apps/collector-runtime/lib/soop-gateway-api.js`, 시험용 `tools/soop-browserless-lab` 소스. 과거 사본의 API 구현을 현재 운영 API와 혼동하지 않았다.

## 구조 차이

| 항목 | 별록 운영 / 시험 후보 | Meloming / Rogi |
|---|---|---|
| SOOP 연결 | 운영은 Chromium에서 공식 SDK, 후보는 Node에서 같은 SDK와 ws 전송 구현 | Go에서 player API 조회 후 WebSocket 패킷 직접 생성·해석 |
| 브라우저 비용 | 운영 Chromium 프로세스 공유, 계정별 별도 context/target. 후보는 계정별 제한 컨테이너 | 지속 채팅 연결에 브라우저 없음. Rogi는 연령제한 방송 인증을 위해 별도 Selenium 로그인 컴포넌트 사용 |
| 인증 목적 | 스트리머 OAuth 및 소유권과 워크스페이스의 일치 검사 | Rogi의 수집용 로그인 계정과 관측 방송 대상은 별개. 별록 계정 소유권 계약의 대체물이 아님 |
| 방송 탐색 | 현재 계정별 연결 루프에서 오프라인 대기·재시도 | discover가 방송을 찾고 coordinator가 worker에 배정 |
| 서버 확장 | 한 gateway의 계정 루프. 서명된 수집 권한과 담당 워커의 독점 할당은 다른 문제 | worker 부하 비율로 분배하고 DB에 담당 상태 기록, 명령 유실 시 재대조 |
| 후원 전달 | 암호화 outbox, 계정별 순서, 재전송 및 수신측 이벤트 소유권 검사 | 원본은 최근 채팅 위주. Rogi는 일반 별풍선에 별도 spool/journal·ACK 경로 추가 |
| 수집 품질 표현 | 운영 상태·큐 상태와 후보 비교 기록 존재. 후보 SDK 오류 상세가 누락됨 | Rogi API는 방송 여부·수집 연결·이어받기 불가·보관 공백을 명시적으로 구분 |

외부 구조: [architecture](https://github.com/dylabs/meloming-chat-collector/blob/main/docs/architecture.md), [coordination](https://github.com/dylabs/meloming-chat-collector/blob/main/docs/design/coordination.md), [SOOP connector](https://github.com/dylabs/meloming-chat-collector/blob/main/worker/internal/connector/soop.go), [Rogi cookie-auth](https://github.com/h66rogi/rogi-collector/blob/48838b91da490d9bad1b41e3f9849279c5fdaeef/cookie-auth/README.md).

## 반영 우선순위

### 1. 후보의 오류 증거 보존과 상태 분류

`shadow-observer.mjs`는 `sdk.handleError(()=>finish('sdk_error'))`로 인자를 버린다. 운영 `browser-session.mjs`는 코드·메시지를 받지만 후보는 그러지 않아 22:18 및 23:13 중단의 원인을 구분할 수 없다. 이는 실제 원인을 발견했다는 뜻이 아니라 원인 분석을 막는 구현 결함을 확인했다는 뜻이다.

다음 후보 버전에서는 허용된 오류 코드, 연결 단계, close code, 마지막 프레임·pong 시각, ready 이후 경과 시간을 제한된 크기로 저장해야 한다. 원문 오류를 그대로 보관하면 토큰·개인정보가 섞일 수 있으므로 고정 분류와 마스킹을 적용한다. `offline`, 인증 실패, 전송 단절, 프로토콜 오류, SDK 내부 오류, 판정 불가를 구분하고 방송 종료는 별도 조회 증거로만 판정한다.

Rogi의 [상태 계약](https://docs.rogi.chat/status)처럼 확인 불가를 방송 종료로 바꾸지 않는다. 현재 48시간 시험의 안전 중단을 해제하거나 관측 중 코드를 바꾸지 말고, 기존 실패는 보존한 채 후속 구간을 명시한다.

통과 기준: 합성 오류별 정확한 분류, 민감정보 기록 차단, 실제 다음 실패에서 원인 분류에 필요한 증거 확보.

### 2. 연결 생존·입장 성공·수신 성공을 분리

멜로밍 SOOP 구현은 60초 ping, 180초 읽기 시한, pong·수신 프레임으로 시한 갱신을 사용한다. 값 자체보다 조용한 방송과 응답 없는 소켓을 구분하는 원칙을 가져온다. 공식 SDK 위에 임의의 제어 패킷을 중복 송신하지 않고 SDK·ws에서 얻는 상태로 먼저 감시한다.

원본은 login ACK 후 join을 보낸 시점에 연결 성공을 알린다. Rogi는 요청한 join의 성공 ACK까지 확인하도록 보강했다. 별록은 SDK ready와 방 소유권 검사를 이미 사용하므로 원본의 더 약한 조건으로 바꾸면 안 된다. [Rogi connector와 테스트](https://github.com/h66rogi/rogi-collector/blob/48838b91da490d9bad1b41e3f9849279c5fdaeef/worker/internal/connector/soop_donation_test.go).

통과 기준: 채팅 없는 정상 방송 유지, 반쯤 끊어진 연결 탐지, 입장 거절 시 정상 표시 금지, 종료 후 소켓·타이머 회수.

### 3. 수집 공백을 사용자 상태와 운영 지표에 표시

Rogi는 [cursor와 chat.gap](https://docs.rogi.chat/chat-stream), [knownArchiveGap 및 complete=false](https://docs.rogi.chat/history)를 제공한다. 저장된 자료가 있어도 완전 수집을 보증하지 않는 계약이다.

별록에는 마지막 정상 수신 시각, 단절 시작·복구 시각, 미전송 후원 수·가장 오래된 대기 시간, 재연결 공백의 복구 가능 여부를 구분해 표시하는 것이 유용하다. 별록이 받기 전에 SOOP에서 놓친 이벤트는 outbox로 복구할 수 없다. 내부 ACK 이후 누락과 원천 수신 누락도 구분해야 한다.

### 4. 방송 대기 감시 분리와 담당 워커 인계

별록에서 이미 조회를 확인한 공식 방송 상태 API를 우선 후보로 사용한다. 호출량 제한·지터·429·인증 갱신·방송 시작 감지 지연을 검증해야 한다. 멜로밍의 전체 방송 탐색을 그대로 가져올 필요는 없다.

복수 worker 도입 전에는 계정별 원자적 담당권, 만료, 증가하는 세대 번호와 이전 담당자의 신규 기록 거부를 구현·검증한다. 기존 서명 lease가 있다는 사실만으로 여러 gateway의 독점 담당권이 확보되지는 않는다. 현재 gateway는 활성 workspace 목록을 읽고 각자 루프를 시작한다.

멜로밍의 새 연결 준비 후 이전 연결 종료라는 인계 원칙은 유용하다. 다만 별록에서는 중복 로그인 영향, 동시에 수신한 후원의 식별, 이전 담당자가 이미 저장한 미전송 이벤트의 처리까지 정해야 한다. 단순 내용 해시는 같은 사람이 같은 수량을 연달아 후원한 정상 두 건을 지울 수 있다. 현재 DB 소유권 검사도 보존해야 한다.

통과 기준: 두 worker의 동시 요청, worker 강제 종료, 늦은 이전 worker 복귀, 네트워크 분리, 같은 내용 연속 후원에서 계정 혼선·잘못된 중복 제거 없음.

### 5. 후원 내구성은 유지하고 전송 병목 개선

별록은 이미 암호화 outbox와 계정별 직렬 처리, 다른 계정 간 병렬 전송을 갖고 있다. 따라서 처음부터 큐를 교체할 이유는 없다. 현재 병렬 전송 2개의 실제 API 지연·적체를 측정하고 계정별 순서를 지키는 배치 전송 또는 worker별 분산을 검토한다.

Rogi는 일반 별풍선(cmd 18)을 채팅 drop 경로 전에 별도 sink에 넘기며 저장 실패 시 연결을 닫는다. [spool](https://github.com/h66rogi/rogi-collector/blob/48838b91da490d9bad1b41e3f9849279c5fdaeef/worker/internal/pipeline/spool.go)의 fsync·checksum·재시작 복구와 [구현 상태](https://github.com/h66rogi/rogi-collector/blob/48838b91da490d9bad1b41e3f9849279c5fdaeef/docs/implementation-status.md)의 응답 유실 시험은 별록의 장애 시험 항목으로 참고할 가치가 있다.

통과 기준: 수신 API commit 후 응답 유실, 프로세스 강제 종료, 디스크 부족, 손상 파일, 특정 계정 적체에서 후원 유실·중복 반영·타 계정 정체를 확인한다. 접속 차단은 아직 받지 못한 후원을 놓칠 수 있으므로 저장 실패 시 중단도 무손실 보증으로 표현하면 안 된다.

## 그대로 도입하면 안 되는 부분

- **원본의 메시지 drop 정책:** SOOP 버퍼 256개가 차면 drop callback을 부르고 해당 메시지를 버린다. 후원까지 같은 경로로 다루는 원본을 별록 후원 경로로 대체하지 않는다. [원본 SOOP 구현](https://github.com/dylabs/meloming-chat-collector/blob/85b8aa1dd9284ded8717c97dc6aee556b5bcf70a/worker/internal/connector/soop.go).
- **기능 동등성:** 검토한 두 connector에 영상후원 cmd 105 처리 분기가 없다. Rogi의 내구성 있는 donation sink도 일반 별풍선 중심이다. 별록의 영상후원·룰렛·소유권 계약이 자동으로 충족되지 않는다.
- **공개 Rogi API의 직접 의존:** 공개 문서는 관측계정A 한 채널의 채팅 제공이며, 별록의 다계정 후원 입력 계약이 아니다. 전체 WS 32개 등의 제한은 외부 API 소비 한도이지 내부 수집기의 최대 방송 수가 아니다. [제한](https://docs.rogi.chat/errors).
- **인증 교체:** 수집용 SOOP ID/PW·쿠키 관리는 별도의 보안·운영 부담이다. 현재 OAuth를 이를 이유로 교체하지 않는다.
- **격리 보증:** 채널별 Go 객체·goroutine·저장 키 분리는 프로세스/컨테이너 수준의 자격증명 격리와 같지 않다. 별록 후보의 계정별 격리와 발신 목적지 제한은 별도로 유지한다.
- **500명 결론:** 브라우저 렌더러 비용을 줄일 가능성은 있지만 언어 변경만으로 달성되지 않는다. 공식 API 호출량, 동시 연결 제한, TLS, 재연결 집중, 이벤트율, DB/큐 처리량까지 시험해야 한다. 기존 프로세스는 전송·큐·관측 보조 프로세스를 포함하고 후보는 수신 전용이므로 RSS 단순 비율을 절감률로 쓰지 않는다.
- **코드 반입:** 원본 라이선스는 AGPL-3.0-only이며 Rogi도 원본 LICENSE/NOTICE를 보존한다. 지금은 설계 비교만 수행했다. 실제 코드 반입은 라이선스와 별록 공개 범위 검토를 먼저 거쳐야 한다. [LICENSE](https://github.com/dylabs/meloming-chat-collector/blob/main/LICENSE).

## 권장 작업 순서

1. 현재 관측 증거 보존 → 후속 후보에 오류 진단·생존 상태·영상후원 비교 누락 보완.
2. 기존 Chromium과 Node 후보의 방송 시작·종료·재시작·토큰 갱신·후원 종류별 대조.
3. 공식 API 기반 방송 대기 분리.
4. 계정별 담당권·인계와 후원 큐 장애 시험.
5. 동급 Linux에서 실제 전송/저장 경로를 포함한 50→100→500 부하 시험.

이번 작업으로 운영 코드·DB·수집 연결·배포·48시간 관측 프로그램은 변경하지 않았다. 공개 자료의 설명과 코드만 비교했으며 외부 저장소 테스트를 실행하지 않았다.
