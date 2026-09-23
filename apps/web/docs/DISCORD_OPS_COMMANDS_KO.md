# 디스코드 운영 상태 명령 연결

## 준비된 기능

| 명령 | 조회 내용 |
|---|---|
| `/상태` | 웹 최근 HTTP 응답, DB 감시 자료 조회, 수집기 상태, 백업 완료·실패 |
| `/수집` | 채널·방송 수, 전송 대기·격리·손상 건수, 최근 SDK 이벤트·서버 전송 시각 |
| `/백업` | 독립 백업 실행 시각, 완료·실패 개수, 보관 사본의 경과 시간 |
| `/자원` | CPU, 가용 메모리, 디스크, 프로세스 수, DB 연결·DB/파일 용량 |

서버 `1547124331757305856`의 채널 `1547124495465185290`에서 서버 관리자만 실행한다. 응답은 요청자에게만 보인다. 다른 채널·DM·일반 멤버 요청은 상태 자료를 읽기 전에 차단한다. 서버 재시작·백업 복원·업보 변경 명령은 없다.

## 최초 연결

1. [Discord Developer Portal](https://discord.com/developers/applications)에 로그인해 운영 전용 앱을 만든다. 기존 알림 웹후크만으로는 슬래시 명령을 받을 수 없다.
2. General Information의 **Application ID**, **Public Key**를 확인한다. 이 두 값은 공개 식별 정보다. Vercel Production에 `DISCORD_OPS_APPLICATION_ID`, `DISCORD_OPS_PUBLIC_KEY`로 등록하고 같은 검증된 소스를 다시 배포한다.
3. General Information의 **Interactions Endpoint URL**에 `https://byeollog.com/api/discord-ops`를 저장한다. Discord의 서명된 PING 검증이 통과해야 한다. 설정값이 없으면 엔드포인트는 503으로 잠겨 있다.
4. 앱은 **Guild Install**과 `applications.commands` 범위만으로 설치한다. bot 범위·Administrator 봇 권한·Message Content Intent는 필요 없다. 설치 URL의 `client_id`에는 실제 앱 ID를 넣는다.

   `https://discord.com/oauth2/authorize?client_id=APPLICATION_ID&scope=applications.commands&integration_type=0&guild_id=1547124331757305856&disable_guild_select=true`

5. OAuth2 화면의 **Client Secret**을 로컬 비공개 파일에 저장한다. 채팅·저장소·웹 환경변수에는 넣지 않는다. 이 값은 등록 순간에만 Discord의 `applications.commands.update` 범위 인증에 사용된다.
6. 아래 명령으로 운영 서버에 네 명령만 개별 등록한다. 같은 이름은 갱신하고 그 외 명령은 보존한다. 토큰은 출력하지 않으며 등록용 액세스 토큰은 종료 시 폐기를 시도한다.

   `node tools/Register-DiscordOpsCommands.mjs APPLICATION_ID "C:/Users/User/Desktop/discord-client-secret.txt"`

7. 운영 채널에서 관리자가 네 명령을 실행해 실제 응답·요청자 전용 표시를 확인한다. 일반 계정과 다른 채널에서 상태 자료를 읽을 수 없는지도 확인한다. 여기까지 마쳐야 실사용 연결 완료다.

## 측정값 해석

- NCP 기존 감시 주기(약 2분)에 집계값을 별도 비공개 단일 행에 게시한다. 후원·업보·닉네임·원문·토큰·로그를 조회 응답에 싣지 않는다.
- 명령은 이 단일 행만 읽는다. 수집기나 독립 백업을 실행하지 않고 NCP 생존 신호도 갱신하지 않는다. NCP가 중단되면 오래된 상태라고 표시한다.
- 전체 감시 자료가 6분, 서버 세부 상태가 9분, 웹 점검이 12분을 넘으면 최신 상태로 보지 않는다. 백업 기준은 30시간, 용량 집계는 2시간이다.
- `/수집`의 최근 SDK 이벤트는 후원만을 뜻하지 않는다. 방송이 없으면 오래된 이벤트 시각이 정상적으로 남을 수 있다. 백업 성공 기록 역시 현재 복원 시험 성공을 의미하지 않는다.
- 공개 서비스의 응답과 집계값을 보는 기능이며 월간 청구·요금제 잔여 한도·최대 수용 인원을 확정하는 도구는 아니다.
- DB 자료 조회가 실패하면 정상이라고 표시하지 않는다. Vercel 자체가 중단되면 이 명령도 응답할 수 없다. 기존 독립 장애 알림은 별도 경로로 유지된다.
- 요청 서명·시각·앱 ID를 검증한다. 인스턴스별 5초 사용자 간격, 15초 자료 캐시와 동시 조회 합치기를 적용한다. 전역 분산 속도 제한이나 무제한 디도스 방어를 보장하지 않는다.

## 운영·복구

NCP 설정 `/etc/byeollog-ops-monitor.json`의 `discordSnapshotEnabled`가 게시 기능만 제어한다. 기존 알림·수집은 그대로 동작한다. 웹 설정 두 개를 제거한 뒤 재배포하면 명령 수신을 잠글 수 있다.

NCP 교체 전 파일과 설정은 `/var/lib/byeollog-ops/discord-ops-20260910-rollback`에 보관한다. 복구할 때도 수집기 이미지·컨테이너·재시작 상태는 변경하지 않는다. DB 단일 행은 매번 덮어쓰며 기록 이력을 누적하지 않는다.

공식 근거: [Discord 명령 등록](https://docs.discord.com/developers/interactions/application-commands), [응답 및 서명](https://docs.discord.com/developers/interactions/receiving-and-responding), [등록용 OAuth2 인증](https://docs.discord.com/developers/topics/oauth2).
