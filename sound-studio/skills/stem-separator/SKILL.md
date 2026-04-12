---
name: stem-separator
description: "This skill should be used when the user asks to 'separate stems', 'isolate vocals', 'extract drums', 'remove vocals', 'karaoke', 'acapella', or wants to split an audio file into individual instrument tracks using AI. Provides Demucs-based stem separation workflows."
requirements:
  python: [demucs, torch, torchaudio, soundfile]
allowed-tools: [Read, Write, Bash, Glob]
---

# Stem Separator

## Purpose

Perform AI-powered audio stem separation using Meta's Demucs neural network. Take any mixed audio file and decompose it into isolated instrument stems (vocals, drums, bass, and more) suitable for remixing, sampling, karaoke creation, or further audio processing.

## Installation

Install Demucs and its dependencies via pip. This also pulls in PyTorch and torchaudio automatically:

```
pip3 install demucs
```

Verify the installation succeeded by running `python3 -m demucs --help`. If ffmpeg is not already installed, install it as well -- Demucs requires ffmpeg to decode MP3, FLAC, and other compressed input formats:

```
brew install ffmpeg   # macOS
apt install ffmpeg    # Linux
```

Install soundfile for any post-separation WAV manipulation:

```
pip3 install soundfile
```

## Separation Modes

### 2-Stem Separation (Vocal Isolation)

Use 2-stem mode to split audio into vocals and accompaniment. This is the right choice for karaoke or acapella extraction:

```
python3 -m demucs --two-stems vocals "file.mp3"
```

Output: `vocals.wav` and `no_vocals.wav` in the output directory.

### 4-Stem Separation (Default)

The default mode separates audio into four stems. Use this for general-purpose stem extraction:

```
python3 -m demucs "file.mp3"
```

Output: `drums.wav`, `bass.wav`, `vocals.wav`, `other.wav`.

### 6-Stem Separation

Use the `htdemucs_6s` model for finer separation that additionally isolates guitar and piano:

```
python3 -m demucs -n htdemucs_6s "file.mp3"
```

Output: `drums.wav`, `bass.wav`, `vocals.wav`, `guitar.wav`, `piano.wav`, `other.wav`.

## Output Convention

All separated stems are written to:

```
separated/htdemucs/<filename>/
```

where `<filename>` is the input file's name without its extension. For example, separating `song.mp3` produces stems in `separated/htdemucs/song/`. When using a non-default model such as `htdemucs_6s`, the model name replaces `htdemucs` in the path.

Override the output directory with `-o <path>` if a different location is needed.

## Model Selection

- **htdemucs** -- Default model. Best overall quality for most material. Use this unless there is a specific reason not to.
- **mdx_extra_q** -- Alternative model that may perform better on certain tracks, particularly those with dense instrumentation. Select it with `-n mdx_extra_q`.

Always start with htdemucs. Switch to mdx_extra_q only if the default produces excessive artifacts or bleed on a particular track.

## GPU vs CPU Execution

Demucs runs dramatically faster on GPU (CUDA or MPS). On a machine with a supported GPU, Demucs auto-detects and uses it. To force CPU execution (useful when GPU memory is limited or unavailable):

```
python3 -m demucs --device cpu "file.mp3"
```

Expect CPU separation to take 3-10x longer than GPU depending on track length and hardware.

## Post-Separation Workflow

After separation completes, feed the resulting stems into the mix-engineer skill for polishing. The mix-engineer expects per-stem WAV files -- exactly what Demucs produces. Typical next steps:

1. Review each stem individually for quality.
2. Apply cleanup (noise reduction, EQ, compression) via mix-engineer.
3. Remix stems together at desired levels, or use individual stems in a new arrangement.

## Quality Assessment

Inspect each stem after separation:

- **Vocal stem**: Check for instrumental bleed, especially hi-hats and cymbals leaking into vocals.
- **Drum stem**: Listen for vocal or melodic ghosting. Some bleed is normal on busy mixes.
- **Bass stem**: Verify low-end integrity. Confirm kick drum does not dominate the bass stem.
- **Other/Guitar/Piano stems**: These catch everything not classified elsewhere. Some cross-contamination is expected.

Use `ffplay -nodisp -autoexit <stem.wav>` to quickly audition each stem. If artifacts are severe, try re-running with the alternative model (`mdx_extra_q`) or adjusting the `--shifts` parameter (higher values improve quality at the cost of speed):

```
python3 -m demucs --shifts 5 "file.mp3"
```

## Common Issues

- **"ffmpeg not found" error**: Install ffmpeg. Demucs cannot decode compressed audio formats without it.
- **Out of memory on GPU**: Add `--device cpu` to fall back to CPU, or reduce `--segment` length.
- **soundfile import error**: Run `pip3 install soundfile`. Required for programmatic WAV reading/writing after separation.
- **Slow performance**: Confirm GPU is being used. Check with `python3 -c "import torch; print(torch.cuda.is_available())"` for CUDA or `torch.backends.mps.is_available()` for Apple Silicon.
- **Poor separation quality**: Try increasing `--shifts` (default 1, try 5 or 10). More shifts = better quality but proportionally slower.
