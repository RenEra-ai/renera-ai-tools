---
description: Play an audio file. Shows file info and starts playback.
argument-hint: <path-to-audio-file>
allowed-tools:
  - Bash
---

Play the audio file specified in $ARGUMENTS.

1. Show file info using ffprobe (duration, sample rate, channels, codec)
2. Start playback using `ffplay -nodisp -autoexit "$ARGUMENTS"` in the background
3. Report that playback has started with the file details
