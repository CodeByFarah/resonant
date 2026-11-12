# Resonant

A self-hosted AI voice studio modelled on the ElevenLabs web app: text to speech, speech to text, voice changer, sound effects, a voice library, history and settings. It runs real models on your machine. If you add your own ElevenLabs API key, it can also use ElevenLabs' cloud models.

## Run it

Requires Node.js 22.5 or later (it uses the built-in `node:sqlite`). Python and ffmpeg are not needed.

```bash
npm install
npm start          # http://127.0.0.1:3000
npm test           # end-to-end API tests against a running server (BASE=http://host:port)
```

On first use, each local model is downloaded from Hugging Face into `~/.resonant/models`:

| Feature | Model | Download | Speed on CPU |
|---|---|---|---|
| Text to speech | Kokoro 82M (full precision; `RESONANT_KOKORO_DTYPE=q8` for the ~90 MB version, which is ~3× slower on x86 CPUs), 28 English voices | ~330 MB | ~3× real time; first sound in about a second when streaming |
| Speech to text | Whisper Base, timestamped (q8) | ~80 MB | several× real time |
| Sound effects | MusicGen Small | ~1 GB | ~4 s per second of audio |
| Expressive speech + cloning (optional) | Qwen3-TTS CustomVoice + Base, 0.6B or 1.7B | ~4.7 GB (0.6B) / ~9 GB (1.7B), from your Hugging Face cache | ~4–15 s per second of audio |
| Voice design (optional) | Qwen3-TTS 1.7B VoiceDesign | ~4.5 GB | ~10 s per second of audio |
| Voice isolation (optional) | Demucs htdemucs | ~80 MB | ~3 s per second of audio |
| Accurate transcription (optional) | Whisper large-v3-turbo (faster-whisper, int8) | ~1.6 GB | about real time |
| Speaker detection (optional) | ECAPA-TDNN (SpeechBrain) | ~80 MB | a second or two per minute |
| Voice changer (optional) | OpenVoice V2 tone colour converter | ~130 MB | faster than real time |
| Translation, for Dubbing | Opus-MT, one model per language pair (q8); M2M100 418M for the pairs Opus-MT lacks | ~115 MB per pair; ~630 MB | a second or two per line |

