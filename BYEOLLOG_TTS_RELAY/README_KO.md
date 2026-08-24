# 별록 TTS 고정 중계

`workers.dev`의 고정 주소를 현재 PC의 Cloudflare Quick Tunnel에 연결합니다. `byeollog.com`의 DNS나 네임서버를 변경하지 않습니다.

## 보안 경계

- 등록 가능한 원본은 루트 `https://*.trycloudflare.com` 주소뿐입니다.
- 원본 변경 요청은 별도 256비트 비밀값으로 HMAC-SHA256 서명합니다.
- 서명에는 UTC 초·무작위 nonce·정확한 요청 본문이 포함됩니다.
- 5분을 벗어난 요청과 이미 사용한 nonce는 거부합니다.
- 새 원본의 `/healthz`가 실제 정상일 때만 라우팅을 전환합니다.
- 일반 TTS 공유 비밀값과 중계 관리 비밀값은 서로 다릅니다.

## 엔드포인트

- `GET /healthz`: 활성 TTS 원본 상태
- `POST /__byeollog/admin/origin`: 서명된 원본 변경
- `GET /__byeollog/relay/meta`: 비민감 중계 상태

비밀값과 Wrangler OAuth 자격은 저장소에 포함하지 않습니다.
