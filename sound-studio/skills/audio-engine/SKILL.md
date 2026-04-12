---
name: audio-engine
description: >-
  This skill should be used when the user asks to process audio files, apply effects
  (reverb, compression, EQ, delay, chorus, distortion), mix or overlay tracks, convert
  formats, time-stretch, pitch-shift, normalize loudness, fade in/out, trim silence,
  or perform any standalone audio processing outside of a DAW. Provides Python-based
  audio operations using pedalboard, pydub, librosa, soundfile, and ffmpeg.
trigger-phrases:
  - process audio
  - add reverb
  - mix tracks
  - apply EQ
  - compress
  - delay
  - time-stretch
  - pitch-shift
  - normalize
  - fade
  - convert format
  - audio processing
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
requirements:
  python:
    - pedalboard
    - pydub
    - librosa
    - soundfile
    - numpy
---

# Audio Engine

Standalone Python audio processing engine. Apply professional FX chains, mix and overlay
tracks, analyze audio characteristics, convert formats, and manipulate time/pitch -- all
without a DAW. Write Python scripts via Bash and operate directly on audio files.

---

## Library Quick Reference

Choose the right library for each task. Avoid pulling in a heavy library when a lighter
one suffices.

### pydub -- High-Level Mixing & Editing

Use for: combining tracks, volume adjustment, panning, fades, concatenation, format
export, slicing by milliseconds.

- Operates on `AudioSegment` objects.
- Relies on ffmpeg under the hood for decoding/encoding.
- Not suitable for sample-level DSP or professional FX.

### pedalboard (Spotify) -- Professional FX Chains

Use for: compression, reverb, delay, gain, EQ filters (highpass, lowpass, peak, shelf),
limiting, chorus, distortion, phaser, convolution reverb.

- Processes numpy float32 arrays at a given sample rate.
- Chain multiple effects into a `Pedalboard` pipeline.
- Runs at native C++ speed -- fast even on long files.

### librosa -- Analysis & Time-Domain Manipulation

Use for: pitch detection, spectral analysis, STFT, mel-spectrograms, beat tracking,
onset detection, time-stretch, pitch-shift, silence trimming, tempo estimation.

- Returns numpy arrays; pair with soundfile for I/O.
- Time-stretch and pitch-shift use phase vocoder internally.

### soundfile -- Lossless I/O with numpy

Use for: reading and writing WAV, FLAC, OGG files as numpy arrays with full control
over sample rate and bit depth.

- Preferred over librosa.load when no resampling is needed.
- Writes float32 or int16/int24 WAV directly.

### ffmpeg -- Format Conversion & Complex Filters

Use for: MP3/AAC/OGG encoding, loudness normalization (loudnorm), sample rate
conversion, channel mapping, complex filter graphs.

- Call via `subprocess.run(["ffmpeg", ...])`.
- Always add `-y` flag to overwrite output without prompting.
- Check return code and stderr for errors.

---

## Project File Convention

Maintain a JSON project file at the working directory root to preserve session state
across turns. Create it on the first operation; read and update it on subsequent turns.

### Minimal Example

```json
{
  "name": "my-session",
  "sample_rate": 44100,
  "working_directory": "/path/to/project",
  "tracks": [
    {
      "name": "lead-vocal",
      "file": "vocals.wav",
      "volume_db": 0.0,
      "pan": 0.0,
      "mute": false,
      "fx_chain": [
        {"type": "HighpassFilter", "cutoff_frequency_hz": 80},
        {"type": "Compressor", "threshold_db": -15, "ratio": 2.5},
        {"type": "Reverb", "room_size": 0.35, "wet_level": 0.25}
      ]
    },
    {
      "name": "drums",
      "file": "drums.wav",
      "volume_db": -2.0,
      "pan": 0.0,
      "mute": false,
      "fx_chain": []
    }
  ],
  "markers": [
    {"name": "verse-1", "time_seconds": 0.0},
    {"name": "chorus-1", "time_seconds": 32.0},
    {"name": "verse-2", "time_seconds": 64.0}
  ]
}
```

### Field Descriptions

