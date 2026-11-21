# PGinfo Listings Backend – Production VPS Deployment Guide

This guide provides a comprehensive, step-by-step walkthrough to deploy the PGinfo Listings Backend on your existing Linux VPS server for the production domain:

**`https://api.pginfo.business`**

---

## 🏗️ 1. Architecture & VPS Isolation Strategy

Your VPS server currently hosts multiple live projects under `/var/www/` (e.g., `Inquiry_Business_v1`, `hospital-system`, `itjobx`, `lovenzea`, `master-gateway`, `punarmilan`, `fmfilms`, `swift_ride`, etc.).

To guarantee **zero disruption** to your existing applications, this backend is configured to run in complete isolation:

| Component | Setting / Isolation Parameter | Purpose |
| :--- | :--- | :--- |
| **Deployment Path** | `/var/www/pginfo-listings-backend` | Dedicated project directory |
| **Process Manager** | PM2 Cluster (Name: `pginfo-listings-backend`) | Independent cluster process |
| **Application Port** | `PORT=5001` (Configurable in `.env`) | Dedicated internal loopback port |
| **Reverse Proxy** | Nginx (`/etc/nginx/sites-available/api.pginfo.business`) | Isolated virtual host config |
| **Upstream Name** | `pginfo_listings_backend_upstream` | Unique upstream to avoid collision |
| **Nginx Logs** | `/var/log/nginx/api.pginfo.business.*.log` | Dedicated access and error logs |
| **App Logs** | `/var/www/pginfo-listings-backend/logs/` | PM2 aggregated log files |
| **SSL / HTTPS** | Let's Encrypt / Certbot | Automatic renewal for `api.pginfo.business` |
| **Redis** | Local `127.0.0.1:6379` OR Resilient In-Memory Mode | No credentials required to boot |

---

## 📋 2. Deployment Checklist

- [ ] Domain DNS Record: `api.pginfo.business` points to your VPS Public IP (A Record).
- [ ] SSH access to VPS as `root` or `sudo` user.
- [ ] Node.js (v18.x or v20.x LTS) installed.
- [ ] PM2 process manager installed (`npm install -g pm2`).
- [ ] Nginx web server running.
- [ ] MongoDB Atlas connection URI ready.
- [ ] Cloudinary credentials ready (for image/video storage).

---

## 🚀 3. Step-by-Step Deployment Instructions

### Step 1: Inspect Existing VPS Ports & Environment

Before starting, connect to your VPS via SSH and check running ports and PM2 apps to ensure port `5001` is free:

```bash
# Check if port 5001 is already in use
sudo ss -tulpn | grep :5001

# If port 5001 is in use by another app, you can choose another port like 5005 or 5050
# List currently running PM2 apps
pm2 list

# Check existing Nginx sites
ls -l /etc/nginx/sites-enabled/
```

---

### Step 2: Clone the Repository

Navigate to `/var/www` and clone the backend repository into `/var/www/pginfo-listings-backend`:

```bash
cd /var/www

# Clone repository
sudo git clone https://github.com/pginfo-online/pginfo-listings-backend-application.git pginfo-listings-backend

# Enter the project directory
cd /var/www/pginfo-listings-backend
```

---

### Step 3: Set Permissions & Create Log Directory

Set appropriate ownership so your application user can read/write logs without permission issues:

```bash
# If running as root:
mkdir -p logs

# If running as a non-root user (e.g. www-data or ubuntu):
# sudo chown -R $USER:$USER /var/www/pginfo-listings-backend
# chmod -R 755 /var/www/pginfo-listings-backend
mkdir -p logs
```

---

### Step 4: Install Production Dependencies

Install npm dependencies cleanly:

```bash
cd /var/www/pginfo-listings-backend

# Install production dependencies
npm ci --omit=dev

# (Or if npm ci fails due to lockfile version):
# npm install --production
```

---

### Step 5: Configure Production Environment Variables (`.env`)

Copy `.env.example` to `.env` and configure your credentials:

```bash
cp .env.example .env
nano .env
```

Configure the following essential variables:

```ini
# ------------------------------------------------------------------------------
# 1. SERVER & INFRASTRUCTURE
# ------------------------------------------------------------------------------
PORT=5001
NODE_ENV=production
TRUST_PROXY=1
PM2_INSTANCES=max
ENABLE_SCHEDULERS=true
RATE_LIMIT_MAX=1000

# ------------------------------------------------------------------------------
# 2. DATABASE
# ------------------------------------------------------------------------------
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster>.mongodb.net/<database>?retryWrites=true&w=majority
MONGO_MAX_POOL_SIZE=25
MONGO_MIN_POOL_SIZE=5
USE_FALLBACK_DNS=true

# ------------------------------------------------------------------------------
# 3. SECURITY & AUTHENTICATION
# ------------------------------------------------------------------------------
# Generate with: openssl rand -base64 48
JWT_SECRET=YOUR_SECURE_RANDOM_SECRET_KEY
JWT_EXPIRES_IN=7d
JWT_ACCESS_EXPIRES_IN=1h

# ------------------------------------------------------------------------------
# 4. CORS CONFIGURATION
# ------------------------------------------------------------------------------
CLIENT_URL=https://pginfo.business,https://www.pginfo.business,https://admin.pginfo.business,https://api.pginfo.business,https://www.pginfo.in,https://pginfo.in

# ------------------------------------------------------------------------------
# 5. REDIS SETUP (See Section 4 below for details)
# ------------------------------------------------------------------------------
# Option A: If Redis credentials are not present, leave REDIS_URL empty:
REDIS_URL=
# Option B: If Redis is installed locally on VPS:
# REDIS_URL=redis://127.0.0.1:6379

REDIS_DB=0
REDIS_KEY_PREFIX=pgm:
REDIS_TIMEOUT_MS=2500

# ------------------------------------------------------------------------------
# 6. CLOUDINARY (Media Uploads)
# ------------------------------------------------------------------------------
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret

# ------------------------------------------------------------------------------
# 7. EMAIL & SMS NOTIFICATIONS (Optional / as available)
# ------------------------------------------------------------------------------
RESEND_API_KEY=your_resend_api_key
RESEND_FROM_EMAIL=notifications@pginfo.business
```

Save and exit nano (`Ctrl + O`, `Enter`, `Ctrl + X`).

---

### Step 6: Database Migrations & Indexing

Run the migration scripts to ensure all database indexes (geospatial, search, catalog, workflows) are built:

```bash
cd /var/www/pginfo-listings-backend

# Run all schema and index migrations
npm run migration:all
```

---

### Step 7: Redis Setup (Flexible: 3 Supported Options)

The backend has been upgraded with a **Resilient In-Memory Fallback Cache Layer**. This means you have three flexible choices:

#### Option A: Run Without Redis (No Credentials Needed)
- If you do not have Redis credentials or haven't installed Redis yet, simply leave `REDIS_URL=` empty in your `.env`.
- The backend will **not crash**. It will automatically boot up in **Resilient Mode** using its built-in in-memory fallback cache with automatic TTL and LRU eviction for user sessions, refresh tokens, and search caching.

#### Option B: Install Local Redis on Your VPS (Recommended for High Performance)
If you want blazing-fast distributed caching on your VPS, install Redis locally in 60 seconds:

```bash
# 1. Install Redis server on Ubuntu/Debian
sudo apt update
sudo apt install -y redis-server

# 2. Ensure Redis starts on boot and is running
sudo systemctl enable redis-server
sudo systemctl start redis-server

# 3. Test Redis connectivity
redis-cli ping
# Should output: PONG

# 4. Verify Redis only listens on localhost (127.0.0.1) for security:
sudo ss -tulpn | grep 6379
# Should show: 127.0.0.1:6379 (NOT 0.0.0.0:6379)
```

In your `/var/www/pginfo-listings-backend/.env`, set:
```ini
REDIS_URL=redis://127.0.0.1:6379
```

#### Option C: Cloud / Managed Redis (Upstash, AWS ElastiCache, Redis Cloud)
If you obtain managed Redis credentials later, set:
```ini
REDIS_URL=rediss://default:your_password@your-endpoint.upstash.io:6379
```

---

### Step 8: Start Backend with PM2 Cluster

Start the application with PM2 using the dedicated cluster configuration:

```bash
cd /var/www/pginfo-listings-backend

# Start application in cluster mode
npm run pm2:start

# Save PM2 state so it restarts automatically on VPS reboot
pm2 save

# Ensure PM2 startup script is configured (if not already done)
sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u root --hp /root

# Check PM2 status
pm2 status

# View live application startup logs
pm2 logs pginfo-listings-backend --lines 30
```

Verify that the log outputs:
```text
[INFO] ... 🚀 PGinfo.online API running on port 5001 [production] (Worker: 0)
[INFO] ... ✅ MongoDB connected: ...
```

---

### Step 9: Configure Nginx Reverse Proxy for `api.pginfo.business`

Create an isolated Nginx server block:

```bash
sudo nano /etc/nginx/sites-available/api.pginfo.business
```

Paste the following Nginx configuration:

```nginx
# Dedicated upstream for PGinfo Listings Backend
upstream pginfo_listings_backend_upstream {
    server 127.0.0.1:5001;
    keepalive 64;
}

# HTTP Server - Handles ACME Challenge & Redirects to HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name api.pginfo.business;

    # Let's Encrypt ACME challenge location (supports existing VPS webroots)
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
        try_files $uri /var/www/pginfo-acme/$uri =404;
    }

    # Reverse proxy during initial cert setup / redirect to HTTPS
    location / {
        proxy_pass http://pginfo_listings_backend_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable the site by creating a symbolic link:

```bash
sudo ln -s /etc/nginx/sites-available/api.pginfo.business /etc/nginx/sites-enabled/

# Test Nginx syntax to ensure no syntax errors and no duplicate upstreams
sudo nginx -t

# Reload Nginx without downtime for existing sites
sudo systemctl reload nginx
```

---

### Step 10: Issue SSL / HTTPS Certificate with Certbot

Run Certbot to obtain and install a free SSL certificate for `api.pginfo.business`:

```bash
# Option A: Automatic Nginx installation
sudo certbot --nginx -d api.pginfo.business

