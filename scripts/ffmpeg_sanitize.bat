@echo off
REM 脚本1：敏感内容「重新编码脱敏」(Windows)
REM 用法: ffmpeg_sanitize.bat <输入视频> [输出视频] [ffmpeg路径]
REM 示例: ffmpeg_sanitize.bat raw.mp4 sanitized.mp4

setlocal
set "FF=%~3"
if "%FF%"=="" set "FF=ffmpeg"

if "%~1"=="" (
  echo 用法: ffmpeg_sanitize.bat ^<输入视频^> [输出视频] [ffmpeg路径]
  exit /b 1
)

set "IN=%~1"
if "%~2"=="" (set "OUT=%~dp1%~n1_sanitized.mp4") else (set "OUT=%~2")

"%FF%" -y -i "%IN%" ^
  -vf "scale=720:-2,crop=iw-20:ih-20:10:10,format=yuv420p" ^
  -r 24 ^
  -c:v libx264 -preset veryfast -crf 23 -b:v 1400k ^
  -map_metadata -1 -fflags +bitexact ^
  -c:a aac -b:a 128k ^
  -movflags +faststart ^
  "%OUT%"

echo 已生成脱敏视频: %OUT%
endlocal
