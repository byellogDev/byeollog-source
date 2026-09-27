# Windows 바로가기 Unicode 저장·CI 실패 수정 · 2026-09-28

## 상태와 범위

- 상태: 설치 래퍼 소스·회귀 검사 수정. 설치 EXE 재빌드·배포 없음.
- 대상: 온라인 설치 래퍼의 바탕화면 바로가기 생성·기존 대상 읽기. 기존 서명 ZIP·업데이트 목록·Agent 실행 코드·운영 수집기는 변경하지 않는다.
- 이전 기준: [BOM 수정](2026-09-27-installer-shortcut.md), [연구 후보 수정](2026-09-27-broadcast-observation-fix.md).

## 목적과 변경 전 문제

커밋 `916f7a2`의 [GitHub Actions 실행](https://github.com/byellogDev/byeollog/actions/runs/36281864125)에서 Node 검사 802건 중 801건 통과, 한글 바로가기 저장 1건이 실패했다. 소스 일치·게시 전 검사는 성공했고, 후속 웹·.NET 빌드 단계는 실행되지 않았다.

실패는 한글 리터럴 파싱 확인 이후 `WScript.Shell`의 바로가기 저장 단계에서 발생했다. GitHub Windows의 오류 경로에 한글이 물음표로 나타났다. 앞선 BOM 수정은 스크립트 파싱만 해결했으며 다른 Windows 환경의 저장 경로까지 검증하지 못했다. 메일의 전체 작업 실패 표시는 이 단일 작업의 실패 결과이며 운영 수집 장애 로그가 아니다.

## 변경 내용과 소유 구성요소

- `Invoke-AgentInstall.ps1`: BOM 유지. `IShellLinkW`와 `IPersistFile`로 Unicode 경로의 바로가기를 저장·읽는다. 기존 파일의 소유 대상 검사와 타 프로그램 바로가기 보존 조건은 유지한다. COM 객체는 사용 후 해제한다.
- `installer-shortcut-encoding.test.mjs`: 설치 래퍼에 실제 포함된 helper를 실행한다. 한글 상위 폴더·바로가기 이름·실행 파일 경로에서 저장 후 대상 경로를 다시 읽고, 다른 프로그램을 가리키는 바로가기도 확인한다. BOM 제거 시 파싱 회귀 검사도 유지한다. 앱·바탕화면은 건드리지 않고 임시 폴더에서만 검사한다.
- CI 워크플로·합격 기준·실패 처리·운영 배포 경로 변경 없음. 실패 검사를 삭제하거나 건너뛰지 않는다.

API 근거: Microsoft [IShellLinkW](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nn-shobjidl_core-ishelllinkw), [IPersistFile.Save](https://learn.microsoft.com/en-us/windows/win32/api/objidl/nf-objidl-ipersistfile-save).

## 검증

| 항목 | 방법 | 결과 / 근거 | 미검증 범위 |
| --- | --- | --- | --- |
| 전체 Node 회귀 | `npm test`, 로컬 Windows | 802건 통과, 실패·건너뜀 0 | GitHub 결과는 아래 PR Checks로 별도 추적 |
| 바로가기 실제 저장 | Windows PowerShell 5.1, COM 파일 생성·읽기 | 한글 폴더·파일명·대상 경로 왕복 성공 | 새 EXE 설치 전체 흐름 |
| 소스 일치 | `npm run verify:source` | 1,183개, 의도된 변경 41개, 실패 0 | 배포 상태를 뜻하지 않음 |
| 웹 빌드 | `npm run build:web` | 자산 40개 생성 성공 | 운영 배포 없음 |
| GitHub 재검사 | [PR #4 Checks](https://github.com/byellogDev/byeollog/pull/4/checks) | 이 수정 커밋의 Windows 작업 결과·실행 링크를 PR에 기록 | 로컬 통과로 원격 성공을 대신하지 않음 |

## 사용자 영향과 복구

이번 변경은 아직 다운로드 설치 EXE에 포함되지 않는다. 기존 배포 파일과 Microsoft에 제출한 파일을 교체하지 않았다. 배포 후보를 만들 때 실제 EXE 설치와 Agent 내부 바로가기 갱신 경로는 별도로 검증해야 한다. 백신 탐지는 이번 CI 실패와 별개다.

운영 배포가 없어 서비스 복구 조치는 필요하지 않다. 필요 시 이번 래퍼·회귀 검사 커밋만 되돌릴 수 있지만 기존 비한국어 Windows 저장 실패가 다시 남는다.

## 제거·보존한 파일과 근거

기존 설치 패키지·데이터 삭제 없음. 실패 로그는 GitHub Actions에서 확인하며 회원 정보·인증값·원문 운영 로그는 문서에 포함하지 않는다.

## 관련 PR·커밋·이전 버전

[PR #4](https://github.com/byellogDev/byeollog/pull/4)에 코드·검사·이 문서를 함께 커밋한다. 이전 BOM 수정 커밋은 `b462243`, 실패가 보고된 연구 커밋은 `916f7a2`다. 이번 수정은 연구 후보 재배포를 수반하지 않는다.
