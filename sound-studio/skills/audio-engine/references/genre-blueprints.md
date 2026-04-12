# Genre Production Blueprints

Each genre includes BPM range, key, track list, bar-by-bar arrangement, FX chains using pedalboard plugins, mix levels, and panning.

---

## Pop (110-130 BPM)

**Key**: C / G / Am | **Time Sig**: 4/4

**Arrangement**: Intro(4) -> Verse(16) -> Pre-chorus(8) -> Chorus(16) -> Verse(16) -> Chorus(16) -> Bridge(8) -> Final Chorus(16) -> Outro(4)

**Track List & FX**:
- **Kick**: HighpassFilter(30) + LowShelfFilter(60, +3dB) + Compressor(-20dB, 4:1, 1ms, 50ms)
- **Snare**: PeakFilter(200Hz, +2dB, q=1.5) + Compressor(-18dB, 3:1, 5ms, 80ms) + Reverb(0.15, wet=0.2)
- **Hi-Hat**: HighpassFilter(300) + LowpassFilter(12000) + Gain(-3dB)
- **Bass**: HighpassFilter(30) + Compressor(-15dB, 3:1, 5ms, 80ms) + LowShelfFilter(80, +2dB)
- **Vocals**: HighpassFilter(80) + Compressor(-15dB, 2.5:1, 10ms, 100ms) + PeakFilter(3000, +2dB, q=1) + Reverb(0.35, wet=0.25)
- **Keys/Pad**: HighpassFilter(100) + Reverb(0.4, wet=0.3) + LowpassFilter(10000)
- **Backing Vocals**: HighpassFilter(150) + Compressor(-18dB, 3:1) + Reverb(0.5, wet=0.35)

**Mix Levels**: Kick -3dB, Snare -5dB, Hi-Hat -10dB, Bass -6dB, Vocals 0dB, Keys -8dB, Backing Vocals -10dB
**Pan**: Kick C, Snare C, Hi-Hat R15, Bass C, Vocals C, Keys R20, Backing Vocals L30/R30

---

## Lo-fi Hip-Hop (70-90 BPM)

**Key**: Dm / Am / Fm | **Time Sig**: 4/4

**Arrangement**: Intro(4) -> Loop A(16) -> Loop B(16) -> Loop A(16) -> Bridge(8) -> Loop B(16) -> Outro(8)

**Track List & FX**:
- **Kick**: HighpassFilter(30) + LowShelfFilter(60, +2dB) + Compressor(-15dB, 3:1)
- **Snare**: PeakFilter(200, +1dB, q=1) + Reverb(0.3, wet=0.25) + Bitcrush(12)
- **Hi-Hat**: HighpassFilter(400) + LowpassFilter(8000) + Gain(-5dB)
- **Bass**: HighpassFilter(30) + Compressor(-12dB, 2:1) + LowpassFilter(3000)
- **Rhodes/Keys**: HighpassFilter(100) + LowpassFilter(6000) + Chorus(rate=0.5, depth=0.3) + Reverb(0.5, wet=0.35)
- **Vinyl Noise**: LowpassFilter(5000) + HighpassFilter(200) + Gain(-15dB)
- **Sample Chops**: LowpassFilter(8000) + Bitcrush(14) + Reverb(0.4, wet=0.2)

**Mix Levels**: Kick -4dB, Snare -6dB, Hi-Hat -12dB, Bass -6dB, Rhodes -8dB, Vinyl -20dB, Samples -10dB
**Pan**: Kick C, Snare C, Hi-Hat L10, Bass C, Rhodes R15, Vinyl C, Samples L20

---

## Hip-Hop (85-100 BPM)

**Key**: Cm / Gm / Dm | **Time Sig**: 4/4

**Arrangement**: Intro(4) -> Verse(16) -> Hook(8) -> Verse(16) -> Hook(8) -> Bridge(8) -> Hook(8) -> Outro(4)

