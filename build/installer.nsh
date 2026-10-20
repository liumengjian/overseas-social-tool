; Install the Microsoft VC++ x64 runtime required by whisper-cli.exe.
; Exit code 3010 means installation succeeded and Windows recommends a restart.
!macro customInstall
  DetailPrint "正在安装 Microsoft Visual C++ x64 运行库…"
  ExecWait '"$INSTDIR\resources\vc_redist.x64.exe" /install /quiet /norestart' $0
  ${If} $0 == 0
    DetailPrint "Microsoft Visual C++ x64 运行库已安装。"
  ${ElseIf} $0 == 3010
    DetailPrint "Microsoft Visual C++ x64 运行库已安装，建议稍后重启电脑。"
  ${Else}
    DetailPrint "Microsoft Visual C++ x64 运行库安装返回代码：$0；应用仍将继续安装。"
  ${EndIf}
!macroend
