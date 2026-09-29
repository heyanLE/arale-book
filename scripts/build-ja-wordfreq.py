#!/usr/bin/env python3
"""Build the Japanese Zipf reference used by direct vocabulary filters.

Build time only: run with wordfreq==3.1.1. The app reads the resulting gzip
with Node.js and does not need the user's Python environment.
"""

import gzip
import importlib.metadata
import json
import math
from pathlib import Path

from wordfreq import get_frequency_dict


VERSION = "3.1.1"
TARGET = Path(__file__).resolve().parents[1] / "data" / f"ja-wordfreq-{VERSION}.json.gz"


def main() -> None:
    actual = importlib.metadata.version("wordfreq")
    if actual != VERSION:
        raise SystemExit(f"wordfreq=={VERSION} required, got {actual}")
    frequencies = get_frequency_dict("ja", wordlist="large")
    entries = {
        word: round(math.log10(value) + 9, 2)
        for word, value in frequencies.items()
        if value > 0
    }
    payload = {
        "source": "wordfreq",
        "version": VERSION,
        "language": "ja",
        "wordlist": "large",
        "scale": "zipf",
        "entries": entries,
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    with TARGET.open("wb") as output, gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0, compresslevel=9) as compressed:
        compressed.write(raw)
    print(f"{TARGET}: {len(entries)} terms, {TARGET.stat().st_size} bytes")


if __name__ == "__main__":
    main()