**Track List & FX**:
- **Kick (808)**: HighpassFilter(25) + LowShelfFilter(50, +4dB) + Compressor(-18dB, 4:1, 0.5ms, 40ms)
- **Snare/Clap**: PeakFilter(200, +2dB, q=1.5) + Compressor(-15dB, 3:1) + Reverb(0.1, wet=0.1)
- **Hi-Hat**: HighpassFilter(500) + LowpassFilter(12000) + Gain(-6dB)
- **Bass (808 sub)**: HighpassFilter(25) + Compressor(-12dB, 3:1) + Gain(+2dB)
- **Vocals**: HighpassFilter(100) + Compressor(-12dB, 3:1, 5ms, 60ms) + PeakFilter(3500, +3dB, q=1) + Delay(0.25, feedback=0.15, mix=0.15)
- **Synth Lead**: HighpassFilter(150) + Reverb(0.3, wet=0.2) + Delay(0.375, feedback=0.2, mix=0.2)

**Mix Levels**: Kick -3dB, Snare -5dB, Hi-Hat -10dB, Bass -4dB, Vocals 0dB, Synth -8dB
**Pan**: Kick C, Snare C, Hi-Hat L10/R10 alternating, Bass C, Vocals C, Synth L25

---

## Trap (130-170 BPM, half-time feel)

**Key**: Cm / Bbm / Fm | **Time Sig**: 4/4

**Arrangement**: Intro(4) -> Verse(16) -> Hook(8) -> Verse(16) -> Hook(8) -> Drop(16) -> Hook(8) -> Outro(4)

**Track List & FX**:
- **Kick (808)**: HighpassFilter(20) + LowShelfFilter(40, +5dB) + Compressor(-20dB, 4:1, 0.3ms, 30ms)
- **Snare**: PeakFilter(250, +3dB, q=1.5) + Reverb(0.1, wet=0.15) + Compressor(-16dB, 3:1)
- **Hi-Hat (rolls)**: HighpassFilter(600) + LowpassFilter(14000) + Gain(-8dB)
- **808 Bass**: HighpassFilter(20) + Distortion(5) + Compressor(-10dB, 4:1) + Gain(+3dB)
- **Vocals**: HighpassFilter(100) + Compressor(-10dB, 4:1, 3ms, 50ms) + PeakFilter(4000, +2dB, q=1.5) + Delay(0.2, feedback=0.1, mix=0.1)
- **Synth Pad**: LowpassFilter(5000) + Reverb(0.7, wet=0.5) + HighpassFilter(200)

**Mix Levels**: Kick -2dB, Snare -5dB, Hi-Hat -10dB, 808 Bass -3dB, Vocals 0dB, Pad -12dB
**Pan**: Kick C, Snare C, Hi-Hat L15/R15 rolls, Bass C, Vocals C, Pad wide L40/R40

---

## House (120-130 BPM)

**Key**: Am / Cm / Gm | **Time Sig**: 4/4

**Arrangement**: Intro(16) -> Build(8) -> Drop(16) -> Breakdown(16) -> Build(8) -> Drop(16) -> Outro(16)

**Track List & FX**:
- **Kick**: HighpassFilter(25) + PeakFilter(60, +3dB, q=2) + Compressor(-18dB, 4:1, 1ms, 40ms)
- **Clap**: PeakFilter(1000, +2dB, q=1) + Reverb(0.2, wet=0.25)
- **Hi-Hat**: HighpassFilter(500) + LowpassFilter(10000) + Gain(-8dB)
- **Bass**: HighpassFilter(30) + Compressor(-15dB, 3:1) + LowShelfFilter(80, +2dB) + LowpassFilter(3000)
- **Chord Stab**: HighpassFilter(200) + Reverb(0.35, wet=0.3) + Delay(0.375, feedback=0.2, mix=0.15)
- **Pad**: HighpassFilter(150) + LowpassFilter(8000) + Reverb(0.6, wet=0.4)
- **Vocal Chop**: HighpassFilter(200) + Compressor(-12dB, 3:1) + Reverb(0.3, wet=0.2) + Delay(0.25, feedback=0.15, mix=0.2)

**Mix Levels**: Kick -2dB, Clap -6dB, Hi-Hat -10dB, Bass -5dB, Stab -8dB, Pad -10dB, Vocal -7dB
**Pan**: Kick C, Clap C, Hi-Hat R10, Bass C, Stab L20, Pad wide L30/R30, Vocal R15

