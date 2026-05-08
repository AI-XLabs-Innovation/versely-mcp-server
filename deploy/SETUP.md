# Deploying versely-mcp to a DigitalOcean droplet

End-to-end walkthrough for hosting `versely-mcp` behind nginx + Let's Encrypt with PM2 process supervision. Targets Ubuntu 22.04 / 24.04.

The server uses **per-request authentication**: each MCP request must include `Authorization: Bearer vsk_...` from the calling user. The droplet itself never holds a Versely API key.

## Prerequisites

- A DigitalOcean droplet (1 vCPU / 1 GB RAM is sufficient)
- A domain or subdomain with an A record pointing at the droplet's public IP
- A non-root sudo user on the droplet
- SSH access

## 1. System dependencies

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx ufw certbot python3-certbot-nginx git curl
```

## 2. Install Node.js 20 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version    # should print v20.x
```

## 3. Install PM2 globally

```bash
sudo npm install -g pm2
```

## 4. Clone & build

```bash
mkdir -p ~/apps && cd ~/apps
git clone https://github.com/AI-XLabs-Innovation/versely-mcp.git
cd versely-mcp
npm ci
npm run build
```

## 5. Start under PM2

```bash
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup
# ^ prints a `sudo env PATH=... pm2 startup ...` command — copy and run it
#   so PM2 resurrects on droplet reboot.
```

Verify locally on the droplet:

```bash
curl -s http://127.0.0.1:8080/healthz
# {"status":"ok","server":"versely-mcp","version":"0.1.0","uptime_s":...,"tools":51}
```

## 6. nginx vhost

Replace the placeholder hostname in the template:

```bash
sed -i 's/versely-mcp\.YOURDOMAIN\.com/versely-mcp.example.com/g' deploy/nginx.conf
# ^ change `versely-mcp.example.com` to your real hostname
```

Install the vhost:

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/versely-mcp
sudo ln -sf /etc/nginx/sites-available/versely-mcp /etc/nginx/sites-enabled/versely-mcp
sudo nginx -t
sudo systemctl reload nginx
```

Confirm public reachability over HTTP (TLS comes next):

```bash
curl -s http://versely-mcp.example.com/healthz
```

## 7. Issue TLS via Let's Encrypt

```bash
sudo certbot --nginx -d versely-mcp.example.com
```

Certbot edits the vhost in place to add a `listen 443 ssl http2` block, sets up auto-redirect from HTTP, and installs a systemd timer for renewal.

After certbot finishes, **uncomment the commented-out `server { listen 443 ssl ... }` block** in [`deploy/nginx.conf`](nginx.conf) (and re-copy to `/etc/nginx/sites-available/`) — that block has the production-tuned proxy settings (long timeouts for `mode: "wait"`, `proxy_buffering off` for SSE responses) which certbot's defaults don't include.

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/versely-mcp
sudo nginx -t && sudo systemctl reload nginx
```

Verify the renewal timer:

```bash
sudo systemctl list-timers | grep certbot
sudo certbot renew --dry-run
```

## 8. Firewall

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

The Node process binds to `127.0.0.1:8080` so 8080 is unreachable from the internet regardless — the firewall is defense in depth.

## 9. End-to-end test

```bash
# Health (no auth)
curl -s https://versely-mcp.example.com/healthz

# Auth gate — expect 401 with {"error":"missing_authorization"}
curl -i -X POST https://versely-mcp.example.com/mcp

# Real tools/list (use a valid vsk_ key)
curl -s -X POST https://versely-mcp.example.com/mcp \
  -H "Authorization: Bearer vsk_YOUR_REAL_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## 10. Configure your MCP client

Claude Desktop / Cursor / Claude Code — `mcp.json` (or platform equivalent):

```json
{
  "mcpServers": {
    "versely": {
      "url": "https://versely-mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer vsk_YOUR_REAL_KEY"
      }
    }
  }
}
```

(Some clients still use `command`/`args` for local servers and reject `url`. Check your client's docs at config time — Claude Desktop ≥ Dec 2024 supports remote URLs natively.)

---

## Subsequent deploys

```bash
ssh user@droplet
cd ~/apps/versely-mcp
./deploy/deploy.sh
```

The script does `git pull && npm ci && npm run build && pm2 reload`. PM2 reload is zero-downtime: it spawns the new process, drains the old, and switches traffic.

## Operations

| Task | Command |
|---|---|
| Tail combined logs | `pm2 logs versely-mcp` |
| Tail JSON event log | `tail -f ~/.pm2/logs/versely-mcp-error.log` |
| Process status | `pm2 status` |
| Restart (with downtime) | `pm2 restart versely-mcp` |
| Reload (zero-downtime) | `pm2 reload deploy/ecosystem.config.cjs --update-env` |
| Stop | `pm2 stop versely-mcp` |
| Update env vars | edit `deploy/ecosystem.config.cjs` → `pm2 reload ... --update-env` |
| TLS renewal (manual test) | `sudo certbot renew --dry-run` |
| nginx config test | `sudo nginx -t` |
| nginx reload | `sudo systemctl reload nginx` |

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `502 Bad Gateway` from nginx | PM2 isn't running. `pm2 status` and `pm2 logs versely-mcp`. |
| `http_listening` never appears in logs | Port 8080 already bound. `sudo ss -tlnp \| grep 8080`. |
| `certbot --nginx` fails on http-01 | DNS A record not propagated, or port 80 firewalled. `dig +short versely-mcp.example.com`. |
| Long requests time out | Increase `proxy_read_timeout` in nginx; bump `VERSELY_DEFAULT_POLL_TIMEOUT_MS` in `ecosystem.config.cjs`. |
| PM2 doesn't restart on reboot | Re-run `pm2 startup` and the `sudo` command it prints, then `pm2 save`. |
| Client gets `401 invalid_api_key_format` | `Authorization` header not in `Bearer vsk_...` shape. |
| Tools fail with `401` from Versely backend (not the MCP gate) | The `vsk_` key is invalid / revoked. Check on Versely side. |