# (Certbot will prompt for an email and ask to automatically redirect HTTP to HTTPS - choose Yes / Redirect)
```

*Note: If your VPS uses webroot mode with `/var/www/certbot` or `/var/www/pginfo-acme`:*
```bash
# Option B: Webroot mode
sudo certbot certonly --webroot -w /var/www/certbot -d api.pginfo.business
```

Once Certbot completes, update `/etc/nginx/sites-available/api.pginfo.business` to the hardened production HTTPS block:

```nginx
upstream pginfo_listings_backend_upstream {
    server 127.0.0.1:5001;
    keepalive 64;
}

# HTTP to HTTPS redirect
server {
    listen 80;
    listen [::]:80;
    server_name api.pginfo.business;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
        try_files $uri /var/www/pginfo-acme/$uri =404;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

# Production HTTPS Server
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name api.pginfo.business;

    ssl_certificate /etc/letsencrypt/live/api.pginfo.business/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.pginfo.business/privkey.pem;
    ssl_trusted_certificate /etc/letsencrypt/live/api.pginfo.business/chain.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL_PGINFO:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;
    ssl_stapling on;
    ssl_stapling_verify on;

    # Security Headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;

    # Upload size for high-res property images/videos
    client_max_body_size 50M;
    client_body_buffer_size 128k;

    # Timeouts
    proxy_connect_timeout 60s;
    proxy_send_timeout 120s;
    proxy_read_timeout 120s;
    send_timeout 120s;

    # Gzip
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml text/javascript;

    # Isolated application logs
    access_log /var/log/nginx/api.pginfo.business.access.log;
    error_log /var/log/nginx/api.pginfo.business.error.log warn;

    # Health Check endpoint
    location /health {
        proxy_pass http://pginfo_listings_backend_upstream/health;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        access_log off;
    }

    # Main API reverse proxy
    location / {
        proxy_pass http://pginfo_listings_backend_upstream;
        proxy_http_version 1.1;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_cache_bypass $http_upgrade;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $server_port;

        proxy_buffering on;
        proxy_buffer_size 16k;
        proxy_buffers 8 32k;
        proxy_busy_buffers_size 64k;
    }
}
```

Test and reload Nginx:
```bash
sudo nginx -t
sudo systemctl reload nginx
```

---

### Step 11: Firewall / UFW Rules Verification

Check UFW status to verify that standard HTTP/HTTPS traffic is open:

```bash
sudo ufw status verbose
```

If UFW is active, ensure `Nginx Full` (ports 80 and 443) is allowed:
```bash
sudo ufw allow 'Nginx Full'
```
*(Do NOT open internal port 5001 or Redis port 6379 publicly—they must only be reachable internally on 127.0.0.1).*

---

### Step 12: Deployment Verification & Health Checks

Test the live deployment from your terminal or browser:

```bash
# 1. Test HTTPS response code and SSL handshake
curl -I https://api.pginfo.business/health

# 2. Test detailed health payload
curl -s https://api.pginfo.business/health | jq .

# 3. Test readiness probe
curl -s https://api.pginfo.business/health/ready
# Expected: READY or READY_DEGRADED (both return HTTP 200)

# 4. Test API root endpoint
curl -s https://api.pginfo.business/api/v1 | jq .
```

Expected `/health` JSON output:
```json
{
  "success": true,
  "status": "UP",
  "message": "PGinfo.online API is fully operational",
  "version": "1.0.0",
  "environment": "production",
  "database": {
    "status": "connected",
    "connected": true
  },
  "redis": {
    "status": "connected",
    "connected": true
  }
}
```

---

### Step 13: Monitoring, Logs & Troubleshooting

```bash
# View real-time aggregated PM2 logs
pm2 logs pginfo-listings-backend

# View error logs only
pm2 logs pginfo-listings-backend --err

# Check memory and CPU usage
pm2 monit

# Check Nginx error logs if requests fail
sudo tail -f /var/log/nginx/api.pginfo.business.error.log
```

---

### Step 14: Future Updates & Safe Redeployment Script

To update your backend in the future with zero downtime:

Create an executable deployment script `/var/www/pginfo-listings-backend/deploy.sh`:

```bash
cat << 'EOF' > /var/www/pginfo-listings-backend/deploy.sh
#!/bin/bash
set -e

echo "🚀 Starting zero-downtime deployment for pginfo-listings-backend..."

cd /var/www/pginfo-listings-backend

echo "📥 Pulling latest changes from Git..."
git pull origin main

echo "📦 Installing production dependencies..."
npm ci --omit=dev

echo "🔄 Running database migrations..."
npm run migration:all

echo "♻️ Reloading PM2 cluster with zero downtime..."
npm run pm2:reload

echo "✅ Deployment completed successfully!"
EOF

chmod +x /var/www/pginfo-listings-backend/deploy.sh
```

Whenever you push new changes to GitHub, simply SSH into your VPS and run:
```bash
/var/www/pginfo-listings-backend/deploy.sh
```
