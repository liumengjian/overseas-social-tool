# Local Whisper runtime

Place the `whisper.cpp` executable and model here for offline voiceover transcription:

- Windows: `whisper-cli.exe` (or `main.exe`)
- Model: `models/ggml-base.bin`

The model is not included in packaged builds. On first use, the app downloads
`WHISPER_MODEL_URL` (or `COS_CDN_DOMAIN/tools/ggml-base.bin`) into the user's
application data directory and reuses it on later runs.

The app searches this directory in both development and packaged builds. If the
executable and model are not present, it falls back to `python -m whisper` when
`openai-whisper` is installed locally.
