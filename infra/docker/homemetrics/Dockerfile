FROM python:3.11-alpine

WORKDIR /

COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt

COPY logging.yaml ./
COPY src/ ./src/

CMD ["python3", "/src/main.py", "--config", "/config/config.yaml"]
