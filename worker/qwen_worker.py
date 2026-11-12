"""Resonant's Python worker: Qwen3-TTS speech, cloning and design, plus Demucs voice isolation.

The Node server starts it on demand on this computer. It can also run on another machine with a
GPU, and the Node server connects to it over the network (Settings -> Providers -> GPU worker):

    python qwen_worker.py --host 0.0.0.0 --port 8765 --token <secret>

Endpoints (JSON in; raw little-endian float32 mono samples out, rate in `x-sample-rate`):
  GET  /health
  POST /custom_voice  {text, speaker, language?, instruct?}
  POST /clone         {text, ref_audio_b64 (WAV) | ref_audio (local path), ref_text?, language?}
  POST /design        {text, instruct, language?}
  POST /isolate       raw float32 mono samples, `x-sample-rate` header -> the voice with background removed
  POST /transcribe    body: uint32 LE options length, options JSON {language?, diarize?, num_speakers?}, then
                      float32 mono 16 kHz samples -> JSON {words, speakers, language, language_probability}
  POST /diarize       same body, options {words: [{start, end}], num_speakers?} -> JSON {speakers}
  POST /convert       same body (any `x-sample-rate`), options {ref_audio_b64 (WAV of the target voice), passes?}
                      -> the input re-voiced, timing kept (OpenVoice V2 tone colour converter)
  POST /unload
With --token (or RESONANT_WORKER_TOKEN), every request needs `authorization: Bearer <token>`.
Qwen models load from the local Hugging Face cache only; nothing is downloaded at runtime.
"""
import argparse
import base64
import gc
import hashlib
import hmac
import json
import os
import sys
import tempfile
import threading
import time
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.setdefault("HF_HUB_OFFLINE", "1")

import numpy as np  # noqa: E402
import torch  # noqa: E402
from huggingface_hub import snapshot_download  # noqa: E402

# Import the model code here, on the main thread. Importing it later inside a request thread
# crashes on Windows (0xC0000005): worker threads get a small stack and transformers' import
# chain is deep. A worker used only for voice isolation can run without qwen_tts.
try:
    from qwen_tts import Qwen3TTSModel  # noqa: E402
except ImportError:
    Qwen3TTSModel = None
try:
    from faster_whisper import WhisperModel  # noqa: E402
except ImportError:
    WhisperModel = None
import importlib.util  # noqa: E402
import math  # noqa: E402

# Transcription and speaker models live as plain folders (no Hugging Face symlinks needed).
MODELS_DIR = os.environ.get("RESONANT_MODELS_DIR") or os.path.join(os.path.expanduser("~"), ".resonant", "models")
WHISPER_DIR = os.path.join(MODELS_DIR, "whisper-large-v3-turbo")
ECAPA_DIR = os.path.join(MODELS_DIR, "ecapa-voxceleb")
OPENVOICE_DIR = os.path.join(MODELS_DIR, "openvoice-v2", "converter")
# Small models stay loaded alongside the one big model instead of evicting it.
SMALL = {"demucs", "ecapa", "openvoice"}
try:  # OpenVoice V2's tone colour converter (MIT); its TTS half and watermarking aren't used
    from openvoice import utils as ov_utils  # noqa: E402
    from openvoice.models import SynthesizerTrn  # noqa: E402
    from openvoice.mel_processing import spectrogram_torch  # noqa: E402
except ImportError:
    SynthesizerTrn = None
# Model loading inside request threads needs more than the default thread stack too.
threading.stack_size(64 * 1024 * 1024)

