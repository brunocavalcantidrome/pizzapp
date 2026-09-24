# SSH / EC2 / MariaDB Connection Guide

This document describes everything needed to connect to the production EC2 instance that hosts the Pizzapp Node.js server and its local MariaDB database, and how to deploy code changes to it. It is written for an LLM/agent picking up this project in a future session with no prior context.

## 1. Server identity

- **Public IP:** `54.90.105.131` (anterior: `54.160.160.180` — mudou no resize para 2GB em 2026-09-21; sem Elastic IP, stop/start troca o IP)
- **Public DNS:** `ec2-54-90-105-131.compute-1.amazonaws.com`
- **Region:** `us-east-1` (N. Virginia)
- **OS:** Amazon Linux (SSH user: `ec2-user`)
- **App port:** `3000` (HTTP, not HTTPS — there is no reverse proxy/TLS in front of it yet)
- **Node version on the server:** v24.21.0 (installed via nvm, under the `root` user only — see section 4)

## 2. SSH key

The instance's original key pair `.pem` file lives on the local dev Mac at:

```
/Users/brunocavalcanti/Desktop/Pizzapp/pizzapp.pem
```

Before first use in a session, ensure correct permissions:

```bash
chmod 400 "/Users/brunocavalcanti/Desktop/Pizzapp/pizzapp.pem"
```

Connect with:

```bash
ssh -i "/Users/brunocavalcanti/Desktop/Pizzapp/pizzapp.pem" -o BatchMode=yes ec2-user@54.90.105.131
```

`-o BatchMode=yes` makes it fail fast instead of hanging if the key doesn't work (useful for non-interactive/scripted sessions).

### Fallback key (secondary, also authorized)

An additional passphrase-less key was generated and added to `~/.ssh/authorized_keys` on the server as a backup access path:

- Private key: `~/.ssh/pizzapp-ec2` (on the local Mac)
- Public key: `~/.ssh/pizzapp-ec2.pub`

Both keys currently work. Prefer `pizzapp.pem` since it's the instance's original/primary key.

### If neither key works

Use **AWS EC2 Instance Connect** from the AWS Console (EC2 → select the instance → "Connect" → "EC2 Instance Connect" tab). This opens a browser-based terminal using short-lived AWS-issued credentials, no local key needed. From there you can add a new public key to `~/.ssh/authorized_keys` to restore SSH access from outside.

Common gotcha: Instance Connect can fail with "Error establishing SSH connection" if the Security Group's inbound rule for port 22 is scoped to a specific IP instead of allowing AWS's Instance Connect IP range (or `0.0.0.0/0`). Direct `ssh` from a normal client can still work in that case if the SG happens to allow the client's IP.

## 3. Copying files to/from the server (scp)

```bash
scp -i "/Users/brunocavalcanti/Desktop/Pizzapp/pizzapp.pem" -o BatchMode=yes \
  /local/path/to/file ec2-user@54.90.105.131:/tmp/
```

Files are typically staged in `/tmp/` first (writable by `ec2-user`), then moved into place with `sudo` because the app directory is owned by `root` (see section 4).

## 4. Server directory layout and permissions