- **name** -- Session identifier, used for output file naming.
- **sample_rate** -- Project-wide sample rate in Hz; resample any imported audio that differs.
- **working_directory** -- Absolute path; all `file` values are relative to this.
- **tracks[].volume_db** -- Gain offset applied during mixdown (0.0 = unity).
- **tracks[].pan** -- Stereo position from -1.0 (full left) to 1.0 (full right).
- **tracks[].mute** -- Skip this track during mixdown when true.
- **tracks[].fx_chain** -- Ordered list of pedalboard effect dicts; apply in sequence.
- **markers** -- Named time positions for navigation and region-based processing.

Read the project file at the start of every turn. Write it back after any structural
change (add/remove track, modify FX chain, change volume/pan).

---

## Audio Operations Cookbook

### Load Audio

```python
import soundfile as sf
from pydub import AudioSegment

# numpy array + sample rate (preferred for DSP)
audio, sr = sf.read("input.wav")

# AudioSegment (preferred for mixing/editing)
sound = AudioSegment.from_file("input.wav")
```

### Apply FX Chain with pedalboard

```python
from pedalboard import Pedalboard, Compressor, Reverb, Gain, HighpassFilter

board = Pedalboard([
    HighpassFilter(cutoff_frequency_hz=80),
    Compressor(threshold_db=-15, ratio=2.5),
    Reverb(room_size=0.35, wet_level=0.25),
])
processed = board(audio, sample_rate=sr)
sf.write("output.wav", processed, sr)
```

### Mix / Overlay with pydub

```python
track1 = AudioSegment.from_file("drums.wav")
track2 = AudioSegment.from_file("bass.wav")
mixed = track1.overlay(track2)
mixed.export("mix.wav", format="wav")
```

### Volume

```python
# pydub: adjust by dB
louder = sound + 6    # +6 dB
quieter = sound - 3   # -3 dB

# pedalboard: inline gain
from pedalboard import Gain
board = Pedalboard([Gain(gain_db=-3)])
processed = board(audio, sample_rate=sr)
```

### Pan

```python
# pydub: -1.0 (left) to 1.0 (right)
panned_left = sound.pan(-0.5)
panned_right = sound.pan(0.7)
```

### Fade

```python
# pydub: durations in milliseconds
faded = sound.fade_in(1000).fade_out(2000)
```

### Time-Stretch

```python
import librosa

y, sr = librosa.load("input.wav", sr=None)
# rate > 1.0 = faster, rate < 1.0 = slower
stretched = librosa.effects.time_stretch(y, rate=1.5)
sf.write("stretched.wav", stretched, sr)
```

### Pitch-Shift

```python
import librosa

y, sr = librosa.load("input.wav", sr=None)
# n_steps in semitones: positive = up, negative = down
shifted = librosa.effects.pitch_shift(y, sr=sr, n_steps=2)
sf.write("shifted.wav", shifted, sr)
```

### Normalize Loudness (EBU R128)

```bash
ffmpeg -y -i input.wav -af loudnorm=I=-14:TP=-1.0:LRA=11 output.wav
```

Call via subprocess:

```python
import subprocess
subprocess.run([
    "ffmpeg", "-y", "-i", "input.wav",
    "-af", "loudnorm=I=-14:TP=-1.0:LRA=11",
    "output.wav"
], check=True)
```

### Format Conversion

```bash
# WAV to MP3 (VBR quality 2, ~190 kbps)
ffmpeg -y -i input.wav -codec:a libmp3lame -q:a 2 output.mp3

# WAV to FLAC
ffmpeg -y -i input.wav -codec:a flac output.flac

# WAV to AAC
ffmpeg -y -i input.wav -codec:a aac -b:a 256k output.m4a

# Resample to 48 kHz
ffmpeg -y -i input.wav -ar 48000 output.wav
```

### Trim Silence

```python
import librosa

y, sr = librosa.load("input.wav", sr=None)
trimmed, index = librosa.effects.trim(y, top_db=20)
sf.write("trimmed.wav", trimmed, sr)
```

### Concatenate

```python
from pydub import AudioSegment

part1 = AudioSegment.from_file("part1.wav")
part2 = AudioSegment.from_file("part2.wav")
combined = part1 + part2
combined.export("combined.wav", format="wav")
```

### Split Stereo to Mono

