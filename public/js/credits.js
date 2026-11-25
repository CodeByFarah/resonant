// Models and libraries Resonant uses, with their licences. Settings → About shows this list, and
// scripts/write-notices.mjs turns it into THIRD_PARTY_NOTICES.md. Plain data, so Node can import it.
// `attribution` is credit text a licence requires to be shown; `caution` flags a limit users need to know.

export const MODELS = [
  { name: "Kokoro 82M", use: "Text to speech: the 28 built-in voices", by: "hexgrad", license: "Apache-2.0",
    url: "https://huggingface.co/hexgrad/Kokoro-82M" },
  { name: "Whisper Base", use: "Speech to text and word timings", by: "OpenAI", license: "MIT",
    url: "https://github.com/openai/whisper" },
  { name: "Qwen3-TTS (CustomVoice, Base, VoiceDesign)", use: "Expressive voices, voice cloning and voice design", by: "the Alibaba Qwen team", license: "Apache-2.0",
    url: "https://github.com/QwenLM/Qwen3-TTS" },
  { name: "Whisper Large v3 Turbo", use: "Accurate transcription (through faster-whisper)", by: "OpenAI", license: "MIT",
    url: "https://huggingface.co/openai/whisper-large-v3-turbo" },
  { name: "ECAPA-TDNN speaker model", use: "Speaker detection in transcripts", by: "SpeechBrain", license: "Apache-2.0",
    url: "https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb" },
  { name: "OpenVoice V2", use: "Voice changer", by: "MyShell AI", license: "MIT",
    url: "https://github.com/myshell-ai/OpenVoice" },
  { name: "Demucs (htdemucs)", use: "Voice isolation", by: "Meta AI", license: "MIT",
    url: "https://github.com/facebookresearch/demucs" },
  { name: "OPUS-MT", use: "Translation for dubbing", by: "Helsinki-NLP, University of Helsinki", license: "CC-BY-4.0",
    url: "https://github.com/Helsinki-NLP/Opus-MT",
    attribution: "Translation models: OPUS-MT by the Language Technology Research Group at the University of Helsinki (Helsinki-NLP), licensed under CC BY 4.0. Resonant uses the ONNX conversions published by Xenova, quantized to 8 bits." },
  { name: "M2M100 418M", use: "Translation for the language pairs OPUS-MT lacks", by: "Meta AI", license: "MIT",
    url: "https://huggingface.co/facebook/m2m100_418M" },
  { name: "MusicGen Small", use: "Sound effects", by: "Meta AI", license: "CC-BY-NC-4.0",
    url: "https://huggingface.co/facebook/musicgen-small",
    caution: "Non-commercial use only: sounds made with it can't be used in anything that earns money." },
];

export const LIBRARIES = [
  { name: "Transformers.js", by: "Hugging Face", license: "Apache-2.0", url: "https://github.com/huggingface/transformers.js" },
  { name: "ONNX Runtime", by: "Microsoft", license: "MIT", url: "https://github.com/microsoft/onnxruntime" },
  { name: "kokoro-js", by: "hexgrad and Xenova", license: "Apache-2.0", url: "https://github.com/hexgrad/kokoro" },
  { name: "phonemizer", by: "Xenova", license: "Apache-2.0", url: "https://github.com/xenova/phonemizer",
    note: "Includes eSpeak NG, compiled to WebAssembly, for pronunciation.",
    also: { name: "eSpeak NG", license: "GPL-3.0-or-later", url: "https://github.com/espeak-ng/espeak-ng" } },
  { name: "lamejs", by: "breezystack (a port of LAME)", license: "LGPL-3.0", url: "https://github.com/breezystack/lamejs",
    note: "MP3 encoding. Used unmodified, as a separate module." },
  { name: "mpg123-decoder", by: "Ethan Halsall (wasm-audio-decoders)", license: "MIT", url: "https://github.com/eshaz/wasm-audio-decoders",
    note: "Includes mpg123, compiled to WebAssembly, for MP3 decoding.",
    also: { name: "mpg123", license: "LGPL-2.1", url: "https://www.mpg123.de/" } },
  { name: "Mediabunny", by: "Vanilagy", license: "MPL-2.0", url: "https://github.com/Vanilagy/mediabunny",
    note: "MP4 export for dubs. Used unmodified." },
  { name: "PDF.js", by: "Mozilla", license: "Apache-2.0", url: "https://github.com/mozilla/pdf.js" },
  { name: "MCP TypeScript SDK", by: "Anthropic and the Model Context Protocol contributors", license: "MIT", url: "https://github.com/modelcontextprotocol/typescript-sdk", note: "The server that lets AI apps use Resonant." },
  { name: "Zod", by: "Colin McDonnell", license: "MIT", url: "https://github.com/colinhacks/zod" },
  { name: "wavefile", by: "Rafael da Silva Rocha", license: "MIT", url: "https://github.com/rochars/wavefile" },
  { name: "PyTorch", by: "PyTorch Foundation", license: "BSD-3-Clause", url: "https://github.com/pytorch/pytorch", note: "Optional Python worker." },
  { name: "qwen-tts", by: "the Alibaba Qwen team", license: "Apache-2.0", url: "https://github.com/QwenLM/Qwen3-TTS", note: "Optional Python worker." },
  { name: "faster-whisper and CTranslate2", by: "SYSTRAN and OpenNMT", license: "MIT", url: "https://github.com/SYSTRAN/faster-whisper", note: "Optional Python worker." },
  { name: "SpeechBrain", by: "SpeechBrain", license: "Apache-2.0", url: "https://github.com/speechbrain/speechbrain", note: "Optional Python worker." },
];

export const LICENSE_URLS = {
  "Apache-2.0": "https://www.apache.org/licenses/LICENSE-2.0",
  MIT: "https://opensource.org/license/mit",
  "BSD-3-Clause": "https://opensource.org/license/bsd-3-clause",
  "CC-BY-4.0": "https://creativecommons.org/licenses/by/4.0/",
  "CC-BY-NC-4.0": "https://creativecommons.org/licenses/by-nc/4.0/",
  "GPL-3.0-or-later": "https://www.gnu.org/licenses/gpl-3.0.html",
  "LGPL-3.0": "https://www.gnu.org/licenses/lgpl-3.0.html",
  "LGPL-2.1": "https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html",
  "MPL-2.0": "https://www.mozilla.org/MPL/2.0/",
};