- Git repo root on the server: `/home/ec2-user` (has a `.git` directory directly in the home folder — mirrors the structure of the local repo, where the Git root is one level above the `pizzapp/` app folder).
- App directory: `/home/ec2-user/pizzapp/` (contains `server.js`, `views/`, `public/`, `package.json`, `.env`, `node_modules/`, etc. — same layout as the local `pizzapp/pizzapp/` folder).
- **Almost everything under `/home/ec2-user/pizzapp/` is owned by `root:root`**, not `ec2-user`, even though `ec2-user` is the SSH login user. This is a pre-existing setup quirk, not something to "fix" — just work with `sudo` for any read/write there.
- `.env` lives at `/home/ec2-user/pizzapp/.env`, permissions `600`, owned by `root`. It is **not** tracked by git (see the project's `.gitignore`).

### Typical deploy pattern used in past sessions

```bash
KEY="/Users/brunocavalcanti/Desktop/Pizzapp/pizzapp.pem"

# 1. Copy updated file(s) to /tmp on the server
scp -i "$KEY" -o BatchMode=yes /local/path/server.js ec2-user@54.90.105.131:/tmp/

# 2. Move into place as root, keep a timestamped backup of the previous version
ssh -i "$KEY" -o BatchMode=yes ec2-user@54.90.105.131 "
  sudo cp /home/ec2-user/pizzapp/server.js /home/ec2-user/pizzapp/server.js.bak-\$(date +%s)
  sudo cp /tmp/server.js /home/ec2-user/pizzapp/server.js
  sudo chown root:root /home/ec2-user/pizzapp/server.js
  rm -f /tmp/server.js
"

# 3. Restart the running process (see PM2 section below)
ssh -i "$KEY" -o BatchMode=yes ec2-user@54.90.105.131 "sudo -i bash -c 'pm2 restart pizzapp'"
```

If `package.json`/`package-lock.json` changed (new npm dependency), also run on the server:

```bash
ssh -i "$KEY" -o BatchMode=yes ec2-user@54.90.105.131 "sudo -i bash -c 'cd /home/ec2-user/pizzapp && npm install --omit=dev'"
```

## 5. Node / npm / PM2 — the PATH quirk

Node, npm, and PM2 are installed via **nvm inside the `root` user's home directory**, not system-wide and not for `ec2-user`. Plain `sudo <command>` does **not** pick up `root`'s nvm-managed PATH (you'll get `command not found`).

**Always use `sudo -i bash -c '...'`** (a full root login shell) to run `node`, `npm`, or `pm2`:

```bash
# WRONG - will fail with "command not found"
sudo pm2 list

# RIGHT
sudo -i bash -c 'pm2 list'
```

Binaries live at `/root/.nvm/versions/node/v24.21.0/bin/{node,npm}`.

## 6. Managing the app with PM2

- Process name: **`pizzapp`** (id `0` in `pm2 list`)
- Entry point: `/home/ec2-user/pizzapp/server.js`
- Process list is persisted with `pm2 save` (dump file at `/root/.pm2/dump.pm2`), so it should auto-restore on instance reboot if PM2's startup hook is configured.

Common commands (all via `sudo -i bash -c '...'`):

```bash
sudo -i bash -c 'pm2 list'                 # see status
sudo -i bash -c 'pm2 restart pizzapp'      # apply a code change
sudo -i bash -c 'pm2 logs pizzapp --lines 50 --nostream'  # recent logs
sudo -i bash -c 'pm2 stop pizzapp'
sudo -i bash -c 'pm2 start pizzapp'
sudo -i bash -c 'pm2 save'                 # persist current process list
```

**Historical gotcha:** there used to be a stale, unrelated PM2 entry called `minha-api` (id 0) pointing at a different leftover project (`/home/ec2-user/app-teste/index.js`), crash-looping due to a bad DB connection. It has been deleted and replaced with the correct `pizzapp` process. If a `pm2 list` ever shows a process that isn't `pizzapp` pointing at `/home/ec2-user/pizzapp/server.js`, treat it with suspicion — confirm with whoever is present before deleting anything.

## 7. MariaDB

- Runs **locally on the same EC2 instance** (not a separate RDS instance) as a systemd service: `mariadb.service` (MariaDB 10.5).
- Listens on port `3306`. Note: it was observed listening on `*:3306` (all interfaces), not just loopback — worth confirming the Security Group doesn't expose 3306 publicly, since this is not intentional for a database.
- There is no need to SSH-tunnel to reach it — since you're already SSH'd into the same box, just connect to it locally.

Check it's running:

```bash
ssh -i "$KEY" -o BatchMode=yes ec2-user@54.90.105.131 "sudo systemctl status mariadb --no-pager"
```

### Running a query safely (without ever printing the password)

The credentials live in `/home/ec2-user/pizzapp/.env` (`DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`). **Never `cat` that file or echo its contents** — source it into environment variables inside the remote shell instead, so the password never appears in any terminal output or log:

```bash
ssh -i "$KEY" -o BatchMode=yes ec2-user@54.90.105.131 '
  sudo bash -c "
    set -a
    source /home/ec2-user/pizzapp/.env
    set +a
    mysql -h \"\$DB_HOST\" -u \"\$DB_USER\" -p\"\$DB_PASSWORD\" \"\$DB_NAME\" -e \"SELECT id, name, slug, is_active FROM restaurants;\"
  "
'
```

To just confirm which env vars exist without ever exposing values:

```bash
ssh -i "$KEY" -o BatchMode=yes ec2-user@54.90.105.131 "sudo grep -o '^[A-Z_]*=' /home/ec2-user/pizzapp/.env"
```

### Schema (as of this writing)

- `restaurants` (id, slug, name, whatsapp, is_active, created_at, notification_sound) — one row per tenant/pizzeria.
- `products` (id, restaurant_id, name, description, price, is_available)
- `orders` (id, restaurant_id, customer_name, customer_phone, delivery_address, payment_method, total_amount, status, created_at)
- `order_items` (id, order_id, product_id, quantity, unit_price, subtotal)

## 8. Environment variables expected in `.env`

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port the Node server listens on (3000) |
| `DB_HOST` | MariaDB host (`localhost`, since DB is on the same box) |
| `DB_USER` | MariaDB user |
| `DB_PASSWORD` | MariaDB password |
| `DB_NAME` | MariaDB database name |
| `ADMIN_USER` / `ADMIN_PASSWORD` | HTTP Basic Auth for the per-restaurant admin panel (`/:slug/admin`) |
| `SYSADMIN_USER` / `SYSADMIN_PASSWORD` | HTTP Basic Auth for the cross-tenant system admin panel (`/sistema/admin`) |

A template with empty values is committed at `pizzapp/.env.example` — use it as the source of truth for which variables are required, but never commit actual values.

## 9. Quick health checks after any deploy

```bash
curl -s http://54.90.105.131:3000/health
curl -s -o /dev/null -w "%{http_code}\n" http://54.90.105.131:3000/<some-restaurant-slug>
curl -s -o /dev/null -w "%{http_code}\n" http://54.90.105.131:3000/socket.io/socket.io.js
```

`/health` should return `{"status":"OK","db_time":"..."}`. A restaurant slug page should return `200` if the restaurant exists and is active, or a `404` JSON error otherwise.

## 10. Security notes (not yet addressed, flag if relevant)

- The app is served over plain HTTP on port 3000, no TLS. Basic Auth credentials travel in cleartext.
- MariaDB appeared to be listening on all interfaces (`*:3306`) rather than just `127.0.0.1`. Worth checking the Security Group doesn't allow inbound 3306 from the internet.
- Deploys are currently done by hand via `scp` + `pm2 restart`, not via `git pull` on the server — this was a deliberate choice after a `git pull` once deleted the server's `.env` file (because a commit removed `.env` from tracking, and `git pull` applied that deletion to the working tree). If switching to git-based deploys on the server, make sure `.env` is excluded/preserved first.
