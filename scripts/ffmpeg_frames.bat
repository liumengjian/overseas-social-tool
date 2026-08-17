@echo off
REM 脚本2：敏感内容「抽帧脱敏」(Windows)
REM 用法: ffmpeg_frames.bat <输入视频> [输出目录] [最大帧数] [ffmpeg路径]
REM 示例: ffmpeg_frames.bat sanitized.mp4 frames 30

setlocal
set "FF=%~4"
if "%FF%"=="" set "FF=ffmpeg"

if "%~1"=="" (
  echo 用法: ffmpeg_frames.bat ^<输入视频^> [输出目录] [最大帧数] [ffmpeg路径]
  exit /b 1
)

set "IN=%~1"
if "%~2"=="" (set "OUTDIR=frames") else (set "OUTDIR=%~2")
if "%~3"=="" (set "MAX=30") else (set "MAX=%~3")

if not exist "%OUTDIR%" mkdir "%OUTDIR%"
"%FF%" -y -i "%IN%" -vf fps=1 -q:v 2 -frames:v %MAX% "%OUTDIR%\frame_%%05d.jpg"

echo 已抽取帧到: %OUTDIR%
endlocal