SIZE = os.environ.get("QWEN_TTS_SIZE", "0.6B")
REPOS = {
    "custom_voice": f"Qwen/Qwen3-TTS-12Hz-{SIZE}-CustomVoice",
    "base": f"Qwen/Qwen3-TTS-12Hz-{SIZE}-Base",
    # Voice Design is only published at 1.7B, whatever size the other models use.
    "voice_design": "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
}
DEVICE = os.environ.get("QWEN_TTS_DEVICE") or ("cuda:0" if torch.cuda.is_available() else "cpu")
DTYPE = torch.bfloat16 if DEVICE.startswith("cuda") else torch.float32
# Low-RAM machines keep only one model resident and swap on demand; a big GPU can hold all four.
MAX_LOADED = int(os.environ.get("QWEN_TTS_MAX_LOADED", "1"))
torch.set_num_threads(int(os.environ.get("QWEN_TTS_THREADS", str(max(1, (os.cpu_count() or 4) - 2)))))
TOKEN = os.environ.get("RESONANT_WORKER_TOKEN", "")
REF_DIR = os.path.join(tempfile.gettempdir(), "resonant-worker-refs")
os.makedirs(REF_DIR, exist_ok=True)

lock = threading.Lock()  # one generation at a time; the models are not thread-safe
models: "OrderedDict[str, object]" = OrderedDict()
prompt_cache: "OrderedDict[tuple, object]" = OrderedDict()


def log(msg):
    print(f"[qwen] {msg}", file=sys.stderr, flush=True)


def has_demucs():
    try:
        import demucs  # noqa: F401
        return True
    except ImportError:
        return False


def available():
    out = {}
    for kind, repo in REPOS.items():
        try:
            snapshot_download(repo, local_files_only=True)
            out[kind] = Qwen3TTSModel is not None
        except Exception:
            out[kind] = False
    out["isolate"] = has_demucs()
    out["transcribe"] = WhisperModel is not None and os.path.isfile(os.path.join(WHISPER_DIR, "model.bin"))
    out["diarize"] = importlib.util.find_spec("speechbrain") is not None and os.path.isfile(os.path.join(ECAPA_DIR, "embedding_model.ckpt"))
    out["convert"] = SynthesizerTrn is not None and os.path.isfile(os.path.join(OPENVOICE_DIR, "checkpoint.pth"))
    return out


def load(kind):
    t = time.time()
    if kind == "demucs":
        from demucs.pretrained import get_model as get_demucs
        model = get_demucs("htdemucs").to(DEVICE).eval()
    elif kind == "whisper":
        if WhisperModel is None:
            raise RuntimeError("faster-whisper isn't installed in the worker's Python environment")
        cuda = DEVICE.startswith("cuda")
        model = WhisperModel(WHISPER_DIR, device="cuda" if cuda else "cpu", compute_type="float16" if cuda else "int8",
                             cpu_threads=torch.get_num_threads())
    elif kind == "openvoice":
        if SynthesizerTrn is None:
            raise RuntimeError("OpenVoice isn't installed in the worker's Python environment")
        hps = ov_utils.get_hparams_from_file(os.path.join(OPENVOICE_DIR, "config.json"))
        net = SynthesizerTrn(len(getattr(hps, "symbols", [])), hps.data.filter_length // 2 + 1,
                             n_speakers=hps.data.n_speakers, **hps.model).to(DEVICE).eval()
        # weights_only: load tensors only, never pickled code.
        state = torch.load(os.path.join(OPENVOICE_DIR, "checkpoint.pth"), map_location=DEVICE, weights_only=True)
        missing, _ = net.load_state_dict(state["model"], strict=False)
        if missing:
            raise RuntimeError(f"OpenVoice checkpoint is missing {len(missing)} weights")
        model = (net, hps)
    elif kind == "ecapa":
        from speechbrain.inference.speaker import EncoderClassifier
        from speechbrain.utils.fetching import LocalStrategy
        model = EncoderClassifier.from_hparams(source=ECAPA_DIR, savedir=os.path.join(MODELS_DIR, "ecapa"),
                                               run_opts={"device": DEVICE}, local_strategy=LocalStrategy.COPY)
    else:
        if Qwen3TTSModel is None:
            raise RuntimeError("qwen-tts isn't installed in the worker's Python environment")
        # A local path sidesteps a transformers bug that queries the Hub even in offline mode.
        path = snapshot_download(REPOS[kind], local_files_only=True)
        model = Qwen3TTSModel.from_pretrained(path, device_map=DEVICE, dtype=DTYPE)
    log(f"loaded {kind} on {DEVICE} in {time.time() - t:.1f}s")
    return model


