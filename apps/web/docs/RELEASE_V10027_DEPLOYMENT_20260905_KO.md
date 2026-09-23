# 1.0.0.27 운영 배포 결과

- 상태: READY / production, 2026-09-05 19시대 KST
- 도메인: https://byeollog.com
- 배포 ID: `dpl_FWGiozC7MP2QuMtjG8PGK3mXwRXF`
- 배포 URL: https://observer_abangseladmin-fm9uvofuu-jminsu123-7345s-projects.vercel.app
- 이전 서버 배포: `dpl_7aQJ8HLZiUs9EbEPTJ9HVB8tytjW` (보존)
- 서버 sourceDigest: `ae0455a9d892d97b723849b2492f088ade1f8ddb5872164510659489110c9ec6`

## 반영한 것

직전 후속 안정화 수정의 Agent 27 패키지/설치 파일을 새 불변 GitHub Release에 게시하고, RSA-PSS 서명된 stable 피드와 홈페이지 `/agent/download`를 27로 전환했다. 서버에는 권한 검증 후 작업공간 한도를 차감하는 수정을 함께 반영했다. 기존 26 릴리스는 변경하지 않았다. DB 마이그레이션, 게이트웨이 재시작, 고객 PC의 설치판/OBS 조작은 하지 않았다.

## 검증

- 서버 검사 437/437 통과.
- 게시 전 ZIP의 실제 EXE `--update-preflight 1.0.0.27` 통과.
- 업로드한 ZIP/설치 EXE 각각 원격 전체 바이트 SHA-256 대조 통과.
- 설치 EXE `/VERYSILENT /VERIFYONLY`에서 실제 공개 주소 다운로드→압축 해제→패키지 무결성 검사 통과. 설치/실행은 하지 않음.
- 공개 stable 피드가 로컬 서명 검증을 통과한 피드와 정확히 일치. version 1.0.0.27, sequence 10027.
- 홈페이지 다운로드 redirect가 `/agent-updates/releases/1.0.0.27/Byeollog-Wallpaper-Setup-v1.0.0.27.exe`로 연결됨. 공개 주소를 따라 내려받은 EXE의 크기/해시 일치.
- 배포 서버 release-manifest sourceDigest 및 api/login.js 해시가 로컬 배포 소스와 일치.
- 배포 후 읽기 전용 스모크 2회, 14/14 통과. p95 약590ms. 단기 경로 확인이지 성능 부하 시험은 아님.
- 새 배포에 한정해 최근 10분 error 로그 조회: 조회 시점에 결과 없음. 지속 모니터링이나 장시간 무오류 보장은 아님.

## 아티팩트

| 파일 | 바이트 | SHA-256 |
| --- | ---: | --- |
| byeollog_wallpaper_v10027_WIN_X64.zip | 68,102,131 | `966327b3b85134a7dd3515159be8030d5b91cdc98fabc6d36034652b97bd02f1` |
| Byeollog-Wallpaper-Setup-v1.0.0.27.exe | 2,570,317 | `bf5c856b8a3790216f84073dc9cb9c72ef613521010ef256c6b4481bad0474e5` |

## 배포 중 보정

게시 전 강제 검사에서 Windows PowerShell 자식 프로세스가 PowerShell 7의 모듈 경로를 상속해 `Get-FileHash`를 찾지 못했다. 검사 우회 없이 해당 호스트의 기본 Utility 모듈을 명시적으로 가져오도록 `Test-AgentPackagePreflight.ps1`만 보정한 뒤 같은 검사를 통과했다. 앱 ZIP/EXE 바이트는 검증된 후보 그대로다.

## 후속 확인/복구

실제 사용자 PC에서는 앱 표시 버전 1.0.0.27 및 편집/OBS 표시를 확인해야 한다. 이번 검증으로 원격 PC 업데이트 완료를 대신 판정하지 않는다. 서버 롤백은 이전 READY 배포를 이용할 수 있지만 Agent는 이미 설치된 버전의 releaseSequence 하향을 차단하므로 서버 롤백만으로 설치판까지 되돌아가지는 않는다. Agent 결함 발생 시 보존된 26 소스/패키지를 기준으로 검증된 더 높은 sequence의 복구 릴리스를 준비해야 한다.
