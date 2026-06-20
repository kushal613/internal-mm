# Run the market maker 24/7 (beginner-friendly guide)

This guide moves your market maker from your laptop to a small cloud server that stays on all the time. When your laptop sleeps or you close Terminal, the bot keeps running.

**Time:** about 30–45 minutes the first time.

**Cost:** roughly $5–10 per month for a small server (Hetzner, DigitalOcean, etc.).

**What you already have:** the bot code in this repo, a `.env` file on your laptop with `CONVALLAX_API_KEY` and `MM_PRIVATE_KEY`, and a funded maker wallet on Polygon Amoy testnet.

---

## The big picture (read this first)

| Today | After this guide |
|-------|------------------|
| You run `npm run start` on your laptop | A cloud server runs it for you |
| Closing Terminal stops the bot | Closing Terminal does nothing — bot keeps going |
| Laptop off = bot off | Laptop off = bot still on |

**Three pieces:**

1. **A VPS** — “Virtual Private Server.” A small Linux computer in a data center, always powered on.
2. **Your code + secrets** — same repo and same `.env` values, copied to that server.
3. **systemd** — Linux’s built-in “keep this program running” manager. If the bot crashes or the server reboots, systemd starts it again.

You do **not** need to learn Linux deeply. Copy-paste the commands below in order.

---

## Part 1 — Create a cloud server (VPS)

Pick one provider (all work fine):

