# FFmpeg Audio Recipes

Copy-paste commands for common audio operations.

---

## Format Conversion

```bash
# WAV to MP3 (VBR quality 2, ~190 kbps)
ffmpeg -i input.wav -codec:a libmp3lame -q:a 2 output.mp3

# WAV to FLAC (lossless)
ffmpeg -i input.wav -codec:a flac output.flac

# WAV to OGG Vorbis (quality 6, ~192 kbps)
ffmpeg -i input.wav -codec:a libvorbis -q:a 6 output.ogg

# MP3 to WAV
ffmpeg -i input.mp3 output.wav

# Any format to WAV 44.1kHz 16-bit (CD quality)
ffmpeg -i input.any -ar 44100 -sample_fmt s16 output.wav

# Any format to WAV 48kHz 24-bit (production quality)
ffmpeg -i input.any -ar 48000 -sample_fmt s32 output.wav

# WAV to AAC (high quality)
ffmpeg -i input.wav -codec:a aac -b:a 256k output.m4a

# Convert sample rate only
ffmpeg -i input.wav -ar 44100 output.wav
```

---

## Trim & Split

```bash
# Trim by start and end time
ffmpeg -i input.wav -ss 00:00:30 -to 00:01:00 output.wav

# Trim by start time and duration
ffmpeg -i input.wav -ss 00:00:30 -t 30 output.wav

# Take first 10 seconds
ffmpeg -i input.wav -t 10 output.wav

# Skip first 5 seconds
ffmpeg -i input.wav -ss 5 output.wav

# Split into 30-second segments
ffmpeg -i input.wav -f segment -segment_time 30 output_%03d.wav

# Extract left channel only
ffmpeg -i input.wav -af "pan=mono|c0=c0" output_left.wav

# Extract right channel only
ffmpeg -i input.wav -af "pan=mono|c0=c1" output_right.wav

# Stereo to mono (mixdown)
ffmpeg -i input.wav -ac 1 output_mono.wav

# Mono to stereo (duplicate)
ffmpeg -i input.wav -ac 2 output_stereo.wav
```

---

## Volume & Loudness

```bash
# Adjust volume (multiply by 0.5 = halve)
ffmpeg -i in.wav -af "volume=0.5" out.wav

# Adjust volume in dB
ffmpeg -i in.wav -af "volume=6dB" out.wav

# Loudness normalize to streaming standard (EBU R128, -14 LUFS)
ffmpeg -i in.wav -af loudnorm=I=-14:LRA=11:TP=-1.0 out.wav

# Two-pass loudness normalization (more accurate)
# Pass 1: measure
ffmpeg -i in.wav -af loudnorm=I=-14:LRA=11:TP=-1.0:print_format=json -f null -
# Pass 2: apply (use measured values from pass 1)
ffmpeg -i in.wav -af loudnorm=I=-14:LRA=11:TP=-1.0:measured_I=-20:measured_LRA=8:measured_TP=-2:measured_thresh=-30:linear=true out.wav

# Detect loudness stats
ffmpeg -i in.wav -af loudnorm=I=-14:print_format=json -f null -

# Peak normalize to -1 dBFS
ffmpeg -i in.wav -af "volume=0dB:precision=double" -af "aformat=sample_fmts=flt" out.wav
```

---

## Mixing

```bash
# Mix two files together (same duration)
ffmpeg -i track1.wav -i track2.wav -filter_complex amix=inputs=2:duration=longest out.wav

# Mix with volume weights
ffmpeg -i track1.wav -i track2.wav -filter_complex "[0]volume=0.8[a];[1]volume=0.5[b];[a][b]amix=inputs=2:duration=longest" out.wav

# Overlay voice at 5-second offset onto background
ffmpeg -i bg.wav -i voice.wav -filter_complex "[1]adelay=5000|5000[v];[0][v]amix=2" out.wav

# Concatenate files sequentially
ffmpeg -i part1.wav -i part2.wav -i part3.wav -filter_complex "[0][1][2]concat=n=3:v=0:a=1" out.wav

# Crossfade between two files (3-second crossfade)
ffmpeg -i part1.wav -i part2.wav -filter_complex "acrossfade=d=3:c1=tri:c2=tri" out.wav

# Add silence before audio (2 seconds)
ffmpeg -i in.wav -af "adelay=2000|2000" out.wav
```

---

