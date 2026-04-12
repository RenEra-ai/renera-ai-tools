# Pedalboard Plugin Parameter Reference

Based on Spotify's [pedalboard](https://github.com/spotify/pedalboard) library. Every plugin listed here can be instantiated in Python and added to a `Pedalboard` chain.

---

## Compressor

Dynamics processor that reduces the volume of loud sounds above a threshold.

| Parameter | Type | Default | Range | Musical Meaning |
|-----------|------|---------|-------|-----------------|
| `threshold_db` | float | 0 | -100 to 0 | Signal level where compression begins. Lower = more compression applied. |
| `ratio` | float | 1 | 1 to 100 | Compression strength. 1:1 = off, 4:1 = moderate, 20:1 = limiting. |
| `attack_ms` | float | 1.0 | 0.01 to 500 | How fast compression engages. Fast = punchy transients preserved, slow = smooth onset. |
| `release_ms` | float | 100 | 1 to 5000 | How fast compression lets go. Fast = pumping effect, slow = natural decay. |

### Typical Settings

| Preset | threshold_db | ratio | attack_ms | release_ms | Use Case |
|--------|-------------|-------|-----------|------------|----------|
| Gentle vocal | -18 | 2.5 | 10 | 100 | Smooth out vocal dynamics without squashing |
| Punchy drums | -20 | 4 | 0.5 | 50 | Let transients through, clamp sustain |
| Bass leveling | -15 | 3 | 5 | 80 | Even out bass note volumes |
| Parallel compression | -30 | 10 | 1 | 60 | Heavy compression blended with dry signal |

```python
from pedalboard import Compressor
fx = Compressor(threshold_db=-18, ratio=2.5, attack_ms=10, release_ms=100)
```

---

## Reverb

Simulates acoustic space reflections.

| Parameter | Type | Default | Range | Musical Meaning |
|-----------|------|---------|-------|-----------------|
| `room_size` | float | 0.5 | 0 to 1 | Size of simulated space. 0 = tiny room, 1 = massive hall. |
| `damping` | float | 0.5 | 0 to 1 | High-frequency absorption. Higher = darker, more natural decay. |
| `wet_level` | float | 0.33 | 0 to 1 | Level of reverb signal. |
| `dry_level` | float | 0.4 | 0 to 1 | Level of original signal. |
| `width` | float | 1.0 | 0 to 1 | Stereo spread of reverb. 0 = mono, 1 = full stereo. |
| `freeze_mode` | float | 0 | 0 to 1 | Infinite sustain. 1 = reverb tail never decays. |

### Typical Settings

| Preset | room_size | damping | wet_level | dry_level | width | Use Case |
|--------|-----------|---------|-----------|-----------|-------|----------|
| Vocal plate | 0.3 | 0.6 | 0.2 | 0.8 | 0.8 | Subtle presence without washing out |
| Drum room | 0.15 | 0.7 | 0.15 | 0.85 | 1.0 | Tight, controlled room ambience |
| Large hall | 0.8 | 0.3 | 0.35 | 0.5 | 1.0 | Orchestral / cinematic space |
| Ambient wash | 0.95 | 0.2 | 0.6 | 0.3 | 1.0 | Pad-like atmospheric texture |

```python
from pedalboard import Reverb
fx = Reverb(room_size=0.3, damping=0.6, wet_level=0.2, dry_level=0.8, width=0.8)
```

---

## Delay

Echo effect that repeats the input signal after a set time.

| Parameter | Type | Default | Range | Musical Meaning |
|-----------|------|---------|-------|-----------------|
| `delay_seconds` | float | 0.5 | 0 to 5 | Time between repeats. Sync to tempo: 60/BPM = quarter note. |
| `feedback` | float | 0 | 0 to 1 | How much of the delayed signal feeds back. Higher = more repeats. |
| `mix` | float | 0.5 | 0 to 1 | Wet/dry balance. 0 = dry only, 1 = wet only. |

### Typical Settings

| Preset | delay_seconds | feedback | mix | Use Case |
|--------|--------------|----------|-----|----------|
| Slapback | 0.08 | 0.0 | 0.3 | Rockabilly vocal, guitar doubling |
| Quarter note @120 BPM | 0.5 | 0.3 | 0.25 | Rhythmic echo in time with track |
| Long ambient | 1.2 | 0.6 | 0.4 | Atmospheric trails, ambient textures |

```python
from pedalboard import Delay
fx = Delay(delay_seconds=0.5, feedback=0.3, mix=0.25)
```