```python
import soundfile as sf

audio, sr = sf.read("stereo.wav")
left = audio[:, 0]
right = audio[:, 1]
sf.write("left.wav", left, sr)
sf.write("right.wav", right, sr)
```

### Merge Mono to Stereo

```python
import numpy as np
import soundfile as sf

left, sr = sf.read("left.wav")
right, _ = sf.read("right.wav")
stereo = np.column_stack([left, right])
sf.write("stereo.wav", stereo, sr)
```

### Crossfade Two Clips

```python
from pydub import AudioSegment

clip1 = AudioSegment.from_file("clip1.wav")
clip2 = AudioSegment.from_file("clip2.wav")
crossfaded = clip1.append(clip2, crossfade=2000)  # 2-second crossfade
crossfaded.export("crossfaded.wav", format="wav")
```

### Playback (Preview)

```python
import subprocess
subprocess.run(["ffplay", "-nodisp", "-autoexit", "output.wav"], check=True)
```

---

## FX Chain Recipes

Production-ready pedalboard chains with real parameter values. Import all classes from
`pedalboard` and construct chains as `Pedalboard([...])`.

### Vocals

```python
from pedalboard import (
    Pedalboard, HighpassFilter, Compressor, Gain,
    PeakFilter, Reverb
)

vocal_chain = Pedalboard([
    HighpassFilter(cutoff_frequency_hz=80),
    Compressor(threshold_db=-15, ratio=2.5, attack_ms=50, release_ms=100),
    PeakFilter(cutoff_frequency_hz=3000, gain_db=2, q=1.0),   # presence
    Reverb(room_size=0.35, wet_level=0.25, damping=0.4),
])
```

### Kick Drum

```python
from pedalboard import (
    Pedalboard, HighpassFilter, LowShelfFilter, Compressor
)

kick_chain = Pedalboard([
    HighpassFilter(cutoff_frequency_hz=30),
    LowShelfFilter(cutoff_frequency_hz=60, gain_db=3),
    Compressor(threshold_db=-20, ratio=4, attack_ms=1, release_ms=50),
])
```

### Snare

```python
from pedalboard import (
    Pedalboard, PeakFilter, HighShelfFilter, Compressor, Reverb
)

snare_chain = Pedalboard([
    PeakFilter(cutoff_frequency_hz=200, gain_db=2, q=1.0),        # body
    HighShelfFilter(cutoff_frequency_hz=5000, gain_db=2),          # crack
    Compressor(threshold_db=-18, ratio=3, attack_ms=2, release_ms=60),
    Reverb(room_size=0.15, wet_level=0.2),                         # tight room
])
```

### Bass

```python
from pedalboard import (
    Pedalboard, HighpassFilter, LowShelfFilter, Compressor
)

bass_chain = Pedalboard([
    HighpassFilter(cutoff_frequency_hz=30),
    LowShelfFilter(cutoff_frequency_hz=80, gain_db=2),
    Compressor(threshold_db=-15, ratio=3, attack_ms=20, release_ms=80),
])
```

### Guitar

```python
from pedalboard import (
    Pedalboard, HighpassFilter, PeakFilter, Compressor
)

guitar_chain = Pedalboard([
    HighpassFilter(cutoff_frequency_hz=100),
    PeakFilter(cutoff_frequency_hz=3000, gain_db=2, q=1.2),
    Compressor(threshold_db=-12, ratio=2, attack_ms=20, release_ms=100),
])
```

### Synth Pad

```python
from pedalboard import Pedalboard, HighpassFilter, Reverb

pad_chain = Pedalboard([
    HighpassFilter(cutoff_frequency_hz=200),
    Reverb(room_size=0.7, wet_level=0.6, damping=0.4),
])
```

---

## Genre Quick Reference

Use this table to inform tempo, key selection, and signature processing choices.

