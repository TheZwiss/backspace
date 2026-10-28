FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 libgomp1 && apt-get clean
COPY requirements.txt download_models.py ./
RUN pip install --no-cache-dir -r requirements.txt && python download_models.py
COPY server.py ./
ENV TTS_HOST=0.0.0.0 TTS_PORT=5052 TTS_THREADS=2
USER 10001:10001
EXPOSE 5052
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5052/health')"
CMD ["python", "-u", "server.py"]
