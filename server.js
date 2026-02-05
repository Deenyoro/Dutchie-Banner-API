const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { scrapeBanners, getBanners } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;
const SCRAPE_INTERVAL = (parseInt(process.env.SCRAPE_INTERVAL_MINUTES) || 30) * 60 * 1000;
const RETRY_INTERVAL = 5 * 60 * 1000; // 5 minutes retry on failure
const MAX_RETRIES = 3;

// API Key from environment variable
const API_KEY = process.env.API_KEY;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['*'];

// Scrape status tracking
let scrapeStatus = {
  lastAttempt: null,
  lastSuccess: null,
  lastError: null,
  consecutiveFailures: 0,
  totalScrapes: 0,
  totalFailures: 0,
  isRunning: false,
  nextScheduled: null
};

// Enable CORS for configured domains
app.use(cors({
  origin: ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS,
  methods: ['GET']
}));

// Request logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// API Key validation middleware
const validateApiKey = (req, res, next) => {
  if (!API_KEY) return next();

  const providedKey = req.headers['x-api-key'] || req.query.key;

  if (!providedKey) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'API key required. Provide via X-API-Key header or ?key= parameter'
    });
  }

  if (providedKey !== API_KEY) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Invalid API key'
    });
  }

  next();
};

// Perform a scrape with retry logic
async function performScrape(isRetry = false) {
  if (scrapeStatus.isRunning) {
    console.log(`[${new Date().toISOString()}] Scrape already in progress, skipping`);
    return null;
  }

  scrapeStatus.isRunning = true;
  scrapeStatus.lastAttempt = new Date().toISOString();
  scrapeStatus.totalScrapes++;

  try {
    const result = await scrapeBanners();
    scrapeStatus.lastSuccess = new Date().toISOString();
    scrapeStatus.lastError = null;
    scrapeStatus.consecutiveFailures = 0;
    scrapeStatus.isRunning = false;
    console.log(`[${new Date().toISOString()}] Scrape successful: ${result.count} banners`);
    return result;
  } catch (error) {
    scrapeStatus.consecutiveFailures++;
    scrapeStatus.totalFailures++;
    scrapeStatus.lastError = error.message;
    scrapeStatus.isRunning = false;
    console.error(`[${new Date().toISOString()}] Scrape failed (attempt ${scrapeStatus.consecutiveFailures}): ${error.message}`);

    // Schedule retry if under max retries
    if (scrapeStatus.consecutiveFailures < MAX_RETRIES && !isRetry) {
      console.log(`[${new Date().toISOString()}] Scheduling retry in ${RETRY_INTERVAL / 60000} minutes`);
      setTimeout(() => performScrape(true), RETRY_INTERVAL);
    }

    throw error;
  }
}

// Schedule next scrape
function scheduleNextScrape() {
  scrapeStatus.nextScheduled = new Date(Date.now() + SCRAPE_INTERVAL).toISOString();
  setTimeout(async () => {
    try {
      await performScrape();
    } catch (e) {
      // Error already logged
    }
    scheduleNextScrape();
  }, SCRAPE_INTERVAL);
}

// Health check (no auth required)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    scrapeStatus: {
      lastSuccess: scrapeStatus.lastSuccess,
      isHealthy: scrapeStatus.consecutiveFailures === 0
    }
  });
});

// Scrape status endpoint (no auth required for monitoring)
app.get('/api/status', (req, res) => {
  res.json({
    status: scrapeStatus.consecutiveFailures === 0 ? 'healthy' : 'degraded',
    ...scrapeStatus,
    uptime: process.uptime(),
    scrapeInterval: `${SCRAPE_INTERVAL / 60000} minutes`
  });
});

