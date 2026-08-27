FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY trans/ trans/
COPY server/ server/
COPY web/ web/

# Nessun motivo per girare da root: il chart si aspetta questo uid.
USER 10001

EXPOSE 8000
ENV TRANS_HOST=0.0.0.0 TRANS_PORT=8000
CMD ["python", "-m", "server.main"]
