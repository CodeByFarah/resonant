"""Downloads one model from Hugging Face for Settings → Models (server/packs.mjs).

Usage: python fetch_model.py '{"repo": "org/name", "local_dir": "...", "allow": ["sub/*"]}'
Without local_dir the model goes into the Hugging Face cache (HF_HOME), where the worker looks for
Qwen3-TTS. The server measures progress from the folder's size, so this prints nothing until done.
"""
import json
import os
import sys

os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
# Plain HTTPS downloads: the Xet client isn't part of the engine, and without this Hugging Face
# prints a warning about it on every download.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

from huggingface_hub import snapshot_download  # noqa: E402

spec = json.loads(sys.argv[1])
kwargs = {"repo_id": spec["repo"]}
if spec.get("local_dir"):
    kwargs["local_dir"] = spec["local_dir"]
if spec.get("allow"):
    kwargs["allow_patterns"] = spec["allow"]
path = snapshot_download(**kwargs)
print(json.dumps({"done": True, "path": path}), flush=True)
