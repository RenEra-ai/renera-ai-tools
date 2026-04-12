# MIDI Reference

---

## General MIDI Drum Map

Standard GM drum assignments on MIDI channel 10.

| Note | MIDI # | Name |
|------|--------|------|
| C1 | 36 | Kick Drum |
| C#1 | 37 | Side Stick |
| D1 | 38 | Snare Drum |
| D#1 | 39 | Hand Clap |
| F1 | 41 | Low Floor Tom |
| F#1 | 42 | Closed Hi-Hat |
| G1 | 43 | Low Tom |
| G#1 | 44 | Pedal Hi-Hat |
| A1 | 45 | Mid Tom |
| A#1 | 46 | Open Hi-Hat |
| B1 | 47 | High Tom |
| C#2 | 49 | Crash Cymbal 1 |
| D#2 | 51 | Ride Cymbal |
| G2 | 55 | Splash Cymbal |
| A2 | 57 | Crash Cymbal 2 |

### Quick Reference (most used)

```
36 = Kick    38 = Snare    42 = Closed HH    46 = Open HH
49 = Crash   51 = Ride     37 = Side Stick   39 = Clap
43 = Low Tom  45 = Mid Tom  47 = High Tom     44 = Pedal HH
```

---

## Note Names

Middle C = C4 = MIDI 60. Each octave spans 12 semitones.

| Note | C | C#/Db | D | D#/Eb | E | F | F#/Gb | G | G#/Ab | A | A#/Bb | B |
|------|---|-------|---|-------|---|---|-------|---|-------|---|-------|---|
| **Octave 3** | 48 | 49 | 50 | 51 | 52 | 53 | 54 | 55 | 56 | 57 | 58 | 59 |
| **Octave 4** | 60 | 61 | 62 | 63 | 64 | 65 | 66 | 67 | 68 | 69 | 70 | 71 |
| **Octave 5** | 72 | 73 | 74 | 75 | 76 | 77 | 78 | 79 | 80 | 81 | 82 | 83 |
| **Octave 6** | 84 | 85 | 86 | 87 | 88 | 89 | 90 | 91 | 92 | 93 | 94 | 95 |

Formula: `MIDI number = (octave + 1) * 12 + semitone` where C=0, C#=1, ..., B=11

---

## Common Chord Voicings (as MIDI note numbers)

Root position voicings with root = C4 (60) as reference.

### Major Triads

| Chord | Notes | MIDI Numbers |
|-------|-------|-------------|
| C | C-E-G | 60, 64, 67 |
| D | D-F#-A | 62, 66, 69 |
| E | E-G#-B | 64, 68, 71 |
| F | F-A-C | 65, 69, 72 |
| G | G-B-D | 67, 71, 74 |
| A | A-C#-E | 69, 73, 76 |
| B | B-D#-F# | 71, 75, 78 |

### Minor Triads

| Chord | Notes | MIDI Numbers |
|-------|-------|-------------|
| Cm | C-Eb-G | 60, 63, 67 |
| Dm | D-F-A | 62, 65, 69 |
| Em | E-G-B | 64, 67, 71 |
| Fm | F-Ab-C | 65, 68, 72 |
| Gm | G-Bb-D | 67, 70, 74 |
| Am | A-C-E | 69, 72, 76 |
| Bm | B-D-F# | 71, 74, 78 |

### 7th Chords

| Chord | Notes | MIDI Numbers |
|-------|-------|-------------|
| Cmaj7 | C-E-G-B | 60, 64, 67, 71 |
| Dm7 | D-F-A-C | 62, 65, 69, 72 |
| Em7 | E-G-B-D | 64, 67, 71, 74 |
| Fmaj7 | F-A-C-E | 65, 69, 72, 76 |
| G7 | G-B-D-F | 67, 71, 74, 77 |
| Am7 | A-C-E-G | 69, 72, 76, 79 |
| Bm7b5 | B-D-F-A | 71, 74, 77, 81 |

### Extended Chords

