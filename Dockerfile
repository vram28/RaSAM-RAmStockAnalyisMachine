# Production image for the Stock Analyst Recommendations dashboard.
FROM python:3.12-slim

# Avoid .pyc files and force unbuffered logging.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# ca-certificates is needed for outbound HTTPS to the data feed.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies first to leverage layer caching.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application code.
COPY app.py .
COPY templates/ templates/
COPY static/ static/

# Per-ticker disk cache lives here; declare it so it can be mounted as a volume.
RUN mkdir -p /app/.cache
VOLUME ["/app/.cache"]

EXPOSE 5000

# Run with Gunicorn (threaded workers suit the app's I/O-bound fetching).
CMD ["gunicorn", "--bind", "0.0.0.0:5000", \
     "--workers", "2", "--threads", "8", \
     "--timeout", "120", "app:app"]
