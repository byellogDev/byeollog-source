# 별록 자체 룰렛 비활성 자산

SOOP Chat SDK 승인 전 운영 배포에 포함하지 않는 룰렛 자산이다. `.vercelignore`로 배포 입력에서 제외한다.

## 잠정 룰렛 사운드

- 파일: `audio/roulette-spin-v1.wav`
- 선택안: 5번 `cute_broadcast`
- 길이: 정확히 3.000초
- 형식: PCM WAV, 48 kHz, stereo, 16-bit
- 바이트: `576044`
- SHA-256: `651376fec5b8424825269a25e6041e591711ed1c55642fb61e20574f35382bec`
- 상태: 잠정 선택. 운영 룰렛 및 Agent에는 아직 연결하지 않음

승인 후 최종 음량과 OBS 출력 품질을 검증하고, 불변 해시를 활성 migration·Agent manifest와 함께 고정한다.
