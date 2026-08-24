# 별록 에이전트 0.7.0.4 공개판 2

## 목적

사용자 데이터 경로를 대소문자까지 정확히 `%LOCALAPPDATA%\ByeollogAgent`로 통일한 수정판이다.
0.7.0.3의 일반 승인 사용자 자동화 화면 교정과 진단 로그 보강도 포함한다.

## Windows 설치

1. ZIP을 완전히 압축 해제한다.
2. `00_BUILD_AND_INSTALL_PUBLIC_FIX.cmd`를 실행한다.
3. `DONE - Byeollog Agent 0.7.0.4 installed successfully`를 확인한다.
4. 별록 에이전트를 실행하고 기존 계정으로 로그인한다.

## 데이터 이전

- 새 기본 경로: `%LOCALAPPDATA%\ByeollogAgent`
- 새 진단 ZIP 경로: `%LOCALAPPDATA%\ByeollogAgent\support-bundles`
- 첫 실행 때 기존 `%LOCALAPPDATA%\HurogiCollector`의 설정·DB·규칙·WebView2 데이터를 파일별 SHA-256 검증 후 새 경로로 복사한다.
- 기존 폴더는 롤백용 보존본으로 남기며 새 버전은 더 이상 그 폴더에 기록하지 않는다.

## 검증 상태

- Node 계약·회귀 검사: 80/80 PASS
- Windows EXE 빌드와 첫 실행 데이터 이전은 사용자 Windows PC의 원클릭 빌드에서 수행한다.
- 실제 후원·OBS·마이크 E2E는 기존 결정대로 검증 유예 상태다.