---

## HighpassFilter

Removes frequencies below the cutoff. Essential for cleaning low-end mud.

| Parameter | Type | Default | Range | Musical Meaning |
|-----------|------|---------|-------|-----------------|
| `cutoff_frequency_hz` | float | -- | 20 to 20000 | Frequencies below this are attenuated. |

### Common Cuts

| Frequency | Use Case |
|-----------|----------|
| 30 Hz | Remove sub-rumble from any track |
| 80 Hz | Clean up vocals, remove proximity effect |
| 100 Hz | Guitar, keep it out of bass territory |
| 200 Hz | Synth pads, strings -- prevent low-end buildup |

```python
from pedalboard import HighpassFilter
fx = HighpassFilter(cutoff_frequency_hz=80)
```

---

## LowpassFilter

Removes frequencies above the cutoff. Use for darkening or lo-fi effects.

| Parameter | Type | Default | Range | Musical Meaning |
|-----------|------|---------|-------|-----------------|
| `cutoff_frequency_hz` | float | -- | 20 to 20000 | Frequencies above this are attenuated. |

### Common Cuts

| Frequency | Use Case |
|-----------|----------|
| 5000 Hz | Lo-fi vocal effect |
| 8000 Hz | Tame harsh cymbals |
| 12000 Hz | Gentle top-end rolloff |
| 800 Hz | Telephone / radio effect |

```python
from pedalboard import LowpassFilter
fx = LowpassFilter(cutoff_frequency_hz=8000)
```

---

## PeakFilter (Parametric EQ Band)

Bell-shaped EQ for surgical boosts and cuts at a specific frequency.

| Parameter | Type | Default | Range | Musical Meaning |
|-----------|------|---------|-------|-----------------|
| `cutoff_frequency_hz` | float | -- | 20 to 20000 | Center frequency of the bell curve. |
| `gain_db` | float | -- | -24 to +24 | Boost (+) or cut (-) in dB. |
| `q` | float | -- | 0.1 to 10 | Bandwidth. Low Q = wide/gentle, high Q = narrow/surgical. |

### Surgical EQ Examples

| Target | Frequency | gain_db | Q | Purpose |
|--------|-----------|---------|---|---------|
| Cut mud | 300 Hz | -3 | 1.5 | Clean up boxy mids |
| Boost presence | 3000 Hz | +3 | 1.0 | Vocal clarity, guitar bite |
| Cut harshness | 5000 Hz | -2 | 2.0 | Tame sibilance and ear fatigue |
| Nasal cut | 1000 Hz | -2 | 2.0 | Remove honky quality |
| Bass definition | 80 Hz | +2 | 1.0 | Warm low-end boost |

```python
from pedalboard import PeakFilter
fx = PeakFilter(cutoff_frequency_hz=3000, gain_db=3, q=1.0)
```

---

## LowShelfFilter

Boosts or cuts all frequencies below the cutoff. Broad tonal shaping.

| Parameter | Type | Default | Range | Musical Meaning |
|-----------|------|---------|-------|-----------------|
| `cutoff_frequency_hz` | float | -- | 20 to 20000 | Frequency where shelf begins. |
| `gain_db` | float | -- | -24 to +24 | Amount of boost or cut. |
| `q` | float | -- | 0.1 to 10 | Shelf slope steepness. |

### Use Cases

| Frequency | gain_db | Q | Purpose |
|-----------|---------|---|---------|
| 80 Hz | +3 | 0.7 | Warm bass boost |
| 100 Hz | -2 | 0.7 | Reduce overall bass weight |
| 200 Hz | +2 | 0.7 | Thicken thin sources |

```python
from pedalboard import LowShelfFilter
fx = LowShelfFilter(cutoff_frequency_hz=80, gain_db=3, q=0.7)
```

---

## HighShelfFilter

Boosts or cuts all frequencies above the cutoff. Add air or tame brightness.

| Parameter | Type | Default | Range | Musical Meaning |
|-----------|------|---------|-------|-----------------|
| `cutoff_frequency_hz` | float | -- | 20 to 20000 | Frequency where shelf begins. |
| `gain_db` | float | -- | -24 to +24 | Amount of boost or cut. |
| `q` | float | -- | 0.1 to 10 | Shelf slope steepness. |

### Use Cases

| Frequency | gain_db | Q | Purpose |
|-----------|---------|---|---------|
| 10000 Hz | +2 | 0.7 | Air / sparkle boost |
| 8000 Hz | -2 | 0.7 | Tame overall brightness |
| 12000 Hz | +3 | 0.7 | Breathy vocal shimmer |