def get_model(kind):
    if kind in models:
        models.move_to_end(kind)
        return models[kind]
    while kind not in SMALL and sum(k not in SMALL for k in models) >= MAX_LOADED:
        old = next(k for k in models if k not in SMALL)  # least recently used big model
        del models[old]
        if old == "base":
            prompt_cache.clear()
        gc.collect()
        if DEVICE.startswith("cuda"):
            torch.cuda.empty_cache()
    models[kind] = load(kind)
    return models[kind]


def ref_path(body):
    """The reference clip as a file: sent inline (works across machines) or as a local path."""
    if body.get("ref_audio_b64"):
        data = base64.b64decode(body["ref_audio_b64"])
        path = os.path.join(REF_DIR, hashlib.sha256(data).hexdigest()[:32] + ".wav")
        if not os.path.exists(path):
            with open(path, "wb") as f:
                f.write(data)
        return path
    path = body.get("ref_audio")
    if not path or not os.path.isfile(path):
        raise ValueError("reference audio not found")
    return path


def clone_prompt(model, ref_audio, ref_text):
    key = (ref_audio, os.path.getmtime(ref_audio), ref_text or "")
    if key not in prompt_cache:
        # With a transcript the model conditions on it (better likeness); without, it uses the speaker embedding only.
        prompt_cache[key] = model.create_voice_clone_prompt(
            ref_audio=ref_audio, ref_text=ref_text or None, x_vector_only_mode=not ref_text
        )
        while len(prompt_cache) > 32:
            prompt_cache.popitem(last=False)
    return prompt_cache[key]


def isolate(samples, sr):
    """Separates the voice from music and noise with Demucs (htdemucs) and returns it in mono."""
    from demucs.apply import apply_model
    import julius
    model = get_model("demucs")
    wav = torch.from_numpy(samples.copy()).float()
    if sr != model.samplerate:
        wav = julius.resample_frac(wav, sr, model.samplerate)
    peak = wav.abs().max().clamp(min=1e-4)
    mix = (wav / peak).expand(2, -1).unsqueeze(0).to(DEVICE)
    with torch.inference_mode():
        out = apply_model(model, mix, split=True, overlap=0.1, progress=False, device=DEVICE)
    vocals = out[0, model.sources.index("vocals")].mean(0).cpu() * peak.cpu()
    return vocals.numpy(), model.samplerate


def transcribe(samples, language=None):
    """Whisper large-v3-turbo: words with timestamps, plus the detected language."""
    model = get_model("whisper")
    segments, info = model.transcribe(samples, language=language or None, word_timestamps=True, vad_filter=True, beam_size=5)
    words, pieces = [], []
    for seg in segments:
        for w in seg.words or []:
            pieces.append(w.word)  # keeps Whisper's own spacing, which is right for every language
            text = w.word.strip()
            if text:
                words.append({"text": text, "start": round(w.start, 3), "end": round(w.end, 3),
                              "logprob": round(math.log(max(w.probability, 1e-6)), 3)})
    return words, "".join(pieces).strip(), info.language, info.language_probability


# Two turns whose voices are more alike than this (cosine similarity of ECAPA embeddings) are one speaker.
SAME_SPEAKER = float(os.environ.get("RESONANT_DIARIZE_THRESHOLD", "0.5"))