- [Hetzner Cloud](https://www.hetzner.com/cloud/) — often cheapest
- [DigitalOcean](https://www.digitalocean.com/)
- [Linode (Akamai)](https://www.linode.com/)

### Sign up and create a server

Use these settings when asked:

| Setting | Choose |
|---------|--------|
| **Image / OS** | Ubuntu 24.04 LTS |
| **Size** | Smallest/cheapest (1 vCPU, 1–2 GB RAM is enough) |
| **Region** | Closest to you (or US East — fine for Convallax APIs) |
| **Authentication** | **SSH key** (recommended) or password |

**SSH key (recommended):** On your Mac, run:

```bash
cat ~/.ssh/id_ed25519.pub
```

If that file doesn’t exist, create a key:

```bash
ssh-keygen -t ed25519 -C "your-email@example.com"
```

Copy the **entire line** that `cat` prints and paste it into the provider’s “SSH key” field when creating the server.

When the server is ready, note its **public IP address** (example: `142.250.80.46`). You’ll use it as `YOUR_SERVER_IP` below.

---

## Part 2 — Connect to your server

“SSH” means opening a remote Terminal session on the server.

On your Mac:

```bash
ssh root@YOUR_SERVER_IP
```

- First time: type `yes` when asked about fingerprint.
- If you used a password: enter the password the provider emailed you.
- If you used an SSH key: it should log in without a password.

You should see a prompt like `root@ubuntu-s-1vcpu-...`. **All commands in Parts 3–7 run on the server** (unless we say “on your Mac”).

---

## Part 3 — Prepare the server (one-time)

Run these on the server, one block at a time.

### 3a. Update packages and install Node.js 20

```bash
apt update && apt upgrade -y
apt install -y curl git
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node -v    # should print v20.x.x
npm -v
```

**What this does:** Installs Git and Node.js 20, which the bot needs.

### 3b. Create a dedicated user (safer than running as root)

```bash
adduser mm
usermod -aG sudo mm
```

Set a password when prompted (you can pick something simple — you’ll rarely need it).

Copy your SSH access to the new user so you can log in as `mm` later:

```bash
rsync --archive --chown=mm:mm ~/.ssh /home/mm
```

From now on, you can connect as:

```bash
ssh mm@YOUR_SERVER_IP
```

### 3c. Log in as `mm` (if you’re still root)

```bash
su - mm
cd ~
```

---

## Part 4 — Copy the project onto the server

### Option A — Clone from GitHub (easiest if the repo is pushed)

On the server as `mm`:

```bash
cd ~
git clone https://github.com/kushal613/internal-mm.git
cd internal-mm
npm ci
```

If the repo is private, use a [GitHub personal access token](https://github.com/settings/tokens) or SSH deploy key.

### Option B — Copy from your laptop

On your **Mac** (not the server):

```bash
scp -r /Users/kushalmungee/Desktop/internal-mm mm@YOUR_SERVER_IP:~/
```

Then on the server:

```bash
cd ~/internal-mm
npm ci
```

**What `npm ci` does:** Installs the exact dependencies listed in the repo (same as `npm install` on your laptop).

---

## Part 5 — Put your secrets on the server (`.env`)

The bot needs two secrets (same as on your laptop):

- `CONVALLAX_API_KEY`
- `MM_PRIVATE_KEY`

**Never commit these to Git.** They stay only in `.env` on the server.

### On the server

```bash
cd ~/internal-mm
cp .env.example .env
nano .env
```

In `nano`:

1. Paste your real `CONVALLAX_API_KEY` and `MM_PRIVATE_KEY` (copy from your laptop’s `.env`).
2. Optionally set `LOG_JSON=1` for cleaner logs.
3. Save: `Ctrl+O`, Enter, then exit: `Ctrl+X`.

Lock down permissions so only you can read the file:

```bash
chmod 600 .env
```

**On your Mac:** open `.env` in another window to copy values. Do not paste secrets into chat or email.

---

## Part 6 — One-time wallet setup on the server

If you already ran `npm run approve` on your laptop **with the same wallet**, you can skip `approve` — approvals are on-chain, not on the machine.

If this is a fresh wallet or you never approved:

```bash
cd ~/internal-mm
npm run setup      # check balances and relay connectivity
npm run approve    # one-time USDC approvals (needs MM_PRIVATE_KEY in .env)
```

**What `approve` does:** Lets Convallax contracts pull USDC from your maker wallet when trades settle. You only need this once per wallet (until allowances expire).

Ensure the wallet still has:

- **Amoy POL** — for gas
- **Testnet USDC** — for collateral (`npm run faucet` or `npm run mint` if low)

---

## Part 7 — Install systemd (auto-start + auto-restart)

systemd is Linux’s service manager. After this, the bot:

- Starts when the server boots
- Restarts if it crashes
- Keeps running when you disconnect SSH

### 7a. Copy the service file

Still on the server as `mm`:

```bash
cd ~/internal-mm
sudo cp deploy/convallax-mm.service /etc/systemd/system/convallax-mm.service
```

### 7b. Edit paths if your setup differs

Default paths assume user `mm` and project at `/home/mm/internal-mm`. If you used different names:

```bash
sudo nano /etc/systemd/system/convallax-mm.service
```

Check `User`, `WorkingDirectory`, and `EnvironmentFile` match your setup.

### 7c. Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable convallax-mm
sudo systemctl start convallax-mm
```

**What each command does:**

| Command | Meaning |
|---------|---------|
| `daemon-reload` | systemd reads the new service file |
| `enable` | Start the bot automatically after reboot |
| `start` | Start the bot now |

---

## Part 8 — Verify it’s working

### Check service status

```bash
sudo systemctl status convallax-mm
```

Look for **`active (running)`** in green. Press `q` to exit.

### Watch live logs

```bash
sudo journalctl -u convallax-mm -f
```

You should see lines like:

- `starting Convallax MM`
- `relay reachable`
- `LIVE quoting mode enabled` (if `MM_PRIVATE_KEY` is set)
- SSE/WS connection messages

Press `Ctrl+C` to stop watching logs (the bot keeps running).

### Test “laptop doesn’t matter”

1. Leave the bot running on the server.
2. Close SSH / shut your laptop.
3. Wait a few minutes, SSH back in, run `sudo systemctl status convallax-mm` again — it should still be `active (running)`.

---

## Part 9 — Day-to-day commands (cheat sheet)

All on the server:

| What you want | Command |
|---------------|---------|
| Is it running? | `sudo systemctl status convallax-mm` |
| Live logs | `sudo journalctl -u convallax-mm -f` |
| Last 100 log lines | `sudo journalctl -u convallax-mm -n 100` |
| Restart the bot | `sudo systemctl restart convallax-mm` |
| Stop the bot | `sudo systemctl stop convallax-mm` |
| Start after stop | `sudo systemctl start convallax-mm` |

After you change code or `.env`:

```bash
cd ~/internal-mm
git pull          # if you use git
npm ci            # if package.json changed
sudo systemctl restart convallax-mm
```

---

## Part 10 — Troubleshooting

### Service fails immediately (`failed` or `activating`)

```bash
sudo journalctl -u convallax-mm -n 50 --no-pager
```

Common causes:

| Log message | Fix |
|-------------|-----|
| `CONVALLAX_API_KEY` / missing env | Fix `.env`, then `sudo systemctl restart convallax-mm` |
| `401` / `403` / auth errors | Wrong API key — fix `.env` |
| `npm: command not found` | Node not installed, or wrong `ExecStart` path. Run `which npm` and update the service file |
| Permission denied on `.env` | `chmod 600 .env` and ensure `User=mm` matches file owner |

### Bot runs but doesn’t quote

- Check `MM_PRIVATE_KEY` is set in server `.env`
- Run `npm run setup` and fix low POL/USDC or missing approvals

### Server rebooted — is the bot back?

```bash
sudo systemctl status convallax-mm
```

If you ran `enable`, it should auto-start. If not, run `sudo systemctl enable convallax-mm` again.

### Optional: better RPC

Public Amoy RPC can be flaky. In `.env`:

```env
RPC_URL=https://polygon-amoy.g.alchemy.com/v2/YOUR_ALCHEMY_KEY
```

(Get a free key from [Alchemy](https://www.alchemy.com/).)

---

## Security reminders

1. **Never share** `MM_PRIVATE_KEY` or paste it in Slack/GitHub.
2. **`.env` is gitignored** — don’t force-add it to Git.
3. The bot only needs **outbound** internet (no open ports required for Convallax).
4. Consider disabling password SSH and using SSH keys only (provider docs).

---

## Quick checklist

- [ ] VPS created (Ubuntu 24.04)
- [ ] SSH works (`ssh mm@YOUR_SERVER_IP`)
- [ ] Node 20 installed (`node -v`)
- [ ] Repo on server (`~/internal-mm`)
- [ ] `npm ci` completed
- [ ] `.env` with secrets, `chmod 600`
- [ ] Wallet funded (POL + USDC), approvals done
- [ ] `sudo systemctl enable --now convallax-mm`
- [ ] `status` shows `active (running)`
- [ ] Logs show relay connected

Once all boxes are checked, your market maker runs 24/7 without your laptop.
