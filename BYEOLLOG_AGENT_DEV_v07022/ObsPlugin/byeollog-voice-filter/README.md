# 별록 신원보호 OBS 필터

`byeollog_voice_filter_v1`은 OBS 마이크 입력에 적용되는 로컬 음정 변조 필터입니다.
음성은 PC 밖으로 전송하지 않으며 Signalsmith Stretch를 이용해 `-4`/`+4` 반음 프리셋을 처리합니다.

- 플러그인 소스: GPL-2.0-or-later
- DSP 엔진: Signalsmith Stretch/Linear, MIT
- 빌드 대상: Windows x64, OBS Studio 30.2 이상
- 설치 위치: `%ProgramData%\obs-studio\plugins\byeollog-voice-filter\bin\64bit`

Agent가 서명·해시가 고정된 내장 DLL을 설치하며, 최초 설치 또는 업데이트 뒤에는 OBS를 한 번 재시작해야 합니다.
GPL 대응 소스와 정확한 빌드 스크립트는 플러그인 설치 폴더의 `source` 하위에 함께 설치됩니다.