All of the optional models run in one Python worker. On a CPU they're slow; on an NVIDIA GPU they're roughly 20–50× faster. See [GPU worker](#gpu-worker).

### Streaming playback

On the Text to Speech and Dialogue pages, MP3 audio starts playing as soon as the first sentence is ready instead of after the whole text. The rest arrives while you listen; on a slow CPU playback can pause briefly between pieces. **Stop** ends generation early, and a stopped clip isn't saved to history. WAV output (and browsers without MediaSource support for MP3) waits for the whole file, as before.

For API callers, `POST /v1/text-to-speech/:voice_id/stream` sends MP3 or PCM as it's generated. The first piece is kept to about one sentence. The `history-item-id` header arrives with the first bytes, and the item is saved once the audio is complete. If the client disconnects, generation stops and nothing is saved. A Qwen3 job that has not started yet is dropped; one the local worker is already running is stopped by restarting the worker, when it is the only job, so the CPU is free again straight away.

`POST /v1/text-to-dialogue/stream` does the same for dialogues. Lines go out in script order, each as soon as every line before it is done. A script that mixes Qwen3 preset voices with cloned voices is still generated grouped by model, to avoid reloading several GB per line, so its lines may arrive in bursts.

### Browser extension (Resonant Reader)

Reads web pages and selected text aloud with your Resonant voices, in Chrome and Edge. It streams from your own server, so reading starts after the first sentence, and nothing goes to any other service. Readings appear in your history.

- **Install:** Settings → Browser extension → **Download extension**, unzip it, open `chrome://extensions` (or `edge://extensions`), turn on Developer mode, then **Load unpacked** and choose the `resonant-reader` folder. The source is in `extension/`.
- **Use:** click the toolbar icon and **Read this page**, right-click selected text, or press **Alt+Shift+R** (read) and **Alt+Shift+S** (stop). It reads the selection if there is one; otherwise the article or main text, without menus, headers, footers or buttons. Pick the voice and speed in the popup.
- **Server:** it connects to `http://localhost:3000` by default. Change the address (and add the API key, if you set one) under **Server** in the popup. Addresses other than this computer ask for permission first.
- **Limits:** it reads up to 20,000 characters per page. Browser pages (`chrome://`, the web store) and PDFs can't be read by extensions; select the text instead. Firefox isn't supported, because it lacks the offscreen audio API this uses.

### Qwen3-TTS (optional)

Adds 9 voices (Vivian, Serena, Uncle Fu, Dylan, Eric, Ryan, Aiden, Ono Anna, Sohee) with natural-language **style instructions** ("whispering softly", "angry and intense"), **10 languages** (English, Chinese, Japanese, Korean, German, French, Russian, Portuguese, Spanish, Italian), **local voice cloning** from a 5–20 s sample, and **voice design**: a new voice from a written description (Tools → Voice Design). It runs in a Python worker (`worker/qwen_worker.py`). The worker starts on first use, keeps one model in memory at a time, and stops after 10 idle minutes. Models load from the Hugging Face cache (`~/.cache/huggingface/hub`) with `HF_HUB_OFFLINE=1`, so nothing is downloaded at runtime.

One-time setup (CPU build of PyTorch, about 1 GB):

```bash
uv venv ~/.resonant/venv --python 3.12
uv pip install --python ~/.resonant/venv/Scripts/python.exe torch torchaudio --index-url https://download.pytorch.org/whl/cpu
uv pip install --python ~/.resonant/venv/Scripts/python.exe qwen-tts soundfile
```

If the models aren't cached yet, download them with `huggingface-cli download`:

| Repository | Needed for |
|---|---|
| `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` and `-0.6B-Base` | the 9 voices and cloning at 0.6B (default) |
| `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` and `-1.7B-Base` | the same at 1.7B |
| `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign` | Design a voice (published only at 1.7B; works with either size setting) |

Pick the size in **Settings → Providers → Model size**. Sizes that aren't downloaded are greyed out. 1.7B sounds a little better but is slower and needs about 7 GB of RAM. Switching restarts the worker on the next request. When the environment or a model is missing, the features that need it simply don't appear.

### Voice library

Besides Kokoro's 28 voices and Qwen's 9 presets, Resonant ships its own library of 68 voices. It covers American, British, Irish, Scottish, Welsh, Australian, Indian, Nigerian and other accents, character voices, and native Spanish, French, German, Italian, Portuguese, Russian, Japanese, Korean and Mandarin speakers. Each voice is described in `library/catalog.mjs`. `scripts/build-library.mjs` designs a reference clip for each one with Qwen3-TTS 1.7B VoiceDesign and checks it: length and loudness for every voice, plus a Whisper transcript match for English voices. Bad takes are retried. Each result is saved to `library/voices/<id>.wav` and `library/voices.json`. When a library voice speaks, the Base model clones its reference clip. That keeps the voice the same from one generation to the next, but it means style instructions don't apply.

```bash
node scripts/build-library.mjs              # build every voice not built yet (resumable)
node scripts/build-library.mjs --only grant # rebuild one voice
```

It needs a running server with VoiceDesign installed (`BASE` picks the server). On a CPU it takes about 75 seconds per voice. To add a voice, add an entry to the catalog and run the script again.

### Voice isolation (optional)

Removes music, hum and background noise and keeps the voice, without an ElevenLabs key. It uses Demucs (MIT licence) in the same Python worker:

```bash
uv pip install --python ~/.resonant/venv/Scripts/python.exe demucs
```

The weights (~80 MB) download into the Torch cache the first time it runs. On a CPU, expect about 3 seconds of work per second of audio, so a 1-minute clip takes about 3 minutes. Files up to 15 minutes are accepted. If ElevenLabs is also connected, the Voice Isolator page lets you choose either one.

### Voice changer (optional)

**Change voice** is true speech-to-speech with OpenVoice V2's tone colour converter (MIT licence). Your recording keeps its words, timing, pauses and emotion, and only the voice changes. The target can be any local voice:
- **Clones, designed voices and library voices** use their own reference clip.
- **Kokoro and Qwen preset voices** speak a short paragraph once, and that clip is cached as their reference.

It runs faster than real time on a CPU (7 s of speech in about 7 s, including the first load), and **Remove background noise** runs Demucs first. **Re-speak words**, the older method, is still there: it transcribes the recording and speaks it again in the target voice.

OpenVoice isn't on PyPI and its declared dependencies are pinned to old versions, so install it without them and add only what the converter imports:

```bash
uv pip install --python ~/.resonant/venv/Scripts/python.exe --no-deps "git+https://github.com/myshell-ai/OpenVoice.git"
uv pip install --python ~/.resonant/venv/Scripts/python.exe librosa pypinyin unidecode cn2an eng_to_ipa inflect jieba
python -c "from huggingface_hub import snapshot_download as d; import os; d('myshell-ai/OpenVoiceV2', allow_patterns=['converter/*'], local_dir=os.path.expanduser('~/.resonant/models/openvoice-v2'))"
```

Resonant builds the converter itself rather than using OpenVoice's `ToneColorConverter` class, which fails when watermarking is turned off. It loads the checkpoint as tensors only (`weights_only`).

**How close it gets:** OpenVoice changes a voice's tone colour, not its whole identity, and it leaves pitch as it is. Measured with the ECAPA speaker model, two conversion passes moved a male voice from 0.13 to 0.33 likeness to another male voice, and from 0.10 to 0.34 to a female voice; the words came through intact both times. The result is a clearly different voice that still keeps some of the original speaker. Same-gender targets sound most convincing, and pitch shifting to bridge genders made it worse in tests.

### Speech to text: accurate model and speaker labels (optional)

Whisper Base, which runs in Node, is fast and always available. For better results, Speech to Text also offers **Whisper Large v3 Turbo**: punctuation, 99 languages, the detected language and its confidence. **Detect speakers** labels who said what (Speaker 1, Speaker 2, …) with either model. You can let it work out the number of speakers or set it. The labels appear in the transcript view and in the TXT, SRT and JSON exports. Both run in the Python worker:

```bash
uv pip install --python ~/.resonant/venv/Scripts/python.exe faster-whisper speechbrain
python -c "from huggingface_hub import snapshot_download as d, os; r=os.path.expanduser('~/.resonant/models'); d('mobiuslabsgmbh/faster-whisper-large-v3-turbo', local_dir=r+'/whisper-large-v3-turbo'); d('speechbrain/spkrec-ecapa-voxceleb', local_dir=r+'/ecapa-voxceleb')"
```

The models download into plain folders under `~/.resonant/models`, so Windows symlink rights aren't needed. Speaker detection splits the speech into turns at pauses, takes a voice fingerprint of each turn, and groups turns whose voices match. If it splits one person into two, or merges two people, set the number of speakers, or adjust `RESONANT_DIARIZE_THRESHOLD` on the worker (default `0.5`; higher splits more readily). In tests it separated two similar American male voices and kept a single speaker as one.

### GPU worker

Qwen3-TTS, voice design and voice isolation run in `worker/qwen_worker.py`. The worker can also run on another machine with an NVIDIA GPU: a gaming PC on your network or a rented cloud GPU (RunPod, Vast.ai, Lambda and others). Resonant then sends it the work. On a GPU, a voice design preview takes a few seconds instead of a minute or two.

On the GPU machine, install a CUDA build of PyTorch plus `qwen-tts soundfile demucs`, download the Qwen models you want into its Hugging Face cache, copy `worker/qwen_worker.py`, and run:

```bash
python qwen_worker.py --host 0.0.0.0 --port 8765 --token YOUR_SECRET --size 1.7B
```

Then in Resonant, open **Settings → Providers → Runs on → GPU worker** and enter `http://<that machine>:8765` and the token. Resonant checks the connection before saving it. Reference clips for cloned and library voices are sent with each request, so the worker doesn't need a copy of your voices. With a GPU that has 24 GB or more, set `QWEN_TTS_MAX_LOADED=4` on the worker to keep every model in memory. Use a token whenever the worker listens on the network, and use HTTPS (or a VPN or SSH tunnel) when it's outside your own network.

### Studio (audiobooks and long-form narration)

**Studio** in the sidebar turns a book, article or script into narration, one chapter at a time:

- **Import:** EPUB (chapters follow the book's reading order; cover, contents and copyright pages are skipped), PDF with a text layer (wrapped lines and hyphenation are joined back up; scanned PDFs have no text to read), Markdown, plain text, or pasted text. Lines such as "Chapter 3", "Part Two", "# Prologue" or "Epilogue" start a new chapter. Long text without headings is cut into parts of about 6,000 characters.
- **Narration:** one narrator for the project, with an optional narrator per chapter (any local voice, clone, design or ElevenLabs voice). It can read chapter titles aloud, and it pauses briefly after each paragraph and a little longer after each title.
- **Rendering:** chapters render one at a time in the background, paragraph by paragraph, straight to MP3 on disk. You can leave the page, and work that was waiting or in progress resumes if the server restarts. Each chapter shows its progress and an estimate of the time left. Editing a chapter's text or changing its narrator marks its audio as out of date.
- **Export:** the whole book as one MP3, or a ZIP with one numbered MP3 per chapter.

Studio audio isn't added to History and doesn't count toward the monthly character limit.

### Dialogue (podcasts, interviews, scenes)

**Dialogue** in the sidebar makes one recording from several voices:

- **Writing:** each line has a speaker. Press Enter in a line to start the next one; the next speaker is whoever spoke before, so a back-and-forth writes itself. Or use **Paste a script** with lines like `Host: Welcome back…`: every new name becomes a speaker with its own voice.
- **Cast:** up to 8 speakers, each with a name and any voice (Kokoro, Qwen3, clones, designs or ElevenLabs). New speakers get a voice that isn't used yet, alternating male and female.
- **Output:** the lines play in order with a pause you choose (0–1.5 s) and come out as one file. History keeps the script, so **Reuse** brings back the lines and voices.
- **Speed:** lines are spoken grouped by engine and then put back in order. A script that alternates a Qwen preset voice with a cloned voice loads each Qwen model once instead of once per line.

### Tags: pauses and emotions in the text

Write tags in square brackets anywhere you type text: Text to Speech, Dialogue lines, Studio chapters, dubbing translations and the API.

- **Pauses** work with every voice: `[pause]` (half a second), `[pause 2s]`, `[pause 300ms]`, `[short pause]`, `[long pause]`. With ElevenLabs voices they become `<break>` tags.
- **Emotions** change how the Qwen3 preset voices speak: `[whisper]`, `[excited]`, `[happy]`, `[sad]`, `[angry]`, `[calm]`, `[scared]`, `[shouting]`, `[sarcastic]`, `[serious]`, `[laughs]`, `[sighs]`, `[curious]`, `[surprised]`, `[tired]`, `[mysterious]`. Any other description of two or more words works too, like `[speaking slowly]`. An emotion lasts until the next one or the end of the line; `[normal]` ends it.
- Voices that can't take instructions (Kokoro, clones, designed voices, ElevenLabs) skip emotion tags and read the words normally. Tags are never read aloud and don't count toward the character limit. Brackets with no letters, like `[1]`, stay in the text, and an unknown single word, like `[sic]`, is left out.
- The Text to Speech settings and the Dialogue cast panel have buttons that insert tags at the cursor.

### Dubbing

**Dubbing** in the sidebar puts a video or recording into another language:

1. **Transcribe:** Whisper finds the words and who speaks when. Large-v3-turbo also detects the language; with Whisper Base you pick it.
2. **Translate:** each line is translated sentence by sentence, on your machine. Most pairs use **Opus-MT** (Helsinki-NLP, CC-BY 4.0): a small model trained for that one pair, about 115 MB each, downloaded the first time you use the pair. Pairs without a direct model go through English when both halves exist (German → Italian is German → English → Italian). Into Japanese and Korean, and as a fallback, it uses **M2M100 418M** (MIT licence, about 630 MB), whose translations are rougher; the New dub dialog says which model a pair uses. Set `RESONANT_TRANSLATOR=m2m100` to use M2M100 for everything.
3. **Keep the background:** Demucs separates the voices from music and sound effects, and the new voices go on top of what's left.
4. **Voices:** by default each speaker keeps their own voice. Resonant cuts up to 12 seconds of their lines into a sample, and Qwen3-TTS clones it to speak the translation. You can give any speaker a library voice instead; Kokoro voices only work when dubbing into English.
5. **Timing:** each line starts where the original did. If it runs longer than the gap before the next line, it's sped up by up to 30% without changing the pitch, and anything beyond that pushes later lines back a little.

The editor shows every line with the original words and an editable translation. You can change a line's speaker, translate it again, or play it on its own. Edited lines are marked; **Apply changes** voices only those lines and mixes again. The preview plays the original video with the new sound, and you can switch to the original sound to compare.

**Export:** dubbed audio as MP3 or WAV, subtitles (SRT) in either language, or a dubbed video. Only the audio is uploaded; the video stays in your browser (IndexedDB) for the preview. **Dubbed video (MP4)** is built in the browser with [Mediabunny](https://mediabunny.dev) (MPL-2.0), with no ffmpeg and no upload. H.264 and HEVC video (most MP4 and MOV files) is copied without re-encoding, so a 5-second clip exports in about 0.3 s. VP8/VP9 video (WebM) is re-encoded to H.264, because iPhones and QuickTime can't play VP8/VP9 inside an MP4. The new sound is AAC. It needs Chrome or Edge (WebCodecs), and the whole file is built in memory, so very large videos need plenty of RAM. The older **WebM** export is still there as a fallback; it records in real time, so a 3-minute video takes 3 minutes.

**Limits:** up to 10 minutes per file, in English, Spanish, French, German, Italian, Portuguese, Russian, Chinese, Japanese and Korean (the languages Qwen3-TTS speaks). Translations from a small model are understandable but not polished, so read them through. Without a GPU, cloned voices take about a minute or more per line. Dubbing doesn't count toward the monthly character limit.

### Pronunciation dictionary

**Pronunciation** in the sidebar holds the words every voice should say differently: names, brands and abbreviations, written the way they should sound (`Nguyen` → `win`, `SQL` → `sequel`).

- It applies everywhere: Text to Speech, Dialogue, Studio and the API, for local and ElevenLabs voices. History keeps the text as you typed it.
- Only whole words match, the longest match wins (`New York City` before `New York`), and **Match case** limits a rule to one capitalization (`US` but not `us`). A rule can be switched off without deleting it.
- **Try it** shows what the voice will read and plays it. **Export** saves a JSON file; **Import** takes that file or a CSV/TXT with lines like `word, say it like`.
- In Studio, a rule that changes a chapter's text marks that chapter's audio as out of date.

On Windows without Developer Mode, `huggingface_hub` can fail to create symlinks partway through a download. Resonant treats a model as installed only when its snapshot has both `config.json` and `model.safetensors`. If a download stopped early, run it again, or copy the leftover files from `blobs/` into the snapshot folder.

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT`, `HOST` | `3000`, `127.0.0.1` | Listen address |
| `RESONANT_API_KEY` | unset | When set, every API call needs `xi-api-key: <key>` and the web app asks for the key |
| `RESONANT_DATA_DIR` | `data/` next to the code | SQLite database and audio files (the same folder whichever directory you start the server from) |
| `RESONANT_MODELS_DIR` | `~/.resonant/models` | Model cache (kept short because onnxruntime can't open paths over 260 characters on Windows) |
| `RESONANT_SFX_IDLE_MINUTES` | `5` | Unloads MusicGen after this much idle time to free about 2 GB of RAM (`0` keeps it loaded) |
| `ELEVENLABS_API_KEY` | unset | Optional cloud provider. It can also be set in Settings → Providers |
| `RESONANT_PYTHON` | `~/.resonant/venv/Scripts/python.exe` | Python used for the Qwen3-TTS worker |
| `RESONANT_QWEN_SIZE` | `0.6B` | Initial model size. The Settings choice overrides it once saved |
| `RESONANT_QWEN_IDLE_MINUTES` | `10` | Stops the Qwen worker after this much idle time (`0` keeps it running) |
| `RESONANT_WORKER_URL`, `RESONANT_WORKER_TOKEN` | unset | Use a GPU worker on another machine. The Settings choice overrides these once saved |

## Architecture

```
public/            Single-page app with no build step (ES modules)
  js/app.js        router, shell, global waveform player, modals, voice picker, browser audio conversion
  js/pages.js      Home, Text to Speech, Voice Library, My Voices, Settings
  js/tools.js      Voice Changer, Voice Design, Sound Effects, Speech to Text, Voice Isolator, History
  js/studio.js     Studio: project list and chapter editor
  js/dialogue.js   Dialogue editor and Pronunciation dictionary
  js/dubbing.js    Dubbing: list, new dub dialog, editor, export (audio, subtitles, MP4 or WebM video)
extension/         Resonant Reader browser extension (Chrome/Edge, Manifest V3): popup, background worker, offscreen player
server/index.mjs   HTTP server with an ElevenLabs-compatible REST API, plus static hosting
server/studio.mjs  Studio projects, chapters, background render queue, export
server/pronunciation.mjs  pronunciation dictionary: rules, matching, /api/pronunciation
server/tags.mjs    inline [pause] and [emotion] tags
server/dubbing.mjs dubbing jobs: transcribe, translate, separate, clone, voice, fit, mix; /api/dubbing
server/engines/translate.mjs   translation: Opus-MT per pair, through English, M2M100 fallback (transformers.js)
server/importers.mjs  EPUB / PDF / Markdown / text to chapters
server/db.mjs      SQLite: history, transcripts, voice metadata, settings
server/audio.mjs   WAV/MP3/PCM encode, WAV/MP3 decode, resampling, output_format parsing
server/engines/local.mjs       Kokoro / Whisper / MusicGen via transformers.js + onnxruntime-node
server/engines/elevenlabs.mjs  passthrough to api.elevenlabs.io with the user's key
server/engines/qwen.mjs        manages the Python worker, local or remote (size setting, presets, cloning, design, isolation)
worker/qwen_worker.py          HTTP worker: /custom_voice, /clone, /design, /isolate, /transcribe, /diarize, /convert (CPU or CUDA, optional token)
```

The API follows the public ElevenLabs API reference, so ElevenLabs clients can point at Resonant by changing only the base URL:

| Endpoint | Local engine | With ElevenLabs key |
|---|---|---|
| `POST /v1/text-to-speech/:voice_id` (`/stream`) | Kokoro, or Qwen3-TTS for `qwen_*` and cloned voices (extra body fields: `instructions`, `language_code`) | ElevenLabs voices and models |
| `POST /v1/text-to-dialogue` (`/stream`) | `{ inputs: [{ text, voice_id, speaker? }], settings: { pause_seconds } }` (`speaker` is an optional display name kept in History): several local voices in one file (up to 300 lines, 20,000 characters) | ElevenLabs voices can take part (each line uses `eleven_multilingual_v2`) |
| `/api/dubbing/*` | `POST /api/dubbing` (multipart: `file`, `target_lang`, optional `source_lang`, `num_speakers`, `voice_id`, `keep_background`), `GET`/`PATCH`/`DELETE /:id`, `PATCH /:id/segments/:seg { translation, speaker_id }`, `POST /:id/segments/:seg/retranslate`, `POST /:id/render`, `POST /:id/cancel`, `GET /:id/audio?format=mp3|wav`, `GET /:id/subtitles?format=srt|vtt[&original=1]` | ElevenLabs voices can be given to speakers |
| `/api/pronunciation` | Dictionary: `GET`, `POST { word, alias, case_sensitive }`, `PATCH`/`DELETE /:id`, `POST /import { rules }`, `POST /apply { text }` | Applied to ElevenLabs voices too |
| `POST /v1/speech-to-text` | `whisper_base`, or `whisper_large_v3_turbo` when installed; `diarize=true` and optional `num_speakers` (1–32) add `speaker_id` per word | Scribe (`scribe_v1`, `scribe_v2`), `diarize` and `num_speakers` passed through |
| `POST /v1/speech-to-speech/:voice_id` | `mode=convert` (default with OpenVoice): speech-to-speech that keeps timing and emotion, optional `remove_background_noise`; `mode=revoice`: transcribe, then re-speak | true speech-to-speech |
| `POST /v1/sound-generation` | MusicGen (`musicgen_small`) | `eleven_text_to_sound_v2` |
| `POST /v1/audio-isolation` | Demucs (`provider=local`, the default when installed; WAV or MP3 up to 15 min) | `provider=elevenlabs` |
| `/api/studio/*` | Studio projects: `projects`, `import`, `projects/:id/generate`, `chapters/:id/generate`, `chapters/:id/audio`, `projects/:id/export?format=mp3\|zip` | ElevenLabs voices can narrate |
| `POST /v1/voices/add`, `DELETE /v1/voices/:id` | Qwen3-TTS clone (`provider=qwen`, optional `transcript`; otherwise Whisper transcribes the sample) | Instant Voice Clone (`provider=elevenlabs`) |
| `POST /v1/text-to-voice/design`, `POST /v1/text-to-voice` | Qwen3-TTS VoiceDesign: preview from `voice_description` (10–1000 chars, optional `text`), then save with `voice_name` + `generated_voice_id` (category `generated`) | — |
| `GET /v2/voices`, `/v1/voices/:id`, `/v1/voices/:id/preview` | local voices | local and account voices merged |
| `GET/DELETE /v1/history[/:id]`, `/v1/history/:id/audio`, `POST /v1/history/download` | ✓ (ZIP for multiple items) | ✓ |
| `GET /v1/models`, `/v1/user`, `/v1/user/subscription` | ✓ | ✓ |

Output formats: `mp3_<rate>_<kbps>`, `wav_<rate>` and `pcm_<rate>`.

## Landing page

`site/` is a static landing page: the voice samples on it were made by Resonant itself, and each word lights up as it's spoken. It needs no server code, so any static host (Netlify, GitHub Pages, Cloudflare Pages) can publish the folder as it is.

- **Preview:** `node scripts/serve-site.mjs` serves it on http://127.0.0.1:4173.
- **Re-record the samples:** with Resonant running, `node scripts/make-site-samples.mjs` regenerates `site/audio/` and `site/samples.js` (texts and voices are at the top of the script) and removes the history items it created.
- **Before publishing:** set `REPO` at the top of `site/main.js` to the code's public address, so the "Get the code" step becomes a link.

## How this was built, and what wasn't accessible

- **`elevenlabs.io/app/*` is behind a sign-in.** The owner signed in with their own account. Layout, sizes, colors and type scale were measured from the signed-in pages. Request/response shapes come from the public ElevenLabs API reference (`/docs/api-reference/*`, `/docs/llms.txt`).
- **It uses its own identity on purpose.** Layout, spacing and colors follow the ElevenLabs studio closely. The name, logo, wording, icons and fonts (Inter and Inter Tight) are its own. It must not be presented as ElevenLabs.
- **ElevenLabs' models are proprietary.** Local quality, languages and features come from open models, so Kokoro voices are English-only (Qwen3-TTS adds 10 languages), and the stability/similarity/style settings apply only to ElevenLabs voices (local voices support speed).

## Known limits

- **Local voice changer:** with OpenVoice installed it keeps timing and emotion, but it changes tone colour rather than the whole identity (see Voice changer). Without OpenVoice it falls back to re-speaking the transcript.
- **Worker crashes on this kind of laptop:** swapping one 7 GB Qwen model for another occasionally crashes the worker when memory is tight. Resonant then starts a fresh worker and retries the request once, so the request still succeeds; it fails only if the fresh worker crashes too.
- **Local cloning needs Qwen3-TTS** (see above). It copies the timbre and tone of the sample. Style instructions work only with the 9 built-in Qwen voices, not with clones.
- **Qwen3-TTS and Demucs on CPU are slow:** about 4 s per second of speech, plus 10–60 s when the worker first starts or swaps between models. Only one model stays in memory at a time. At 1.7B, expect about 2× the time. A [GPU worker](#gpu-worker) fixes this.
- **Licences to check before selling Resonant:** Settings → About and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) list every model and library with its licence (both come from `public/js/credits.js`; run `npm run notices` after editing it). Kokoro's pronunciation step includes eSpeak NG, which is GPL-3.0-or-later, so a build that ships it must also make that source available (linked in the notices). The MusicGen Small weights used for Sound Effects are CC-BY-NC 4.0 (non-commercial). Qwen3-TTS and Kokoro are Apache 2.0, Whisper is MIT, Demucs is MIT, M2M100 is MIT. The Opus-MT translation models are CC-BY 4.0, which allows commercial use but requires crediting Helsinki-NLP (the OPUS-MT project) in the product. Mediabunny (the MP4 export library) is MPL-2.0: fine to ship unmodified in a commercial product; changes to its own files would have to be published. `npm audit` reports advisories in `sharp`, an image library that `@huggingface/transformers` installs but Resonant never calls.
- **Local speech to text:** Whisper Base doesn't report which language it detected (Turbo does). Speaker detection handles clear turns well, but people talking over each other are labelled as one speaker.
- **Server-side decoding** handles WAV and MP3. The web app converts other formats (M4A, WebM, OGG, FLAC, video) to WAV in the browser before uploading. Direct API callers must send WAV or MP3.
- **Transcripts don't store the source audio,** so word-click playback works only in the browser session that uploaded the file.
- **Translation quality:** Opus-MT handles everyday speech well, but it translates sentence by sentence without the surrounding context, so a pronoun or a formal/informal "you" can come out wrong. Pairs into Japanese and Korean use M2M100 and need more checking. Every line can be edited in the dubbing editor.
- **Not built:** multi-speaker dialogue inside a chapter, Conversational AI agents, Music, team workspaces, and billing. Each is a large product on its own.
- **Single-user.** One optional access key, with no accounts or roles. Put it behind HTTPS (for example a reverse proxy) before exposing it beyond localhost.
- **Memory:** with all three models loaded the server uses about 3.5 GB of RAM. MusicGen unloads after it has been idle.