---

## Techno (125-140 BPM)

**Key**: Am / Dm (often atonal) | **Time Sig**: 4/4

**Arrangement**: Intro(16) -> Build(16) -> Drop(32) -> Breakdown(16) -> Build(16) -> Drop(32) -> Outro(16)

**Track List & FX**:
- **Kick**: HighpassFilter(20) + PeakFilter(55, +4dB, q=3) + Compressor(-20dB, 5:1, 0.5ms, 30ms)
- **Clap/Rim**: PeakFilter(1200, +2dB, q=1.5) + Reverb(0.15, wet=0.2) + Delay(0.125, feedback=0.1, mix=0.1)
- **Hi-Hat**: HighpassFilter(600) + LowpassFilter(10000) + Gain(-10dB)
- **Bass**: HighpassFilter(25) + Distortion(10) + Compressor(-15dB, 4:1) + LowpassFilter(2000)
- **Synth Loop**: HighpassFilter(200) + Phaser(rate=0.3, depth=0.5) + Delay(0.375, feedback=0.3, mix=0.25) + Reverb(0.4, wet=0.3)
- **Atmosphere**: LowpassFilter(4000) + Reverb(0.9, wet=0.6) + HighpassFilter(200)

**Mix Levels**: Kick -2dB, Clap -7dB, Hi-Hat -12dB, Bass -4dB, Synth -8dB, Atmos -14dB
**Pan**: Kick C, Clap C, Hi-Hat L5, Bass C, Synth L25/R25 movement, Atmos wide L40/R40

---

## Rock (110-140 BPM)

**Key**: E / A / G / D | **Time Sig**: 4/4

**Arrangement**: Intro(4) -> Verse(16) -> Chorus(16) -> Verse(16) -> Chorus(16) -> Solo(16) -> Chorus(16) -> Outro(8)

**Track List & FX**:
- **Kick**: HighpassFilter(30) + PeakFilter(60, +2dB, q=1.5) + PeakFilter(3000, +2dB, q=1) + Compressor(-18dB, 4:1)
- **Snare**: PeakFilter(200, +2dB, q=1) + PeakFilter(5000, +1dB, q=1) + Compressor(-16dB, 3:1) + Reverb(0.2, wet=0.15)
- **Overheads**: HighpassFilter(300) + LowpassFilter(14000) + Compressor(-15dB, 2:1)
- **Bass Guitar**: HighpassFilter(40) + Compressor(-15dB, 3:1) + PeakFilter(800, +2dB, q=1) + Distortion(5)
- **Electric Guitar L**: HighpassFilter(80) + PeakFilter(3000, +2dB, q=1) + Compressor(-12dB, 2:1)
- **Electric Guitar R**: HighpassFilter(80) + PeakFilter(3000, +2dB, q=1) + Compressor(-12dB, 2:1)
- **Vocals**: HighpassFilter(100) + Compressor(-12dB, 3:1, 8ms, 80ms) + PeakFilter(3000, +3dB, q=1) + Reverb(0.25, wet=0.15)

**Mix Levels**: Kick -3dB, Snare -4dB, OH -10dB, Bass -5dB, Gtr L -6dB, Gtr R -6dB, Vocals 0dB
**Pan**: Kick C, Snare C, OH L50/R50, Bass C, Gtr L L80, Gtr R R80, Vocals C

---

## Jazz (100-180 BPM swing)

**Key**: Bb / F / Eb | **Time Sig**: 4/4 swing

**Arrangement**: Head In(32) -> Solo 1(32) -> Solo 2(32) -> Solo 3(32) -> Head Out(32) -> Tag(4)

