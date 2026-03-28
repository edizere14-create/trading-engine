import subprocess, sys
result = subprocess.run(
    [sys.executable, "-m", "pip", "install", "redis", "fastapi", "uvicorn", "pydantic"],
    capture_output=True, text=True
)
print("STDOUT:", result.stdout[-500:] if len(result.stdout) > 500 else result.stdout)
print("STDERR:", result.stderr[-500:] if len(result.stderr) > 500 else result.stderr)
print("RC:", result.returncode)
