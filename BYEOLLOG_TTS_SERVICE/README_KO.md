# 별록 당첨자 전용 CosyVoice 3 TTS 서비스

이 컨테이너는 일반 공개 TTS API가 아닙니다. 운영 `agent-runtime-g3a`만 공유
비밀로 호출하며, Edge Function은 현재 추첨 execution과 장치 lease를 DB에서
검증한 뒤 확정된 당첨자 이름만 전달합니다.

## 운영 계약

- `POST /v1/raffle-winner`: `audio/wav`, 최대 2 MiB
- 응답의 `x-byeollog-voice-key`, `x-byeollog-voice-version`,
  `x-byeollog-audio-sha256`를 모두 검증해야 합니다. 하나라도 요청 후보와
  다르면 음성을 재생하거나 캐시하지 않습니다.
- `GET /healthz`: CUDA 모델 준비 여부
- 필수 환경변수: `BYEOLLOG_TTS_SHARED_SECRET` (43자 이상 무작위 값)
- 단일 worker와 단일 합성 잠금을 사용합니다. 동일 음성키가 다른 문구에
  재사용되면 반환하지 않고 실패합니다.
- access log를 끄고 닉네임과 음성 본문을 로그에 남기지 않습니다.

## 빌드와 실행

RTX GPU가 연결된 Docker Desktop/NVIDIA Container Toolkit 환경이 필요합니다.
모델과 CosyVoice 소스는 Dockerfile에 고정된 commit/revision만 사용합니다.

참고 음성은 이미지나 Git에 넣지 않습니다. 실행 시 상업적 사용과 보이스
클로닝 권리를 모두 확보한 음성 파일을 읽기 전용으로 마운트하십시오. 현재
개발 참고 음성은 공개 배포 권리가 별도로 확인되기 전까지 로컬 베타에서만
사용합니다.

```powershell
docker build -t byeollog-raffle-tts:cosyvoice3 .
docker run --rm --gpus all -p 127.0.0.1:8080:8080 `
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=256m `
  --mount "type=bind,src=C:\authorized\reference.mp3,dst=/run/byeollog-voice/reference.mp3,readonly" `
  -e BYEOLLOG_TTS_SHARED_SECRET='<43자 이상 무작위 값>' `
  byeollog-raffle-tts:cosyvoice3
```

서비스 버전은 `raffle-winner-cosyvoice3-v1`입니다. 공개 API와 DB voice key
도메인은 기존 `raffle-winner-voice-v1`을 유지하되, Agent 캐시는 v2 폴더와
manifest로 분리하여 예전 MeloTTS 음성을 재사용하지 않습니다.

CosyVoice 소스와 `Fun-CosyVoice3-0.5B-2512` 모델은 Apache-2.0 고정 버전을
사용합니다. `/licenses/CosyVoice.txt`와 모델의 라이선스 고지를 보존하십시오.