**Track List & FX**:
- **Kick**: HighpassFilter(40) + Compressor(-18dB, 2:1, 15ms, 150ms)
- **Snare/Brush**: PeakFilter(400, +1dB, q=1) + Reverb(0.3, wet=0.2)
- **Ride**: HighpassFilter(300) + LowpassFilter(12000) + Gain(-3dB)
- **Upright Bass**: HighpassFilter(40) + Compressor(-12dB, 2:1, 10ms, 120ms) + PeakFilter(700, +2dB, q=1)
- **Piano**: HighpassFilter(60) + Compressor(-15dB, 2:1) + Reverb(0.35, wet=0.2)
- **Horn/Sax**: HighpassFilter(100) + Compressor(-12dB, 2:1, 10ms, 100ms) + Reverb(0.25, wet=0.15)

**Mix Levels**: Kick -6dB, Snare -7dB, Ride -8dB, Bass -4dB, Piano -5dB, Horn -3dB
**Pan**: Kick C, Snare C, Ride R20, Bass C, Piano L30, Horn R15

---

## R&B (60-100 BPM)

**Key**: Dm / Am / Bbm | **Time Sig**: 4/4

**Arrangement**: Intro(4) -> Verse(16) -> Pre-chorus(8) -> Chorus(16) -> Verse(16) -> Chorus(16) -> Bridge(8) -> Chorus(16) -> Outro(8)

**Track List & FX**:
- **Kick**: HighpassFilter(25) + LowShelfFilter(60, +3dB) + Compressor(-16dB, 3:1)
- **Snare**: PeakFilter(200, +2dB, q=1) + Compressor(-15dB, 2.5:1) + Reverb(0.25, wet=0.2)
- **Hi-Hat**: HighpassFilter(400) + LowpassFilter(10000) + Gain(-8dB)
- **Bass**: HighpassFilter(30) + Compressor(-12dB, 3:1) + LowShelfFilter(80, +2dB) + Chorus(rate=0.3, depth=0.1)
- **Vocals**: HighpassFilter(80) + Compressor(-14dB, 2.5:1, 8ms, 100ms) + PeakFilter(3000, +2dB, q=1) + Reverb(0.4, wet=0.25) + Delay(0.3, feedback=0.15, mix=0.1)
- **Keys/Pad**: HighpassFilter(100) + Chorus(rate=0.4, depth=0.2) + Reverb(0.5, wet=0.35) + LowpassFilter(8000)
- **Strings**: HighpassFilter(120) + Reverb(0.6, wet=0.3) + LowpassFilter(10000)

**Mix Levels**: Kick -4dB, Snare -6dB, Hi-Hat -12dB, Bass -5dB, Vocals 0dB, Keys -8dB, Strings -10dB
**Pan**: Kick C, Snare C, Hi-Hat R10, Bass C, Vocals C, Keys L20, Strings L30/R30

---

## Ambient (60-100 BPM or free tempo)

**Key**: C / Am / Em (often modal) | **Time Sig**: 4/4 or free

**Arrangement**: Intro(8) -> Evolution A(32) -> Transition(8) -> Evolution B(32) -> Transition(8) -> Evolution C(32) -> Fade Out(16)

**Track List & FX**:
- **Pad 1**: LowpassFilter(4000) + Reverb(0.95, wet=0.7, damping=0.2) + Delay(1.0, feedback=0.5, mix=0.3)
- **Pad 2**: HighpassFilter(200) + Chorus(rate=0.2, depth=0.4) + Reverb(0.9, wet=0.6) + LowpassFilter(6000)
- **Texture**: HighpassFilter(300) + Phaser(rate=0.1, depth=0.3) + Reverb(0.95, wet=0.8) + Delay(1.5, feedback=0.6, mix=0.4)
- **Sub Bass**: HighpassFilter(20) + LowpassFilter(200) + Compressor(-15dB, 2:1) + Gain(-3dB)
- **Field Recording**: HighpassFilter(100) + LowpassFilter(8000) + Reverb(0.7, wet=0.4) + Gain(-10dB)
- **Melodic Fragment**: HighpassFilter(150) + Delay(0.75, feedback=0.5, mix=0.4) + Reverb(0.8, wet=0.5)

**Mix Levels**: Pad 1 -3dB, Pad 2 -5dB, Texture -8dB, Sub -6dB, Field -15dB, Melody -7dB
**Pan**: Pad 1 L30, Pad 2 R30, Texture L50/R50 movement, Sub C, Field wide L40/R40, Melody R20
