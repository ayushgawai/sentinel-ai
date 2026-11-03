# Sentinel AI
.PHONY: run api check help

help:
	@echo "make run     # API on :8180 + console on :8190 (macOS)"
	@echo "make api     # API only on :8180"
	@echo "make check   # self-checks (no paid calls)"

run:
	./scripts/run_mac.sh

api:
	PYTHONPATH=. .venv/bin/python -m services.api --host 127.0.0.1 --port 8180

check:
	PYTHONPATH=. .venv/bin/python services/brain/check.py
	PYTHONPATH=. .venv/bin/python services/api/check.py
	PYTHONPATH=. .venv/bin/python services/voice/check.py
	PYTHONPATH=. .venv/bin/python services/vision/osnet.py
