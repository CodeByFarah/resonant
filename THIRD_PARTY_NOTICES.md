# Third-party notices

Resonant uses the models and libraries below. Each keeps its own licence; this file lists them with the credit each one asks for. It is generated from `public/js/credits.js` by `node scripts/write-notices.mjs`; edit that file, not this one.

Models are downloaded the first time a feature needs them, from the address shown. The npm and Python packages carry their full licence texts in their own folders (`node_modules/<name>/LICENSE`, or the package's `dist-info` folder).

## Models

### Kokoro 82M

Text to speech: the 28 built-in voices. By hexgrad. Licence: [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0). Source: <https://huggingface.co/hexgrad/Kokoro-82M>

### Whisper Base

Speech to text and word timings. By OpenAI. Licence: [MIT](https://opensource.org/license/mit). Source: <https://github.com/openai/whisper>

### Qwen3-TTS (CustomVoice, Base, VoiceDesign)

Expressive voices, voice cloning and voice design. By the Alibaba Qwen team. Licence: [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0). Source: <https://github.com/QwenLM/Qwen3-TTS>

### Whisper Large v3 Turbo

Accurate transcription (through faster-whisper). By OpenAI. Licence: [MIT](https://opensource.org/license/mit). Source: <https://huggingface.co/openai/whisper-large-v3-turbo>

### ECAPA-TDNN speaker model

Speaker detection in transcripts. By SpeechBrain. Licence: [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0). Source: <https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb>

### OpenVoice V2

Voice changer. By MyShell AI. Licence: [MIT](https://opensource.org/license/mit). Source: <https://github.com/myshell-ai/OpenVoice>

### Demucs (htdemucs)

Voice isolation. By Meta AI. Licence: [MIT](https://opensource.org/license/mit). Source: <https://github.com/facebookresearch/demucs>

### OPUS-MT

Translation for dubbing. By Helsinki-NLP, University of Helsinki. Licence: [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Source: <https://github.com/Helsinki-NLP/Opus-MT>

> Translation models: OPUS-MT by the Language Technology Research Group at the University of Helsinki (Helsinki-NLP), licensed under CC BY 4.0. Resonant uses the ONNX conversions published by Xenova, quantized to 8 bits.

### M2M100 418M

Translation for the language pairs OPUS-MT lacks. By Meta AI. Licence: [MIT](https://opensource.org/license/mit). Source: <https://huggingface.co/facebook/m2m100_418M>

### MusicGen Small

Sound effects. By Meta AI. Licence: [CC-BY-NC-4.0](https://creativecommons.org/licenses/by-nc/4.0/). Source: <https://huggingface.co/facebook/musicgen-small>

**Note:** Non-commercial use only: sounds made with it can't be used in anything that earns money.

## Libraries

- **Transformers.js**, by Hugging Face. Licence: [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0). Source: <https://github.com/huggingface/transformers.js>
- **ONNX Runtime**, by Microsoft. Licence: [MIT](https://opensource.org/license/mit). Source: <https://github.com/microsoft/onnxruntime>
- **kokoro-js**, by hexgrad and Xenova. Licence: [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0). Source: <https://github.com/hexgrad/kokoro>
- **phonemizer**, by Xenova. Licence: [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0). Source: <https://github.com/xenova/phonemizer>. Includes eSpeak NG, compiled to WebAssembly, for pronunciation.
  - eSpeak NG: licence [GPL-3.0-or-later](https://www.gnu.org/licenses/gpl-3.0.html). Source code: <https://github.com/espeak-ng/espeak-ng>
- **lamejs**, by breezystack (a port of LAME). Licence: [LGPL-3.0](https://www.gnu.org/licenses/lgpl-3.0.html). Source: <https://github.com/breezystack/lamejs>. MP3 encoding. Used unmodified, as a separate module.
- **mpg123-decoder**, by Ethan Halsall (wasm-audio-decoders). Licence: [MIT](https://opensource.org/license/mit). Source: <https://github.com/eshaz/wasm-audio-decoders>. Includes mpg123, compiled to WebAssembly, for MP3 decoding.
  - mpg123: licence [LGPL-2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html). Source code: <https://www.mpg123.de/>
- **Mediabunny**, by Vanilagy. Licence: [MPL-2.0](https://www.mozilla.org/MPL/2.0/). Source: <https://github.com/Vanilagy/mediabunny>. MP4 export for dubs. Used unmodified.
- **PDF.js**, by Mozilla. Licence: [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0). Source: <https://github.com/mozilla/pdf.js>
- **wavefile**, by Rafael da Silva Rocha. Licence: [MIT](https://opensource.org/license/mit). Source: <https://github.com/rochars/wavefile>
- **PyTorch**, by PyTorch Foundation. Licence: [BSD-3-Clause](https://opensource.org/license/bsd-3-clause). Source: <https://github.com/pytorch/pytorch>. Optional Python worker.
- **qwen-tts**, by the Alibaba Qwen team. Licence: [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0). Source: <https://github.com/QwenLM/Qwen3-TTS>. Optional Python worker.
- **faster-whisper and CTranslate2**, by SYSTRAN and OpenNMT. Licence: [MIT](https://opensource.org/license/mit). Source: <https://github.com/SYSTRAN/faster-whisper>. Optional Python worker.
- **SpeechBrain**, by SpeechBrain. Licence: [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0). Source: <https://github.com/speechbrain/speechbrain>. Optional Python worker.
