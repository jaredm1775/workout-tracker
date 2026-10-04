import struct
import zlib
from pathlib import Path


def chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def write_png(path: Path, size: int, rgb: tuple[int, int, int]) -> None:
    raw = b"".join(b"\x00" + (bytes(rgb) * size) for _ in range(size))
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    path.write_bytes(png)


def main() -> None:
    public = Path(__file__).resolve().parents[1] / "public"
    public.mkdir(exist_ok=True)
    write_png(public / "icon-192.png", 192, (11, 15, 20))
    write_png(public / "icon-512.png", 512, (11, 15, 20))


if __name__ == "__main__":
    main()
