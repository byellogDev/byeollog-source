# NCP 운영 접속

운영 서버에는 `root`로 SSH 접속하지 않습니다. 저장소 루트에서 아래 래퍼만 사용합니다.

```powershell
& .\ops\ncp\Invoke-ByeollogNcpSsh.ps1 'id; sudo -n true'
```

래퍼는 다음 조건이 모두 맞을 때만 접속합니다.

- SSH 사용자: `byeollog-deploy`
- 서버: `192.0.2.20`
- 로컬 키: 바탕화면의 `byeollog-ncp.pem`
- 키 지문: 저장소에 고정된 RSA 지문과 일치
- 서버 호스트 키: 기존 `known_hosts`와 일치

키 파일 자체는 저장소에 복사하거나 커밋하지 않습니다. 접속 실패 시 `root` 또는 다른 키를 순차 시도하지 말고 래퍼의 사전검사 오류를 먼저 해결합니다.

운영 경로와 분리된 셸 드릴은 저장소의 `ops/ncp` 스크립트만 표준입력으로 실행할 수 있습니다.

```powershell
& .\ops\ncp\Invoke-ByeollogNcpSsh.ps1 -StdinScriptPath .\ops\ncp\deploy-gateway-lease-deadline-20260907.sh --self-test
```