def diarize(samples, sr, words, num_speakers=None):
    """Labels each word with a speaker: split the speech into turns at pauses, embed each turn's voice
    with ECAPA, then merge turns bottom-up (average linkage) until the voices left are distinct."""
    if not words:
        return []
    turns, cur = [], []
    for i, w in enumerate(words):
        if cur and (w["start"] - words[cur[-1]]["end"] > 0.5 or w["end"] - words[cur[0]]["start"] > 8):
            turns.append(cur)
            cur = []
        cur.append(i)
    turns.append(cur)
    spans = [(words[t[0]]["start"], words[t[-1]]["end"]) for t in turns]
    enc = get_model("ecapa")
    embs = [None] * len(turns)
    for i, (s, e) in enumerate(spans):
        if e - s < 0.4:
            continue
        clip = samples[int(s * sr):int(e * sr)]
        with torch.inference_mode():
            v = enc.encode_batch(torch.from_numpy(np.ascontiguousarray(clip)).float().unsqueeze(0)).reshape(-1).cpu().numpy()
        embs[i] = v / (np.linalg.norm(v) or 1)
    # Cluster the turns long enough to judge (1 s or more); shorter ones join the closest voice later.
    idx = [i for i, v in enumerate(embs) if v is not None and spans[i][1] - spans[i][0] >= 1.0] or \
          [i for i, v in enumerate(embs) if v is not None]
    clusters = [[i] for i in idx]
    sim = lambda a, b: float(np.mean([embs[x] @ embs[y] for x in a for y in b]))  # noqa: E731
    target = max(1, int(num_speakers)) if num_speakers else None
    while len(clusters) > 1:
        best, pair = -2.0, None
        for a in range(len(clusters)):
            for b in range(a + 1, len(clusters)):
                s = sim(clusters[a], clusters[b])
                if s > best:
                    best, pair = s, (a, b)
        if target is not None and len(clusters) <= target:
            break
        if target is None and best < SAME_SPEAKER:
            break
        a, b = pair
        clusters[a] += clusters.pop(b)
    centroids = [np.mean([embs[i] for i in c], axis=0) for c in clusters]
    label = [None] * len(turns)
    for k, c in enumerate(clusters):
        for i in c:
            label[i] = k
    for i in range(len(turns)):
        if label[i] is None:
            if embs[i] is not None and centroids:
                label[i] = int(np.argmax([embs[i] @ c for c in centroids]))
            else:  # too short to hear: same speaker as the turn before (or after)
                label[i] = next((label[j] for j in range(i - 1, -1, -1) if label[j] is not None), None)
    first = next((x for x in label if x is not None), 0)
    label = [first if x is None else x for x in label]
    order = {}
    for x in label:  # number speakers by first appearance
        order.setdefault(x, len(order))
    out = [None] * len(words)
    for t, k in zip(turns, label):
        for i in t:
            out[i] = f"speaker_{order[k]}"
    return out


tone_cache: "OrderedDict[str, object]" = OrderedDict()  # reference clip hash -> tone colour embedding


def convert(samples, sr, ref_wav, passes=2):
    """Speech-to-speech: re-colours `samples` with the voice in `ref_wav` (OpenVoice V2). Words, timing,
    pauses and emotion come from the input; only the voice's tone colour changes. A second pass moves
    the result measurably closer to the target (ECAPA likeness 0.29 -> 0.34 in tests); more add little."""
    import librosa
    net, hps = get_model("openvoice")
    rate = hps.data.sampling_rate

    def spec(a):
        y = torch.from_numpy(np.ascontiguousarray(a)).float().unsqueeze(0).to(DEVICE)
        return spectrogram_torch(y, hps.data.filter_length, rate, hps.data.hop_length, hps.data.win_length, center=False)

    def tone(a):
        with torch.inference_mode():
            return net.ref_enc(spec(a).transpose(1, 2)).unsqueeze(-1)

    key = hashlib.sha256(ref_wav).hexdigest()
    if key not in tone_cache:
        import io
        import soundfile as sf
        ref, ref_sr = sf.read(io.BytesIO(ref_wav), dtype="float32")
        if ref.ndim > 1:
            ref = ref.mean(1)
        tone_cache[key] = tone(librosa.resample(ref, orig_sr=ref_sr, target_sr=rate) if ref_sr != rate else ref)
        while len(tone_cache) > 64:
            tone_cache.popitem(last=False)
    target = tone_cache[key]
    out = librosa.resample(samples, orig_sr=sr, target_sr=rate) if sr != rate else samples
    peak = float(np.abs(out).max() or 1.0)
    for _ in range(max(1, min(int(passes), 3))):
        with torch.inference_mode():
            sp = spec(out)
            out = net.voice_conversion(sp, torch.LongTensor([sp.size(-1)]).to(DEVICE), sid_src=tone(out), sid_tgt=target, tau=0.3)[0][0, 0].float().cpu().numpy()
    # Match the input's loudness so a quiet recording stays usable and a loud one doesn't clip.
    return out * min(peak / float(np.abs(out).max() or 1.0), 4.0), rate