// Get cached banners (requires API key)
app.get('/api/banners', validateApiKey, async (req, res) => {
  try {
    const data = await getBanners();

    // Add cache freshness info
    const scrapedAt = new Date(data.scrapedAt);
    const ageMinutes = Math.round((Date.now() - scrapedAt) / 60000);

    res.json({
      ...data,
      cache: {
        ageMinutes,
        isFresh: ageMinutes < (SCRAPE_INTERVAL / 60000) * 1.5,
        nextRefresh: scrapeStatus.nextScheduled
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get banners', message: error.message });
  }
});

// Force a fresh scrape (requires API key)
app.get('/api/banners/refresh', validateApiKey, async (req, res) => {
  try {
    const data = await performScrape();
    res.json({
      ...data,
      refreshed: true
    });
  } catch (error) {
    res.status(500).json({ error: 'Scrape failed', message: error.message });
  }
});

// Serve a ready-to-use HTML carousel widget (requires API key in query param)
app.get('/widget', validateApiKey, (req, res) => {
  const apiKey = req.query.key || '';
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; }
    .promo-carousel {
      width: 100%;
      overflow: hidden;
      position: relative;
      touch-action: pan-y pinch-zoom;
      cursor: grab;
      -webkit-user-select: none;
      user-select: none;
    }
    .promo-track {
      display: flex;
      transition: transform 0.4s ease;
    }
    .promo-slide {
      min-width: 100%;
      flex-shrink: 0;
    }
    .promo-slide img {
      width: 100%;
      height: auto;
      display: block;
      pointer-events: none;
      -webkit-user-drag: none;
    }
    .promo-slide a {
      display: block;
    }
    .promo-nav {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      background: rgba(0,0,0,0.5);
      color: white;
      border: none;
      padding: 15px 10px;
      cursor: pointer;
      font-size: 18px;
      z-index: 10;
      transition: background 0.2s;
    }
    .promo-nav:hover { background: rgba(0,0,0,0.8); }
    .promo-prev { left: 0; border-radius: 0 4px 4px 0; }
    .promo-next { right: 0; border-radius: 4px 0 0 4px; }
    .promo-dots {
      text-align: center;
      padding: 10px 0;
    }
    .promo-dot {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #ccc;
      margin: 0 5px;
      cursor: pointer;
      transition: background 0.3s;
    }
    .promo-dot.active {
      background: #004a71;
    }
    .promo-error {
      padding: 20px;
      text-align: center;
      color: #666;
    }
    @media (max-width: 768px) {
      .promo-nav { padding: 20px 15px; font-size: 22px; }
      .promo-dot { width: 12px; height: 12px; margin: 0 6px; }
    }
  </style>
</head>
<body>
  <div class="promo-carousel" id="promoCarousel">
    <div class="promo-track" id="promoTrack"></div>
    <button class="promo-nav promo-prev" aria-label="Previous">&lt;</button>
    <button class="promo-nav promo-next" aria-label="Next">&gt;</button>
    <div class="promo-dots" id="promoDots"></div>
  </div>

  <script>
    (function() {
      const API_KEY = '${apiKey}';
      const API_URL = window.location.origin + '/api/banners' + (API_KEY ? '?key=' + API_KEY : '');
      let currentSlide = 0;
      let slideCount = 0;
      let autoplayInterval;
      let startX, startY, isDragging = false, moved = false;
      const threshold = 50;

      async function loadBanners() {
        try {
          const res = await fetch(API_URL);
          if (!res.ok) throw new Error('API error');
          const data = await res.json();
          renderCarousel(data.banners);
        } catch (err) {
          document.getElementById('promoCarousel').innerHTML =
            '<div class="promo-error">Unable to load promotions</div>';
        }
      }

      function renderCarousel(banners) {
        const track = document.getElementById('promoTrack');
        const dots = document.getElementById('promoDots');
        slideCount = banners.length;

        track.innerHTML = banners.map(b => {
          const img = '<img src="' + b.src + '" alt="' + (b.alt || '') + '" loading="lazy">';
          return '<div class="promo-slide">' +
            (b.link ? '<a href="' + b.link + '" target="_blank" rel="noopener">' + img + '</a>' : img) +
            '</div>';
        }).join('');

        dots.innerHTML = banners.map((_, i) =>
          '<span class="promo-dot' + (i === 0 ? ' active' : '') + '" data-index="' + i + '"></span>'
        ).join('');

        // Navigation
        document.querySelector('.promo-prev').onclick = () => goToSlide(currentSlide - 1);
        document.querySelector('.promo-next').onclick = () => goToSlide(currentSlide + 1);
        dots.onclick = (e) => {
          if (e.target.classList.contains('promo-dot')) {
            goToSlide(parseInt(e.target.dataset.index));
          }
        };

        // Touch/drag support
        track.addEventListener('touchstart', onStart, {passive: true});
        track.addEventListener('touchmove', onMove, {passive: false});
        track.addEventListener('touchend', onEnd);
        track.addEventListener('mousedown', onStart);
        track.addEventListener('mousemove', onMove);
        track.addEventListener('mouseup', onEnd);
        track.addEventListener('mouseleave', () => { if(isDragging) { isDragging=false; goToSlide(currentSlide); }});

        // Prevent link clicks after drag
        document.getElementById('promoCarousel').addEventListener('click', function(e) {
          if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; }
        }, true);

        startAutoplay();
      }

      function goToSlide(index) {
        currentSlide = ((index % slideCount) + slideCount) % slideCount;
        const track = document.getElementById('promoTrack');
        track.style.transition = 'transform 0.4s ease';
        track.style.transform = 'translateX(-' + (currentSlide * 100) + '%)';
        document.querySelectorAll('.promo-dot').forEach((dot, i) => {
          dot.classList.toggle('active', i === currentSlide);
        });
        resetAutoplay();
      }

      function resetAutoplay() {
        clearInterval(autoplayInterval);
        autoplayInterval = setInterval(() => goToSlide(currentSlide + 1), 5000);
      }

      function startAutoplay() { resetAutoplay(); }

      function getX(e) { return e.touches ? e.touches[0].clientX : e.clientX; }
      function getY(e) { return e.touches ? e.touches[0].clientY : e.clientY; }

      function onStart(e) {
        startX = getX(e); startY = getY(e);
        isDragging = true; moved = false;
        document.getElementById('promoTrack').style.transition = 'none';
        clearInterval(autoplayInterval);
      }

      function onMove(e) {
        if (!isDragging) return;
        const dx = getX(e) - startX, dy = getY(e) - startY;
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
          e.preventDefault(); moved = true;
          document.getElementById('promoTrack').style.transform = 'translateX(calc(-' + (currentSlide * 100) + '% + ' + dx + 'px))';
        } else if (Math.abs(dy) > 10) {
          isDragging = false;
        }
      }

      function onEnd(e) {
        if (!isDragging) return;
        isDragging = false;
        const dx = (e.changedTouches ? e.changedTouches[0].clientX : e.clientX) - startX;
        if (Math.abs(dx) > threshold) {
          goToSlide(dx < 0 ? currentSlide + 1 : currentSlide - 1);
        } else {
          goToSlide(currentSlide);
        }
      }

      loadBanners();
    })();
  </script>
</body>
</html>
  `);
});

// Start server
app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Dutchie Banner API running on port ${PORT}`);
  console.log(`API Key protection: ${API_KEY ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`Scrape interval: ${SCRAPE_INTERVAL / 60000} minutes`);

  // Initial scrape on startup
  console.log('[STARTUP] Running initial scrape...');
  performScrape().catch(() => {});

  // Schedule periodic scrapes
  scheduleNextScrape();
});
