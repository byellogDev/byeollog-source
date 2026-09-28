# 설치기 1.0.0.43-r2 · 2026-09-29

## 상태와 범위

- 상태: 오류 재현·수정·검증 및 공식 다운로드 운영 반영 완료 (2026-09-29 KST).
- 대상: Windows 온라인 설치 EXE의 완료 경로 전달, 공식 다운로드 리다이렉트.
- 이전: [Agent 1.0.0.43](2026-09-29-agent-10043.md). Agent 실행 파일·ZIP·서명 업데이트 피드(sequence 10044)·관리자 API는 유지.

## 목적과 변경 전 문제

사용자가 설치 마지막 단계에서 `설치된 실행 파일의 위치가 올바르지 않습니다` 오류를 보고했다. PowerShell 래퍼가 실행 파일 경로를 UTF-16LE로 저장하지만 Inno Setup `LoadStringsFromFile`은 그 바이트를 경로 문자열로 정상 해석하지 못했다. 실제 Inno 런타임에서 기존 writer의 정상 경로 3건 모두 실패하고, UTF-8 BOM으로 수정한 같은 경로 3건 모두 통과함을 확인했다.

이전 `VERIFYONLY`는 다운로드·패키지 무결성만 확인하고 `InstallSucceededValue`가 false여서 경로 결과를 읽는 부분을 실행하지 않았다. 그 검사로 전체 설치를 확인할 수 없었으며 이번 결함을 놓쳤다. 사용자의 현재 PC에서 모든 설치 파일이 존재하는지는 해당 화면만으로 확정하지 않는다.

## 변경 내용과 소유 구성요소

- `Invoke-AgentInstall.ps1`: 결과 경로를 UTF-8 BOM으로 저장. 허용 설치 경로·버전 형식 검사는 완화하지 않음.
- 온라인 EXE만 r2로 새로 게시. 기존 EXE·ZIP·서명 피드를 덮어쓰지 않음.
- 실제 Inno 수신 검사 도구 및 PowerShell 5.1 한글 경로 회귀 검사 추가. 이후 릴리스 절차에 필수 경로 전달 검사 명시.
- 웹 배포는 기존 운영 647개 파일 중 `vercel.json`의 다운로드 대상 한 곳만 변경. 관련 없는 로컬 웹 변경은 운영 바이트 보존.

## 검증

| 항목 | 방법 | 결과 | 한계 |
| --- | --- | --- | --- |
| 원인 재현 | 실제 PowerShell writer + Inno 읽기·검사 | 수정 전 일반/한글 등 3경로 모두 실패 | 고객 PC 로그 원문은 없음 |
| 수정 검증 | 같은 도구·같은 경로 | 3경로 통과, 외부/상위이동/잘못된 버전 4경로 거부 | 실제 고객 PC 전체 설치 아님 |
| 자동 회귀 | 전체 Node | 836건 통과, 실패·skip 0 | 실제 사용자 로그인·OBS 아님 |
| 소스 대조 | manifest | 1,183개·의도 변경 48개, 실패 0 | 배포 증거와 구분 |
| 새 EXE | Inno 빌드, 공식 ZIP 다운로드 VERIFYONLY | 종료 코드 0, ZIP·서명 피드 유지 | VERIFYONLY로 경로 완료 검증을 대신하지 않음 |
| 후보·운영 | 소스 647개·라우팅·7개 응답·공개 EXE 전체 SHA-256 | 다운로드 대상 한 곳만 변경, hnd1 유지, 기존 EXE 및 피드 보존 | 고객 PC 설치 완료는 별도 확인 |

초기 새 회귀 검사의 PowerShell 호출에서 실행 정책 인자가 빠져 실행이 거부됐다. 설치기와 같은 프로세스 단위 실행 인자를 적용한 뒤 전체 검사를 통과했다. 사용자 시스템 실행 정책은 변경하지 않았다.

## 사용자 영향과 복구

- 기존 오류 EXE 대신 r2 EXE를 다시 내려받아 실행한다. 사용자 설정 초기화·기존 설치 삭제는 필요하지 않다.
- 고정 링크: <https://byeollog.com/agent-updates/releases/1.0.0.43/Byeollog-Wallpaper-Setup-v1.0.0.43-r2-online.exe>
- EXE SHA-256: `30f4e0ef3070d52f49e97457651df68213cd2394e0ecac4a02bf6e701e736b36`.
- Defender 탐지 여부와는 별개인 설치 경로 오류다. 새 파일의 고객 PC 백신 판정·전체 설치 완료는 이번 검사로 보증하지 않는다.
- 다운로드 연결 장애 시 직전 웹 배포로 복구한다. 이전 EXE는 원본 해시로 보존하나, 그 파일에는 이번 경로 결함이 남는다.

## 제거·보존한 파일과 근거

기존 설치본·ZIP·사용자 설정은 제거하지 않는다. 재현 fixture·배포 영수증은 비공개 `.local/installer-path-20260929/`에 보존한다. 공개 Git에는 코드·시험 도구·해시·문서만 포함한다.

## 관련 PR·커밋·이전 버전

- [PR #4](https://github.com/byellogDev/byeollog/pull/4)
- [1.0.0.43 릴리스 자산](https://github.com/byellogDev/byeollog-releases/releases/tag/agent-v1.0.0.43)
- Inno 공식 계약: [LoadStringsFromFile](https://jrsoftware.org/ishelp/topic_isxfunc_loadstringsfromfile.htm).
