# Stock Analyst Recommendations Dashboard

A small web app that aggregates analyst recommendations (the same firm-level
ratings published by Morningstar, Bank of America, Citi, Morgan Stanley, etc.)
and shows daily winners/losers with derived **Strong Buy / Buy / Hold / Sell**
signals.

> **Note on scraping:** Morningstar, Fidelity, BofA, and Citibank sit behind
> logins/paywalls and their Terms of Service prohibit scraping. This app instead
> uses the Yahoo Finance data feed (via `yfinance`), which legally aggregates
> analyst ratings and the actual upgrade/downgrade actions issued by those firms.

## Run it

```bash
cd /Users/rv/temp/stocks
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Then open http://127.0.0.1:5000 in your browser.

## Using it

- Click **Check now** to fetch the latest data.
- Leave the box empty to use the default watchlist, or type your own tickers
  (e.g. `AAPL, MSFT, NVDA`).
- Filter the table by recommendation; view top winners/losers and consensus
  breakdown.

## Deploy on TrueNAS (Docker)

The repo ships with a `Dockerfile`, `.dockerignore`, and `docker-compose.yml`.
The image runs the app under Gunicorn (a production WSGI server) instead of the
Flask dev server.

### Recommended — Custom App (TrueNAS SCALE 24.10 "Electric Eel" or newer)

Electric Eel runs Docker natively and accepts a compose file directly.

1. **Copy the project to a dataset**, e.g. `/mnt/<pool>/apps/stocks`
   (via SMB, `scp`, or `git clone`).
2. **SSH into TrueNAS** and build the image (TrueNAS is x86, so build it there):

   ```bash
   cd /mnt/<pool>/apps/stocks
   docker build -t stocks-dashboard:latest .
   ```

3. **Create the app in the UI:** Apps → **Discover Apps** → **Custom App** →
   **Install via YAML**, then paste the contents of `docker-compose.yml`.
   Change the host port `8501` if it is already in use.
4. Open `http://<truenas-ip>:8501`.

> Alternative (pure SSH, no UI): from the project directory run
> `docker compose up -d --build`. Simpler, but the app won't show up in the
> TrueNAS Apps manager.

### Older TrueNAS SCALE (k3s, pre-24.10)

The UI expects a registry image, not a local build. Either:

- Push the image to a registry (Docker Hub / GHCR), then use **Custom App** →
  **Launch Docker Image** with that image, container port `5000`, a host port
  like `8501`, and a host-path/ix-volume mount at `/app/.cache`; or
- Upgrade to Electric Eel and use the compose path above.

### Notes

- **Port:** host `8501` is arbitrary — pick any free port. The container always
  listens on `5000`.
- **Persistence:** the named volume `stocks_cache` keeps the per-ticker cache
  across restarts, which also reduces Yahoo rate-limiting after updates.
- **Architecture:** build on the TrueNAS box (x86_64). Don't copy an image built
  on an Apple-Silicon Mac — it would be arm64 and won't run.
- **HTTPS (optional):** put it behind your existing reverse proxy
  (Traefik / Nginx Proxy Manager) pointing at `<truenas-ip>:8501`.

For informational purposes only — not financial advice.
