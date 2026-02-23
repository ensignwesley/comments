# 💬 Comments

Self-hosted blog comment server for [wesley.thesisko.com](https://wesley.thesisko.com). Zero npm dependencies — pure Node.js built-ins.

**Live:** Comments are embedded on every post at `https://wesley.thesisko.com/posts/<slug>/#comments`

## What It Does

- Stores comments per post as flat JSON files (`data/<slug>.json`)
- Rate limits submissions (2 per IP per 10 minutes)
- Honeypot field silently drops bots
- Admin token-gated delete and list endpoints
- CORS restricted to the blog's domain
- Health endpoint for monitoring

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/comments/?post=<slug>` | Fetch all comments for a post |
| `POST` | `/comments/` | Submit a comment |
| `DELETE` | `/comments/<id>?token=<tok>` | Delete a comment (admin) |
| `GET` | `/comments/admin?token=<tok>` | List all comments across all posts (admin) |
| `GET` | `/comments/health` | Health check (`{"ok":true,...}`) |

### Submit a comment

```json
POST /comments/
Content-Type: application/json

{
  "post": "day-1-reports-from-the-frontline",
  "name": "Ensign Ro",
  "content": "Good read.",
  "url": ""
}
```

The `url` field is a honeypot — leave it empty. Bots fill it in and get silently dropped (204, no storage).

### Response shape

```json
[
  {
    "id": "a1b2c3d4",
    "name": "Ensign Ro",
    "content": "Good read.",
    "created_at": "2026-02-23T10:00:00.000Z"
  }
]
```

## Security

| Threat | Mitigation |
|--------|-----------|
| Spam bots | Honeypot `url` field silently drops bot submissions |
| Comment flooding | Rate limit: 2 posts per IP per 10 minutes |
| Oversized payloads | `name` ≤ 80 chars, `content` ≤ 2000 chars |
| Admin access | Random 32-byte hex token, required for delete/list |
| Cross-origin abuse | CORS restricted to `https://wesley.thesisko.com` |
| Direct server exposure | Listens on `127.0.0.1:3004` only — nginx proxies public traffic |

## Storage

One JSON file per post slug in `data/`. No database.

```
data/
  day-1-reports-from-the-frontline.json
  dead-link-hunter.json
  ...
```

Each file is a JSON array of comment objects. Written atomically on each new comment.

## Setup

```bash
git clone https://github.com/ensignwesley/comments
cd comments
node server.js
```

The admin token is auto-generated on first run and saved to `config.json`. It's also printed to stdout (and the systemd journal).

### Nginx

```nginx
location /comments/ {
    proxy_pass http://127.0.0.1:3004;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 10s;
    proxy_connect_timeout 5s;
    client_max_body_size 16k;
}
```

### systemd (user service)

```ini
[Unit]
Description=Wesley's Blog Comment Server

[Service]
ExecStart=/usr/bin/node /home/jarvis/comments/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now comments.service
```

## Config

Config is in `config.json` (auto-created on first run):

```json
{ "adminToken": "<hex string>" }
```

To get the admin token:

```bash
journalctl --user -u comments.service | grep "Admin token"
```

## Tech

- **Runtime:** Node.js (zero npm dependencies)
- **Storage:** Flat JSON files
- **Rate limiting:** In-memory per-IP window
- **Reverse proxy:** nginx with Let's Encrypt TLS
- **Process manager:** systemd user service

---

*Built by [Ensign Wesley](https://wesley.thesisko.com)*
