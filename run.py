#!/usr/bin/env python3
"""Bootstrap and run the Pepper controller bridge.

Creates (or reuses) a local virtual environment, installs dependencies
from requirements.txt -- including the qi/NAOqi SDK on platforms that
have a prebuilt wheel for it -- then launches bridge.py. Safe to re-run;
skips steps that are already done.

Usage:
    python3 run.py [--http-port 9000]
"""
import platform
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VENV_DIR = ROOT / ".venv"
PYTHON_VERSIONS = ["3.12", "3.11", "3.10", "3.9", "3.8", "3.7"]


def venv_python() -> Path:
    if platform.system() == "Windows":
        return VENV_DIR / "Scripts" / "python.exe"
    return VENV_DIR / "bin" / "python"


def candidate_commands():
    """Yield argv prefixes for Python interpreters worth trying, best first."""
    if platform.system() == "Windows" and shutil.which("py"):
        for v in PYTHON_VERSIONS:
            yield ["py", f"-{v}"]
    for v in PYTHON_VERSIONS:
        path = shutil.which(f"python{v}")
        if path:
            yield [path]
    yield [sys.executable]


def find_working_python():
    for cmd in candidate_commands():
        try:
            result = subprocess.run([*cmd, "-c", "import sys"], capture_output=True)
            if result.returncode == 0:
                return cmd
        except FileNotFoundError:
            continue
    return [sys.executable]


def create_venv():
    if venv_python().exists():
        print(f"Using existing virtual environment at {VENV_DIR}")
        return
    cmd = find_working_python()
    print(f"Creating virtual environment at {VENV_DIR} using: {' '.join(cmd)}")
    subprocess.run([*cmd, "-m", "venv", str(VENV_DIR)], check=True)


def install_requirements():
    py = str(venv_python())
    print("Installing dependencies ...")
    subprocess.run([py, "-m", "pip", "install", "--quiet", "--upgrade", "pip"], check=True)
    # Don't hard-fail here: qi may have no wheel for this platform/Python
    # combo, and check_qi() below reports that with actionable guidance.
    subprocess.run([py, "-m", "pip", "install", "--quiet", "-r", str(ROOT / "requirements.txt")])


def check_qi() -> bool:
    py = str(venv_python())
    result = subprocess.run([py, "-c", "import qi"], capture_output=True)
    if result.returncode == 0:
        print("qi (NAOqi SDK) is installed and importable.")
        return True

    system = platform.system()
    machine = platform.machine()
    print("\n" + "=" * 64)
    print("WARNING: could not import 'qi' (the NAOqi SDK) in the venv.")
    if system == "Windows":
        print(
            "No prebuilt qi wheel has been published for Windows since qi\n"
            "2.0.1. Recommended: run this bridge from WSL2 (Ubuntu) or a\n"
            "Linux machine, where prebuilt wheels exist for Python 3.7-3.12.\n"
            "(The controller.html web UI itself works fine from Windows --\n"
            "only bridge.py needs a Linux/Mac Python.)"
        )
    elif system == "Darwin" and machine != "arm64":
        print(
            "No prebuilt qi wheel is published for Intel Macs on this\n"
            "version. Run bridge.py on Apple Silicon, Linux, or inside a\n"
            "Linux VM/container instead."
        )
    elif system == "Darwin":
        print(
            "qi 3.1.5's macOS wheel targets Python 3.12 specifically on\n"
            "Apple Silicon. Install Python 3.12 (e.g. `brew install\n"
            "python@3.12`), delete the .venv folder, and re-run this script."
        )
    else:
        print(
            "Try a Python 3.7-3.12 interpreter for the venv (qi 3.1.5\n"
            "wheels are published for cp37-cp312). Delete the .venv folder\n"
            "and re-run this script after installing a supported version."
        )
    print("=" * 64 + "\n")
    return False


def try_uv() -> bool:
    """Prefer uv if it's installed: it manages the Python version, an
    isolated env, and dependencies (per bridge.py's inline metadata) in
    one step -- no venv/pip juggling needed."""
    uv = shutil.which("uv")
    if not uv:
        return False
    print("Found uv -- delegating to `uv run bridge.py` (manages Python 3.12 + deps automatically).\n")
    result = subprocess.run([uv, "run", str(ROOT / "bridge.py"), *sys.argv[1:]])
    sys.exit(result.returncode)


def main():
    try_uv()  # exits the process if uv is available

    create_venv()
    install_requirements()
    qi_ok = check_qi()

    if not qi_ok:
        print("Setup finished with warnings above -- bridge.py will fail until qi is installed.")
        sys.exit(1)

    print("\nStarting bridge.py ...\n")
    py = str(venv_python())
    result = subprocess.run([py, str(ROOT / "bridge.py"), *sys.argv[1:]])
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
