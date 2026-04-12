---
name: voice-synthesis
description: "This skill should be used when the user asks to 'generate vocals', 'text to speech', 'TTS', 'clone voice', 'voice synthesis', 'sing in another language', 'translate vocals', or wants to create vocal audio from text. Covers GPT-SoVITS, Bark, edge-tts, and vocal generation pipelines."
requirements:
  python: [requests, soundfile, numpy]
allowed-tools: [Read, Write, Bash, Glob, WebSearch]
---

# Voice Synthesis

## Purpose

Generate vocal audio tracks from text input using AI-powered text-to-speech and voice cloning systems. Cover the full pipeline from text preparation through synthesis, time-alignment, stitching, and integration with backing tracks. Support multiple engines depending on quality requirements, language needs, and available resources.

## GPT-SoVITS Workflow (Primary)

GPT-SoVITS is the recommended engine for high-quality voice cloning and multilingual vocal synthesis. It produces natural-sounding speech that closely matches a reference voice.

### Step 1: Install GPT-SoVITS

Clone the repository and install dependencies:

```
git clone https://github.com/RVC-Boss/GPT-SoVITS.git
cd GPT-SoVITS
pip3 install -r requirements.txt
```

Download the pretrained models. The repository README links to the required model files. Place them in the `pretrained_models/` directory as documented. Verify all model files are present before proceeding.

### Step 2: Start the API Server

Launch the GPT-SoVITS API server:

```
python3 api_v2.py -a 127.0.0.1 -p 9880
```

Confirm the server is running by checking `http://127.0.0.1:9880/docs` in a browser or with curl. The API must remain running throughout the synthesis session.

### Step 3: Prepare Reference Audio

Extract a clean vocal clip from existing audio to use as the voice reference. The clip should be 3-10 seconds of clear speech with minimal background noise:

```
ffmpeg -i source.wav -ss 00:00:05 -t 00:00:08 -ac 1 -ar 44100 reference.wav
```

Longer reference clips (closer to 10 seconds) yield better voice cloning fidelity. Ensure the reference contains no music, reverb, or background noise -- use a stem-separated vocal if necessary. Trim silence from the beginning and end of the clip.

### Step 4: Generate Speech via API

Send a POST request to the TTS endpoint with the text, language, and reference audio:

```python
import requests

params = {
    "text": "The line of text to synthesize",
    "text_lang": "en",
    "ref_audio_path": "/absolute/path/to/reference.wav",
    "prompt_text": "The words spoken in the reference clip",
    "prompt_lang": "en",
    "speed_factor": 1.0
}

response = requests.post("http://127.0.0.1:9880/tts", json=params)

with open("output_line.wav", "wb") as f:
    f.write(response.content)
```

Provide `prompt_text` matching exactly what is spoken in the reference audio -- this anchors the voice cloning.

### Step 5: Language Support

GPT-SoVITS natively supports: `en` (English), `zh` (Chinese), `ja` (Japanese), `yue` (Cantonese), `ko` (Korean).

Arabic is NOT natively supported. For Arabic text, set `text_lang` to `"auto"` and test output quality. If results are poor, fall back to edge-tts which has strong Arabic support.

For cross-language synthesis (e.g., an English reference voice generating Japanese speech), set `ref_audio_path` and `prompt_lang` to the reference language, and `text_lang` to the target language.

### Step 6: Stitch Lines at Timestamps

When generating vocals for an entire song or long passage, synthesize each line individually and place them at the correct timestamps:

1. Split the lyrics into individual lines with target start times.
2. Generate each line as a separate WAV file via the API.
3. Measure each generated clip's duration with ffprobe.
4. If a clip is too long or too short for its slot, adjust `speed_factor` in the API call and regenerate, or apply ffmpeg's atempo filter post-generation:
   ```
   ffmpeg -i line.wav -filter:a "atempo=1.1" line_adjusted.wav
   ```
5. Create a silent base track of the full song duration and overlay each line at its timestamp using ffmpeg's amix or adelay filters.

## Alternative Tools

### edge-tts

Free Microsoft Edge TTS service. Excellent language coverage including Arabic, fast generation, no GPU required. Best for quick drafts or languages not covered by GPT-SoVITS:

```
pip3 install edge-tts
edge-tts --voice "en-US-AriaNeural" --text "Hello world" --write-media output.mp3
```

List available voices with `edge-tts --list-voices`. Filter by language code (e.g., `ar-SA` for Arabic). No voice cloning capability -- only preset voices are available.

### Bark

Open-source model from Suno with multilingual support and some singing ability. Heavier than edge-tts but more expressive:

```
pip3 install git+https://github.com/suno-ai/bark.git
```

```python
from bark import generate_audio, SAMPLE_RATE
from scipy.io.wavfile import write as write_wav

audio = generate_audio("Hello, this is a test.", history_prompt="v2/en_speaker_6")
write_wav("output.wav", SAMPLE_RATE, audio)
```

Bark supports speaker prompts for different voices and can insert non-speech sounds (laughter, sighs) with text tags. Generation is slow without a GPU.

### ElevenLabs API

Highest quality commercial option with excellent voice cloning. Requires an API key and a paid plan for significant usage:

```python
import requests

headers = {"xi-api-key": "YOUR_API_KEY"}
data = {"text": "Text to speak", "voice_settings": {"stability": 0.5, "similarity_boost": 0.75}}

response = requests.post(
    "https://api.elevenlabs.io/v1/text-to-speech/VOICE_ID",
    headers=headers, json=data
)

with open("output.mp3", "wb") as f:
    f.write(response.content)
```

Use ElevenLabs when maximum quality is needed and budget permits. Clone custom voices through their web dashboard before using the API.

## Vocal Processing Pipeline

After synthesis, process the generated vocals for integration with a mix:

1. **Generate**: Produce each vocal line using the chosen engine.
2. **Time-align**: Adjust duration of each clip to match the intended timing in the arrangement.
3. **Stitch**: Combine all clips into a single continuous vocal track with correct spacing.
4. **Mix**: Feed the stitched vocal into the mix-engineer skill for EQ, compression, reverb, and level balancing with the backing track.

## Speed Factor Tuning

If generated audio does not match the required duration:

- Increase `speed_factor` above 1.0 to make speech faster (shorter duration).
- Decrease below 1.0 to make speech slower (longer duration).
- For fine adjustments after generation, use ffmpeg atempo (valid range 0.5-2.0; chain multiple filters for larger changes):
  ```
  ffmpeg -i input.wav -filter:a "atempo=0.8" slower.wav
  ffmpeg -i input.wav -filter:a "atempo=2.0,atempo=1.5" much_faster.wav
  ```

## Tips

- Longer reference audio (8-10 seconds) produces significantly better voice cloning than short clips (3 seconds).
- Clean reference audio is critical. Any noise, reverb, or music in the reference degrades cloning quality. Always use stem-separated vocals as reference when possible.
- Generate a test line first and audition it before batch-generating an entire song's worth of vocals.
- For singing synthesis, GPT-SoVITS works best with a singing reference clip rather than a spoken one.
- Monitor the API server's console output for warnings or errors during generation. Out-of-memory errors on GPU can be resolved by reducing text length per request.
- When mixing synthesized vocals with a backing track, apply slight reverb to help the synthetic voice sit more naturally in the mix.