def lang(value):
    return (value or "auto").strip().lower() or "auto"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_audio(self, wav, sr):
        data = np.asarray(wav, dtype="<f4").tobytes()
        self.send_response(200)
        self.send_header("content-type", "application/octet-stream")
        self.send_header("x-sample-rate", str(sr))
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        if not TOKEN:
            return True
        given = self.headers.get("authorization", "")
        return hmac.compare_digest(given.encode(), f"Bearer {TOKEN}".encode())

    def do_GET(self):
        if not self.authorized():
            return self.send_json(401, {"error": "invalid worker token"})
        if self.path == "/health":
            gpu = torch.cuda.get_device_name(0) if DEVICE.startswith("cuda") else None
            return self.send_json(200, {"status": "ok", "size": SIZE, "device": DEVICE, "gpu": gpu,
                                        "loaded": list(models), "available": available()})
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        try:
            if not self.authorized():
                return self.send_json(401, {"error": "invalid worker token"})
            length = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(length)
            t = time.time()
            if self.path == "/isolate":
                if not has_demucs():
                    return self.send_json(503, {"error": "Demucs isn't installed in the worker's Python environment"})
                rate = int(self.headers.get("x-sample-rate") or 44100)
                samples = np.frombuffer(raw, dtype="<f4")
                if not samples.size:
                    return self.send_json(422, {"error": "no audio"})
                with lock:
                    wav, sr = isolate(samples, rate)
                log(f"/isolate {samples.size / rate:.1f}s audio in {time.time() - t:.1f}s")
                return self.send_audio(wav, sr)
            if self.path == "/convert":
                # Same packed body as /transcribe: options {ref_audio_b64, passes?}, then float32 samples.
                rate = int(self.headers.get("x-sample-rate") or 22050)
                n = int.from_bytes(raw[:4], "little")
                opts = json.loads(raw[4:4 + n] or b"{}")
                samples = np.frombuffer(raw[4 + n:], dtype="<f4")
                if not available()["convert"]:
                    return self.send_json(503, {"error": "OpenVoice isn't installed on the worker"})
                if not samples.size or not opts.get("ref_audio_b64"):
                    return self.send_json(422, {"error": "audio and a reference clip are required"})
                with lock:
                    wav, sr = convert(samples, rate, base64.b64decode(opts["ref_audio_b64"]), opts.get("passes", 2))
                log(f"/convert {samples.size / rate:.1f}s audio in {time.time() - t:.1f}s")
                return self.send_audio(wav, sr)
            if self.path in ("/transcribe", "/diarize"):
                # Body: uint32 LE length of the options JSON, the JSON, then float32 mono samples.
                rate = int(self.headers.get("x-sample-rate") or 16000)
                n = int.from_bytes(raw[:4], "little")
                opts = json.loads(raw[4:4 + n] or b"{}")
                samples = np.frombuffer(raw[4 + n:], dtype="<f4")
                if rate != 16000:
                    return self.send_json(422, {"error": "send 16 kHz audio"})
                caps = available()
                with lock:
                    if self.path == "/transcribe":
                        if not caps["transcribe"]:
                            return self.send_json(503, {"error": "Whisper large-v3-turbo isn't installed on the worker"})
                        words, text, language, prob = transcribe(samples, opts.get("language"))
                    else:
                        words, text, language, prob = opts.get("words") or [], None, None, None
                    speakers = None
                    if (opts.get("diarize") or self.path == "/diarize") and words:
                        if not caps["diarize"]:
                            return self.send_json(503, {"error": "Speaker detection isn't installed on the worker"})
                        speakers = diarize(samples, rate, words, opts.get("num_speakers"))
                log(f"{self.path} {samples.size / rate:.1f}s audio in {time.time() - t:.1f}s"
                    f"{f', {len(set(speakers))} speaker(s)' if speakers else ''}")
                return self.send_json(200, {"text": text, "words": words, "speakers": speakers, "language": language, "language_probability": prob})
            body = json.loads(raw or b"{}")
            if self.path == "/unload":
                with lock:
                    models.clear()
                    prompt_cache.clear()
                    gc.collect()
                return self.send_json(200, {"status": "ok"})
            text = str(body.get("text") or "").strip()
            if not text:
                return self.send_json(422, {"error": "text is required"})
            with lock:
                if self.path == "/custom_voice":
                    model = get_model("custom_voice")
                    wavs, sr = model.generate_custom_voice(
                        text=text, speaker=body["speaker"], language=lang(body.get("language")),
                        instruct=body.get("instruct") or None,
                    )
                elif self.path == "/design":
                    if not str(body.get("instruct") or "").strip():
                        return self.send_json(422, {"error": "a voice description is required"})
                    model = get_model("voice_design")
                    wavs, sr = model.generate_voice_design(
                        text=text, instruct=body["instruct"], language=lang(body.get("language")),
                    )
                elif self.path == "/clone":
                    ref = ref_path(body)
                    model = get_model("base")
                    wavs, sr = model.generate_voice_clone(
                        text=text, language=lang(body.get("language")),
                        voice_clone_prompt=clone_prompt(model, ref, body.get("ref_text")),
                    )
                else:
                    return self.send_json(404, {"error": "not found"})
            log(f"{self.path} {len(wavs[0]) / sr:.1f}s audio in {time.time() - t:.1f}s")
            self.send_audio(wavs[0], sr)
        except (KeyError, ValueError) as e:
            self.send_json(400, {"error": str(e)})
        except Exception as e:  # surface model errors to the caller instead of dropping the socket
            log(f"error: {e!r}")
            self.send_json(500, {"error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Resonant worker (Qwen3-TTS + Demucs)")
    ap.add_argument("port", nargs="?", type=int, default=None, help="port (0 picks a free one)")
    ap.add_argument("--port", dest="port_opt", type=int, default=None)
    ap.add_argument("--host", default="127.0.0.1", help="0.0.0.0 to accept connections from other machines")
    ap.add_argument("--token", default=None, help="require this bearer token (strongly advised with --host 0.0.0.0)")
    ap.add_argument("--size", default=None, choices=["0.6B", "1.7B"], help="Qwen3-TTS size for speech and cloning")
    args = ap.parse_args()
    if args.token:
        TOKEN = args.token
    if args.size:
        SIZE = args.size
        REPOS["custom_voice"] = f"Qwen/Qwen3-TTS-12Hz-{SIZE}-CustomVoice"
        REPOS["base"] = f"Qwen/Qwen3-TTS-12Hz-{SIZE}-Base"
    if args.host not in ("127.0.0.1", "localhost") and not TOKEN:
        log("warning: listening on the network without --token; anyone who can reach this port can use it")
    port = args.port_opt if args.port_opt is not None else (args.port if args.port is not None else 0)
    server = ThreadingHTTPServer((args.host, port), Handler)
    log(f"device {DEVICE}, size {SIZE}, models in memory at once: {MAX_LOADED}")
    print(f"READY {server.server_address[1]}", flush=True)
    server.serve_forever()