```python
from pedalboard import HighShelfFilter
fx = HighShelfFilter(cutoff_frequency_hz=10000, gain_db=2, q=0.7)
```

---

## Gain

Simple level adjustment. Use before or after other plugins to manage signal levels.

| Parameter | Type | Default | Range | Musical Meaning |
|-----------|------|---------|-------|-----------------|
| `gain_db` | float | 1.0 | -inf to +inf | Volume change in dB. +6 dB ~ double perceived loudness. |

```python
from pedalboard import Gain
fx = Gain(gain_db=-3)  # reduce by 3 dB
```

---

## Limiter

Hard ceiling that prevents signal from exceeding the threshold. Essential for mastering.

| Parameter | Type | Default | Range | Musical Meaning |
|-----------|------|---------|-------|-----------------|
| `threshold_db` | float | -10 | -100 to 0 | Maximum output level. |
| `release_ms` | float | 100 | 1 to 5000 | How fast the limiter recovers. |

### Typical Settings

| Preset | threshold_db | release_ms | Use Case |
|--------|-------------|------------|----------|
| Mastering | -1 | 100 | Final loudness ceiling for streaming |
| Brick wall | -0.3 | 50 | Maximum loudness, no overs |
| Gentle | -3 | 200 | Catch occasional peaks |

```python
from pedalboard import Limiter
fx = Limiter(threshold_db=-1, release_ms=100)
```

---

## NoiseGate

Silences signal below a threshold. Cleans up noise between phrases.

| Parameter | Type | Default | Range | Musical Meaning |
|-----------|------|---------|-------|-----------------|
| `threshold_db` | float | -100 | -100 to 0 | Signal level below which audio is silenced. |
| `ratio` | float | 10 | 1 to 100 | How aggressively signal is reduced below threshold. |
| `attack_ms` | float | 1.0 | 0.01 to 500 | How fast gate opens when signal exceeds threshold. |
| `release_ms` | float | 100 | 1 to 5000 | How fast gate closes when signal drops below threshold. |

```python
from pedalboard import NoiseGate
fx = NoiseGate(threshold_db=-40, ratio=10, attack_ms=1, release_ms=50)
```

---

## Chorus

Modulates delayed copies of the signal to create a thickening / doubling effect.

| Parameter | Type | Default | Range | Musical Meaning |
|-----------|------|---------|-------|-----------------|
| `rate_hz` | float | 1.0 | 0.01 to 20 | Modulation speed. |
| `depth` | float | 0.25 | 0 to 1 | Modulation intensity. |
| `centre_delay_ms` | float | 7.0 | 0 to 50 | Base delay time for chorus voices. |
| `feedback` | float | 0 | -1 to 1 | Feed delayed signal back for more intense effect. |
| `mix` | float | 0.5 | 0 to 1 | Wet/dry balance. |

---

## Distortion

Waveshaping distortion for grit and saturation.

| Parameter | Type | Default | Range | Musical Meaning |
|-----------|------|---------|-------|-----------------|
| `drive_db` | float | 25 | 0 to 100 | Amount of distortion. Higher = more aggressive clipping. |

---

## Phaser

Sweeping phase-shift effect that creates movement.

| Parameter | Type | Default | Range | Musical Meaning |
|-----------|------|---------|-------|-----------------|
| `rate_hz` | float | 1.0 | 0.01 to 20 | Sweep speed. |
| `depth` | float | 0.5 | 0 to 1 | Sweep intensity. |
| `centre_frequency_hz` | float | 1300 | 20 to 20000 | Center of the sweep range. |
| `feedback` | float | 0 | -1 to 1 | Resonance intensity. |
| `mix` | float | 0.5 | 0 to 1 | Wet/dry balance. |

---

## Bitcrush

Reduces bit depth and/or sample rate for lo-fi digital degradation.

| Parameter | Type | Default | Range | Musical Meaning |
|-----------|------|---------|-------|-----------------|
| `bit_depth` | float | 8 | 1 to 32 | Fewer bits = more quantization noise. |

---

## Clipping

Hard clipping distortion that chops waveform peaks.

| Parameter | Type | Default | Range | Musical Meaning |
|-----------|------|---------|-------|-----------------|
| `threshold_db` | float | -6 | -100 to 0 | Level above which signal is clipped flat. |

```python
from pedalboard import Clipping
fx = Clipping(threshold_db=-6)
```
