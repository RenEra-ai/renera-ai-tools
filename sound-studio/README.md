# Sound Studio

Complete music production toolkit using Python audio processing. No DAW required.

## Prerequisites

- Python 3.10+
- ffmpeg (`brew install ffmpeg`)

### Python packages

```bash
pip3 install pedalboard pydub librosa soundfile numpy scipy noisereduce pyloudnorm matchering demucs
```

## Skills

| Skill | Purpose |
|-------|---------|
| **audio-engine** | Core audio processing — FX chains, mixing, format conversion, analysis |
| **mix-engineer** | Per-stem polishing — noise reduction, EQ, compression |
| **mastering-engineer** | Loudness optimization for streaming platforms |
| **stem-separator** | AI stem separation using Demucs |
| **voice-synthesis** | TTS and voice generation (GPT-SoVITS, edge-tts, Bark) |
| **generative-music-composer** | Algorithmic composition systems |
| **genre-creator** | Genre documentation generator |

## Commands

| Command | Purpose |
|---------|---------|
| `/play <file>` | Play an audio file with file info |

## Typical Workflow

```
1. Load audio file
2. /stem-separator → separate into stems
3. /mix-engineer → polish stems (noise reduction, EQ, compression)
4. /mastering-engineer → master for streaming (-14 LUFS)
5. /play → listen to result
```

## Architecture

No MCP server. All audio processing runs directly via Python scripts using:
- **pedalboard** (Spotify) — professional FX: compressor, reverb, EQ, delay, limiter
- **pydub** — high-level mixing: overlay, volume, pan, fade
- **librosa** — analysis: pitch detection, time-stretch, spectral
- **ffmpeg** — format conversion and filters
- **demucs** — AI stem separation
