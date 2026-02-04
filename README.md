# Dutchie Banner API

A Docker-based API service that automatically scrapes promotional banners from your Dutchie embedded menu and serves them via a secure REST API. Includes a WordPress plugin for easy integration.

**Created by [KawaConnect LLC](https://kawaconnect.com)**

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [API Reference](#api-reference)
- [WordPress Plugin](#wordpress-plugin)
- [Cloudflare Tunnel Setup](#cloudflare-tunnel-setup)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

## Features

- **Automated Banner Scraping**: Uses Puppeteer to extract promotional banners from your Dutchie embedded menu
- **REST API**: Secure API endpoint with key-based authentication
- **Auto-Refresh**: Configurable scrape intervals (default: every 30 minutes)
- **WordPress Plugin**: Drop-in plugin with shortcode support and admin interface
- **Performance Optimized**: Caching ensures banners load instantly without blocking page renders
- **Cloudflare Tunnel Support**: Optional secure exposure via Cloudflare Tunnel
- **Comprehensive Debugging**: Detailed debug logging in WordPress plugin for troubleshooting
- **Docker Ready**: Single command deployment with Docker Compose

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Dutchie.com   │────▶│  Dutchie Banner  │────▶│   WordPress     │
│  Embedded Menu  │     │       API        │     │    Website      │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │
                        ┌──────┴──────┐
                        │  Puppeteer  │
                        │  Scraper    │
                        └─────────────┘
```

1. **Scraper**: Puppeteer-based scraper runs periodically to extract banner images from Dutchie
2. **API Server**: Express.js server caches banners and serves them via REST API
3. **WordPress Plugin**: Fetches banners from API, caches locally, displays as carousel

## Requirements

- Docker and Docker Compose
- A Dutchie account with an embedded menu
- (Optional) Cloudflare account for tunnel access
- (Optional) WordPress 5.0+ for the plugin

## Quick Start

### 1. Clone the Repository

```bash
git clone https://github.com/Deenyoro/Dutchie-Banner-API.git
cd Dutchie-Banner-API
```

### 2. Configure Environment

```bash
# Copy the example environment file
cp .env.example .env

# Edit with your settings
nano .env
```

Required settings in `.env`:

```env
# Generate a secure API key
API_KEY=your_64_character_hex_key

# Your Dutchie embedded menu URL
DUTCHIE_URL=https://dutchie.com/embedded-menu/your-dispensary/?menuType=rec
```

To generate a secure API key:

```bash
openssl rand -hex 32
```

### 3. Start the Service

```bash
docker compose up -d
```

### 4. Verify It's Working

```bash
# Check the health endpoint
curl http://localhost:3847/health

# Fetch banners (replace YOUR_API_KEY with your actual key)
curl "http://localhost:3847/api/banners?key=YOUR_API_KEY"
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `API_KEY` | Yes | - | 64-character hex string for API authentication |
| `DUTCHIE_URL` | Yes | - | Full URL to your Dutchie embedded menu |
| `SCRAPE_INTERVAL_MINUTES` | No | 30 | How often to scrape for new banners |
| `TZ` | No | America/New_York | Timezone for logging |
| `ALLOWED_ORIGINS` | No | * | CORS allowed origins (comma-separated) |
| `TUNNEL_TOKEN` | No | - | Cloudflare Tunnel token (if using tunnel) |

### Finding Your Dutchie URL

1. Log in to your Dutchie dashboard
2. Navigate to **Settings** > **Embed Menu**
3. Copy the embed URL (looks like `https://dutchie.com/embedded-menu/your-name/?menuType=rec`)

## API Reference

### Health Check

Check if the API is running.

```
GET /health
```

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T12:00:00.000Z"
}
```

### Get Banners

Retrieve all cached banners.

```
GET /api/banners?key=YOUR_API_KEY
```

**Parameters:**
- `key` (required): Your API key

**Response:**
```json
{
  "banners": [
    {
      "id": "banner-0",
      "src": "https://images.dutchie.com/...",
      "srcset": "...",
      "alt": "Banner description",
      "link": "https://dutchie.com/stores/...",
      "width": 1200,
      "height": 400
    }
  ],
  "scrapedAt": "2024-01-15T12:00:00.000Z",
  "source": "https://dutchie.com/embedded-menu/...",
  "count": 6
}
```

### Force Refresh

Force an immediate re-scrape of banners.

```
GET /api/banners/refresh?key=YOUR_API_KEY
```

**Parameters:**
- `key` (required): Your API key

## WordPress Plugin

### Installation

1. Download `wordpress-plugin/dutchie-banner-carousel.php`
2. Upload to your WordPress site's `/wp-content/plugins/` directory
3. Activate the plugin in WordPress admin

Or create a zip:

```bash
cd wordpress-plugin
zip dutchie-banner-carousel.zip dutchie-banner-carousel.php
```

Then upload via **Plugins** > **Add New** > **Upload Plugin**

### Configuration

1. Go to **Settings** > **Dutchie Banners**
2. Enter your API URL (e.g., `https://your-api-domain.com`)
3. Enter your API Key
4. Click **Save Settings**
5. Click **Test Connection** to verify
6. Click **Refresh Banners Now** to populate the cache

### Usage

Add the shortcode to any page, post, or widget:

```
[dutchie_banners]
```

### Features

- **Auto-Refresh**: Banners automatically refresh every 30 minutes via WP-Cron
- **Zero Frontend Blocking**: Shortcode only reads from cache, never makes API calls
- **Debug Logging**: Comprehensive debug log for troubleshooting connection issues
- **Responsive Carousel**: Auto-rotating carousel with navigation dots and arrows

### Styling

The carousel uses these CSS classes for customization:

```css
.dutchie-carousel { }      /* Main container */
.dutchie-track { }         /* Slide container */
.dutchie-slide { }         /* Individual slide */
.dutchie-slide img { }     /* Banner image */
.dutchie-prev { }          /* Previous button */
.dutchie-next { }          /* Next button */
.dutchie-dots { }          /* Dot navigation container */
.dutchie-dot { }           /* Individual dot */
.dutchie-dot.active { }    /* Active dot */
```

## Cloudflare Tunnel Setup

Cloudflare Tunnel provides secure access to your API without exposing ports.

### 1. Create a Tunnel

1. Go to [Cloudflare Zero Trust](https://one.dash.cloudflare.com)
2. Navigate to **Networks** > **Tunnels**
3. Click **Create a tunnel**
4. Name your tunnel and save the token

### 2. Configure docker-compose.yml

The included `docker-compose.yml` has Cloudflare Tunnel support:

```yaml
cloudflared:
  image: cloudflare/cloudflared:latest
  container_name: dutchie-cloudflared
  restart: unless-stopped
  network_mode: host
  command: tunnel run
  environment:
    - TUNNEL_TOKEN=${TUNNEL_TOKEN}
  depends_on:
    - dutchie-scraper
```

### 3. Add Token to .env

```env
TUNNEL_TOKEN=your_tunnel_token_here
```

### 4. Configure Public Hostname

In Cloudflare Zero Trust:
1. Click on your tunnel
2. Go to **Public Hostname**
3. Add a hostname (e.g., `api.yourdomain.com`)
4. Set service to `http://localhost:3847`

### Important: Disable Cloudflare Access

If you see 403 errors with "Just a moment..." in WordPress:

1. Go to **Access** > **Applications**
2. Delete any Access Application for your API hostname
3. The API is already protected by your API key

## Troubleshooting

### Common Issues

#### 403 Forbidden with "Just a moment..."

**Cause**: Cloudflare Bot Fight Mode is blocking requests.

**Solutions**:
1. Disable Bot Fight Mode: **Security** > **Bots** > Turn OFF
2. Create a Configuration Rule:
   - **Rules** > **Configuration Rules** > Create
   - Field: `Hostname` equals `your-api-hostname`
   - Then: Browser Integrity Check = OFF

#### Connection Timeout

**Cause**: API server not reachable from WordPress.

**Solutions**:
- Verify API server is running: `docker ps`
- Test from WordPress server: `curl "https://your-api/health"`
- Check firewall rules

#### Invalid API Key

**Cause**: Key mismatch between API and WordPress.

**Solution**: Verify the key in `.env` matches WordPress settings exactly.

#### No Banners Showing

**Cause**: Cache is empty.

**Solution**: Go to **Settings** > **Dutchie Banners** > Click **Refresh Banners Now**

### Debug Mode

The WordPress plugin includes comprehensive debug logging:

1. Go to **Settings** > **Dutchie Banners**
2. Click **Test Connection**
3. Review the Debug Log section for detailed diagnostic information

### Checking Logs

```bash
# View API server logs
docker logs dutchie-banner-api

# Follow logs in real-time
docker logs -f dutchie-banner-api

# View Cloudflare Tunnel logs (if using)
docker logs dutchie-cloudflared
```

## Development

### Local Development

```bash
# Install dependencies
npm install

# Run the scraper once
npm run scrape

# Start the server
npm start
```

### Project Structure

```
├── server.js                # Express API server
├── scraper.js               # Puppeteer scraper
├── package.json             # Node.js dependencies
├── Dockerfile               # Docker build configuration
├── docker-compose.yml       # Docker Compose services
├── .env.example             # Example environment variables
├── .gitignore               # Git ignore rules
├── data/                    # Scraped banner data (gitignored)
└── wordpress-plugin/
    └── dutchie-banner-carousel.php  # WordPress plugin
```

### Building the Docker Image

```bash
docker compose build
```

### Regenerating API Key

```bash
# Generate new key
NEW_KEY=$(openssl rand -hex 32)
echo "New API Key: $NEW_KEY"

# Update .env file
sed -i "s/API_KEY=.*/API_KEY=$NEW_KEY/" .env

# Restart containers
docker compose down && docker compose up -d
```

## License

MIT License

Copyright (c) 2024 KawaConnect LLC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Support

For issues and feature requests, please use the [GitHub Issues](https://github.com/Deenyoro/Dutchie-Banner-API/issues) page.

---

**Created by [KawaConnect LLC](https://kawaconnect.com)**
