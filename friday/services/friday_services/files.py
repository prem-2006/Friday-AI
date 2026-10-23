"""Finding and opening the owner's files, for Friday's quick actions.

Only the owner's own folders are searched (Desktop, Documents, Downloads,
Pictures, Music, Videos, and their OneDrive copies), by file name, and only
documents and media are opened: never programs or scripts.
"""

from __future__ import annotations

import os
import time
from collections.abc import Callable, Iterable
from pathlib import Path

FOLDERS = ("Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos")
SKIP_DIRS = {"node_modules", ".git", "__pycache__", ".venv", "AppData", "$RECYCLE.BIN"}
# Opening these would run something rather than show it.
NEVER_OPEN = {
    ".exe", ".msi", ".bat", ".cmd", ".com", ".ps1", ".vbs", ".vbe", ".js", ".jse",
    ".wsf", ".wsh", ".scr", ".lnk", ".url", ".reg", ".hta", ".cpl", ".jar", ".py",
}
MAX_SCANNED = 40_000
MAX_DEPTH = 6


class FilesError(RuntimeError):
    pass


def owner_folders(home: Path | None = None) -> list[Path]:
    home = home or Path.home()
    roots = [home / name for name in FOLDERS]
    roots += [home / "OneDrive" / name for name in FOLDERS]
    return [root for root in roots if root.is_dir()]


def find_files(query: str, roots: Iterable[Path], limit: int = 8) -> list[dict]:
    """Files whose names contain every word of the query, newest first."""
    words = [word for word in query.casefold().split() if word]
    if not words:
        raise FilesError("Say part of the file's name.")
    found: list[tuple[float, Path]] = []
    scanned = 0
    for root in roots:
        base_depth = len(root.parts)
        for folder, dirs, names in os.walk(root):
            dirs[:] = [
                d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")
            ][: 200]
            if len(Path(folder).parts) - base_depth >= MAX_DEPTH:
                dirs[:] = []
            for name in names:
                scanned += 1
                if all(word in name.casefold() for word in words):
                    path = Path(folder) / name
                    try:
                        found.append((path.stat().st_mtime, path))
                    except OSError:
                        pass
            if scanned > MAX_SCANNED:
                break
    found.sort(reverse=True)
    return [
        {
            "name": path.name,
            "path": str(path),
            "folder": path.parent.name,
            "modified": time.strftime("%d %b %Y", time.localtime(mtime)),
        }
        for mtime, path in found[:limit]
    ]


def open_file(
    path: str,
    roots: Iterable[Path],
    start: Callable[[str], None] | None = None,
) -> dict:
    """Opens a document or media file from the owner's folders in its usual app."""
    target = Path(path).resolve()
    if not any(target.is_relative_to(root.resolve()) for root in roots):
        raise FilesError("Friday only opens files from your own folders.")
    if not target.is_file():
        raise FilesError("That file is not there any more.")
    if target.suffix.lower() in NEVER_OPEN:
        raise FilesError("That file is a program or a script; open it yourself if you trust it.")
    (start or os.startfile)(str(target))
    return {"opened": target.name}