| Chord | Notes | MIDI Numbers |
|-------|-------|-------------|
| Cmaj9 | C-E-G-B-D | 60, 64, 67, 71, 74 |
| Dm9 | D-F-A-C-E | 62, 65, 69, 72, 76 |
| G13 | G-B-D-F-A-E | 67, 71, 74, 77, 81, 76 |
| C7 | C-E-G-Bb | 60, 64, 67, 70 |
| F7 | F-A-C-Eb | 65, 69, 72, 75 |
| G9 | G-B-D-F-A | 67, 71, 74, 77, 81 |

---

## Common Progressions

### Pop: I - V - vi - IV (in C)
```
C -> G -> Am -> F
[60,64,67] -> [67,71,74] -> [69,72,76] -> [65,69,72]
```

### Lo-fi: ii - V - I (in C)
```
Dm7 -> G7 -> Cmaj7
[62,65,69,72] -> [67,71,74,77] -> [60,64,67,71]
```

### Jazz: ii - V - I (in C, extended)
```
Dm9 -> G13 -> Cmaj9
[62,65,69,72,76] -> [67,71,74,77,81] -> [60,64,67,71,74]
```

### Blues: I - IV - V (in C)
```
C7 -> F7 -> G7
[60,64,67,70] -> [65,69,72,75] -> [67,71,74,77]
```

### 12-Bar Blues (in C)
```
| C7  | C7  | C7  | C7  |
| F7  | F7  | C7  | C7  |
| G7  | F7  | C7  | G7  |
```

### Sad/Cinematic: vi - IV - I - V (in C)
```
Am -> F -> C -> G
[69,72,76] -> [65,69,72] -> [60,64,67] -> [67,71,74]
```

### Minor Progression: i - VI - III - VII (in Am)
```
Am -> F -> C -> G
[69,72,76] -> [65,69,72] -> [60,64,67] -> [67,71,74]
```

### R&B/Neo-Soul: I - iii - vi - IV (in C)
```
Cmaj7 -> Em7 -> Am7 -> Fmaj7
[60,64,67,71] -> [64,67,71,74] -> [69,72,76,79] -> [65,69,72,76]
```

---

## Scale Formulas

W = whole step (2 semitones), H = half step (1 semitone), m3 = minor third (3 semitones)

### Diatonic Scales

| Scale | Formula | In C (MIDI from 60) |
|-------|---------|---------------------|
| Major (Ionian) | W-W-H-W-W-W-H | 60, 62, 64, 65, 67, 69, 71, 72 |
| Natural Minor (Aeolian) | W-H-W-W-H-W-W | 60, 62, 63, 65, 67, 68, 70, 72 |
| Dorian | W-H-W-W-W-H-W | 60, 62, 63, 65, 67, 69, 70, 72 |
| Mixolydian | W-W-H-W-W-H-W | 60, 62, 64, 65, 67, 69, 70, 72 |
| Phrygian | H-W-W-W-H-W-W | 60, 61, 63, 65, 67, 68, 70, 72 |
| Lydian | W-W-W-H-W-W-H | 60, 62, 64, 66, 67, 69, 71, 72 |
| Locrian | H-W-W-H-W-W-W | 60, 61, 63, 65, 66, 68, 70, 72 |

### Pentatonic & Blues

| Scale | Formula | In C (MIDI from 60) |
|-------|---------|---------------------|
| Major Pentatonic | W-W-m3-W-m3 | 60, 62, 64, 67, 69, 72 |
| Minor Pentatonic | m3-W-W-m3-W | 60, 63, 65, 67, 70, 72 |
| Blues | m3-W-H-H-m3-W | 60, 63, 65, 66, 67, 70, 72 |

### Other Useful Scales

| Scale | Formula | In C (MIDI from 60) |
|-------|---------|---------------------|
| Harmonic Minor | W-H-W-W-H-m3-H | 60, 62, 63, 65, 67, 68, 71, 72 |
| Melodic Minor (asc) | W-H-W-W-W-W-H | 60, 62, 63, 65, 67, 69, 71, 72 |
| Whole Tone | W-W-W-W-W-W | 60, 62, 64, 66, 68, 70, 72 |
| Chromatic | H-H-H-H-H-H-H-H-H-H-H-H | 60-72 (all notes) |