| Genre    | BPM       | Key         | Signature Element                          |
|----------|-----------|-------------|--------------------------------------------|
| Pop      | 110--130  | C/G major   | Bright vocal, layered synths, four-on-floor |
| Lo-fi    | 70--85    | Eb/Bb major | Vinyl crackle, tape saturation, soft keys  |
| Hip-Hop  | 85--95    | Minor keys  | 808 sub-bass, sparse hats, vocal chops     |
| Trap     | 130--150  | Minor keys  | Rolling hats, heavy 808, sparse melody     |
| House    | 120--128  | Minor keys  | Four-on-floor kick, offbeat hats, pads     |
| Techno   | 125--140  | Atonal/min  | Driving kick, industrial textures, builds  |
| Rock     | 110--140  | E/A/D       | Distorted guitars, live drums, power chords |
| Jazz     | 100--180  | Bb/Eb/F     | Swing feel, extended chords, walking bass  |
| R&B      | 65--85    | Eb/Ab major | Smooth vocals, neo-soul chords, 808s       |
| Ambient  | 60--90    | Open/modal  | Pad layers, reverb tails, granular texture |

Consult `references/genre-blueprints.md` for complete bar-by-bar arrangements, detailed
FX parameters, and genre-specific mixing decisions.

---

## Tips

### Start with Drums
Build the mix from the rhythm section up. Get kick and snare sitting right before
adding melodic elements. The groove anchors everything.

### Manage Low End
Only one element should own the sub-bass region below 80 Hz at any given time --
typically the kick or the bass, not both simultaneously. Use sidechain compression or
frequency splitting to keep them from competing.

### Pan Hard
Spread stereo width by panning supporting elements decisively. Rhythm guitars hard
left and right (0.8--1.0). Keep kick, snare, bass, and lead vocal at center (0.0).
Hats and percussion slightly off-center (0.2--0.4).

### Less Reverb Than Expected
Reverb fills space but destroys clarity at high levels. Start with wet_level at 0.15
and increase only if the track sounds dry. A common mistake is applying the same large
reverb to every element -- use short rooms on drums, medium plates on vocals, and long
halls only on pads or special FX.

### Gain Staging
Keep peak levels at -6 dBFS per track before summing. This leaves headroom for the mix
bus and prevents clipping before the limiter. Apply gain adjustments early in the FX
chain, not at the end.

### High-Pass Everything
Apply a highpass filter to every track except kick and bass. Set the cutoff just below
the lowest useful frequency of each instrument:
- Vocals: 80 Hz
- Guitars: 100 Hz
- Keys/Synths: 80--200 Hz depending on register
- Strings: 35 Hz
- Percussion: 60 Hz

This removes subsonic rumble and frees up low-end headroom for the elements that need it.

### Use Reference Tracks
Compare the mix against a commercial reference in the same genre at matched loudness.
Load the reference into the project, match its LUFS to the mix bus, and A/B frequently.
Focus on overall tonal balance, not on matching individual elements.

### Export at Source Quality
Always process and export at the project sample rate (typically 44100 or 48000 Hz).
Resample only as a final delivery step. Avoid repeated format conversions -- each
lossy encode degrades quality.

### Check Before Overwriting
Never overwrite original source files. Write processed output to a separate path or
add a suffix (e.g., `_processed`, `_v2`). If the project file tracks the original
filename, update the track entry to point to the new file after processing.

### Mono Compatibility
Check that stereo mixes translate well to mono. Sum left and right channels and listen
for phase cancellation -- elements that disappear in mono have phase problems. Fix by
narrowing the stereo width of the affected track or adjusting its pan position.

### Avoid Stacking Reverbs
Apply reverb to individual tracks, not to a pre-reverbed submix. When multiple tracks
each carry their own reverb tail, the combined result is muddy and indistinct. If a
source file already contains reverb, reduce the wet_level or skip reverb entirely on
that track.

---

## References

Consult these files for detailed parameter tables, arrangements, MIDI data, and
conversion recipes. Load only when the specific information is needed -- do not read
all references on every invocation.

- **`references/pedalboard-fx-params.md`** -- Complete parameter tables for every
  pedalboard effect class, including ranges, defaults, and recommended starting values.
- **`references/genre-blueprints.md`** -- Bar-by-bar arrangement templates for each
  genre, with instrument layering, build/drop patterns, and section lengths.
- **`references/midi-reference.md`** -- General MIDI drum maps (note numbers for kick,
  snare, hats, toms, cymbals), chord voicings by genre, and common scale patterns.
- **`references/ffmpeg-recipes.md`** -- Format conversion commands, loudness
  normalization workflows, complex filter graphs, batch processing scripts, and
  streaming delivery presets.