## Filters

```bash
# Highpass filter (remove below 80Hz)
ffmpeg -i in.wav -af "highpass=f=80" out.wav

# Lowpass filter (remove above 8kHz)
ffmpeg -i in.wav -af "lowpass=f=8000" out.wav

# Parametric EQ boost (+3dB at 3kHz, Q=1.5)
ffmpeg -i in.wav -af "equalizer=f=3000:t=q:w=1.5:g=3" out.wav

# Parametric EQ cut (-4dB at 300Hz, Q=2)
ffmpeg -i in.wav -af "equalizer=f=300:t=q:w=2:g=-4" out.wav

# Compressor
ffmpeg -i in.wav -af "acompressor=threshold=-20dB:ratio=4:attack=5:release=50" out.wav

# Limiter
ffmpeg -i in.wav -af "alimiter=limit=-1dB:attack=5:release=50" out.wav

# Noise gate
ffmpeg -i in.wav -af "agate=threshold=-40dB:ratio=2:attack=5:release=50" out.wav

# De-esser (compress 5-8kHz range)
ffmpeg -i in.wav -af "equalizer=f=6500:t=q:w=1:g=-4" out.wav

# Chain multiple filters
ffmpeg -i in.wav -af "highpass=f=80,equalizer=f=3000:t=q:w=1.5:g=2,acompressor=threshold=-18dB:ratio=3:attack=10:release=100" out.wav
```

---

## Time Manipulation

```bash
# Speed up 1.5x (no pitch change)
ffmpeg -i in.wav -af "atempo=1.5" out.wav

# Slow down to 0.75x (no pitch change)
ffmpeg -i in.wav -af "atempo=0.75" out.wav

# Chain for extreme speeds (atempo range is 0.5 to 100.0)
# 4x speed:
ffmpeg -i in.wav -af "atempo=2.0,atempo=2.0" out.wav
# 0.25x speed:
ffmpeg -i in.wav -af "atempo=0.5,atempo=0.5" out.wav

# Reverse audio
ffmpeg -i in.wav -af "areverse" out.wav

# Pitch shift up (speed up then slow down with rubberband)
ffmpeg -i in.wav -af "asetrate=44100*1.05,aresample=44100" out.wav
```

---

## Fade In & Out

```bash
# Fade in (3 seconds)
ffmpeg -i in.wav -af "afade=t=in:ss=0:d=3" out.wav

# Fade out (last 5 seconds of a 60-second file)
ffmpeg -i in.wav -af "afade=t=out:st=55:d=5" out.wav

# Both fade in and fade out
ffmpeg -i in.wav -af "afade=t=in:ss=0:d=3,afade=t=out:st=55:d=5" out.wav
```

---

## Analysis

```bash
# Show file info (format, duration, bitrate, sample rate)
ffprobe -v quiet -show_format -show_streams input.wav

# Detect silence (threshold -50dB, minimum duration 0.5s)
ffmpeg -i in.wav -af silencedetect=n=-50dB:d=0.5 -f null -

# Volume statistics (peak, mean, histogram)
ffmpeg -i in.wav -af volumedetect -f null -

# Loudness stats (EBU R128)
ffmpeg -i in.wav -af loudnorm=I=-14:print_format=json -f null -

# Show audio spectrum info
ffprobe -v quiet -show_entries stream=sample_rate,channels,bits_per_sample,duration,bit_rate -of default=noprint_wrappers=1 input.wav

# Get exact duration in seconds
ffprobe -v quiet -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 input.wav
```

---

## Batch Processing

```bash
# Convert all WAVs to MP3
for f in *.wav; do ffmpeg -i "$f" -codec:a libmp3lame -q:a 2 "${f%.wav}.mp3"; done

# Convert all WAVs to FLAC
for f in *.wav; do ffmpeg -i "$f" -codec:a flac "${f%.wav}.flac"; done

# Normalize loudness of all WAVs in directory
for f in *.wav; do ffmpeg -i "$f" -af loudnorm=I=-14:LRA=11:TP=-1.0 "normalized_${f}"; done

# Trim first 2 seconds from all WAVs
for f in *.wav; do ffmpeg -i "$f" -ss 2 "trimmed_${f}"; done

# Resample all files to 44.1kHz
for f in *.wav; do ffmpeg -i "$f" -ar 44100 "resampled_${f}"; done
```
