const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { scrapeBanners, getBanners } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;
const SCRAPE_INTERVAL = (parseInt(process.env.SCRAPE_INTERVAL_MINUTES) || 15) * 60 * 1000;
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

  if (providedKey.length !== API_KEY.length ||
      !crypto.timingSafeEqual(Buffer.from(providedKey), Buffer.from(API_KEY))) {
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
    if (!data) {
      return res.status(409).json({ error: 'Scrape already in progress' });
    }
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
  const apiKey = (req.query.key || '').replace(/[^a-zA-Z0-9_\-]/g, '');
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">
  <title>Promotions</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; }
    .promo-carousel {
      width: 100%;
      max-width: 100vw;
      overflow: hidden;
      position: relative;
      touch-action: pan-y pinch-zoom;
      cursor: grab;
      -webkit-user-select: none;
      user-select: none;
      -webkit-touch-callout: none;
      box-sizing: border-box;
    }
    .promo-carousel.dragging { cursor: grabbing; }
    .promo-track {
      display: flex;
      transition: transform 0.4s ease;
    }
    .promo-slide {
      min-width: 100%;
      max-width: 100%;
      flex-shrink: 0;
      overflow: hidden;
      box-sizing: border-box;
    }
    .promo-slide img {
      width: 100% !important;
      max-width: 100% !important;
      height: auto !important;
      display: block;
      pointer-events: none;
      -webkit-user-drag: none;
      -webkit-touch-callout: none;
    }
    .promo-slide picture {
      display: block;
      width: 100%;
      max-width: 100%;
    }
    .promo-slide a {
      display: block;
      width: 100%;
      max-width: 100%;
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
      transition: all 0.3s;
    }
    .promo-dot.active {
      background: #004a71;
    }
    .promo-error {
      padding: 20px;
      text-align: center;
      color: #666;
    }
    .promo-counter {
      position: absolute;
      top: 8px;
      right: 8px;
      background: rgba(0,0,0,0.5);
      color: #fff;
      font-size: 12px;
      padding: 2px 10px;
      border-radius: 10px;
      z-index: 10;
      font-weight: 500;
      display: none;
    }
    .promo-zoom-lens {
      position: fixed;
      width: 250px;
      height: 250px;
      border-radius: 50%;
      border: 3px solid rgba(255,255,255,0.9);
      box-shadow: 0 4px 20px rgba(0,0,0,0.4);
      pointer-events: none;
      display: none;
      z-index: 10000;
      overflow: hidden;
      background-repeat: no-repeat;
      background-color: #000;
    }
    .promo-hint {
      position: absolute;
      bottom: 35px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0,0,0,0.6);
      color: #fff;
      font-size: 11px;
      padding: 4px 12px;
      border-radius: 12px;
      z-index: 10;
      pointer-events: none;
      white-space: nowrap;
      opacity: 0;
      transition: opacity 0.5s;
    }
    @media (max-width: 768px) {
      .promo-counter { display: block; }
      .promo-nav {
        padding: 10px 8px;
        font-size: 16px;
        background: rgba(0,0,0,0.3);
      }
      .promo-dots {
        position: absolute;
        bottom: 6px;
        left: 0;
        right: 0;
        padding: 0;
        pointer-events: none;
      }
      .promo-dot {
        width: 8px;
        height: 8px;
        margin: 0 4px;
        background: rgba(255,255,255,0.5);
        pointer-events: auto;
      }
      .promo-dot.active {
        background: #fff;
        transform: scale(1.3);
      }
      .promo-slide {
        aspect-ratio: 2 / 1;
      }
      .promo-slide img {
        object-fit: cover !important;
        height: 100% !important;
      }
    }
  </style>
</head>
<body>
  <div class="promo-carousel" id="promoCarousel">
    <div class="promo-track" id="promoTrack"></div>
    <button type="button" class="promo-nav promo-prev" aria-label="Previous">&lt;</button>
    <button type="button" class="promo-nav promo-next" aria-label="Next">&gt;</button>
    <div class="promo-counter" id="promoCounter"></div>
    <div class="promo-hint" id="promoHint"></div>
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
      var isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
      var carouselWidth = 0;

      // Zoom state
      var zoomTimer = null;
      var isZooming = false;
      var zoomImg = null;
      var ZOOM_DELAY = 400;
      var ZOOM_FACTOR = 3;
      var LENS_SIZE = 250;
      var savedScrollY = 0;

      // HTML escape helpers to prevent XSS from scraped data
      function escAttr(s) {
        return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      }
      function safeUrl(s) {
        if (!s) return '';
        try { var u = new URL(s); return (u.protocol === 'http:' || u.protocol === 'https:') ? escAttr(s) : ''; } catch(e) { return ''; }
      }

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

        if (slideCount === 0) {
          document.getElementById('promoCarousel').innerHTML =
            '<div class="promo-error">No promotions available</div>';
          return;
        }

        track.innerHTML = banners.map(b => {
          var safeSrc = safeUrl(b.src);
          var safeAlt = escAttr(b.alt || '');
          var safeLink = safeUrl(b.link);
          var safeMobileSrc = b.mobileSrc ? safeUrl(b.mobileSrc) : '';
          var safeMobileSrcset = b.mobileSrcset ? escAttr(b.mobileSrcset) : '';
          var mobileSource = '';
          if (safeMobileSrc) {
            mobileSource = '<source media="(max-width:768px)"' + (safeMobileSrcset ? ' srcset="' + safeMobileSrcset + '"' : ' srcset="' + safeMobileSrc + '"') + '>';
          }
          const img = '<picture>' + mobileSource + '<img src="' + safeSrc + '" alt="' + safeAlt + '" loading="lazy" draggable="false" style="width:100%!important;max-width:100%!important;display:block"></picture>';
          return '<div class="promo-slide">' +
            (safeLink ? '<a href="' + safeLink + '" target="_blank" rel="noopener" draggable="false" style="display:block;max-width:100%">' + img + '</a>' : img) +
            '</div>';
        }).join('');

        dots.innerHTML = banners.map((_, i) =>
          '<span class="promo-dot' + (i === 0 ? ' active' : '') + '" data-index="' + i + '"></span>'
        ).join('');

        // Update counter
        var counter = document.getElementById('promoCounter');
        if (counter && slideCount > 0) counter.textContent = '1 / ' + slideCount;

        // Navigation
        document.querySelector('.promo-prev').onclick = function() { goToSlide(currentSlide - 1); };
        document.querySelector('.promo-next').onclick = function() { goToSlide(currentSlide + 1); };
        dots.onclick = function(e) {
          if (e.target.classList.contains('promo-dot')) {
            goToSlide(parseInt(e.target.dataset.index));
          }
        };

        // Touch/drag support
        track.addEventListener('touchstart', onStart, {passive: true});
        track.addEventListener('touchmove', onMove, {passive: false});
        track.addEventListener('touchend', onEnd);
        track.addEventListener('touchcancel', function() {
          clearTimeout(zoomTimer);
          if (isZooming) { exitZoomMode(); }
          if (isDragging) { isDragging = false; goToSlide(currentSlide); }
          document.getElementById('promoCarousel').classList.remove('dragging');
        });
        track.addEventListener('mousedown', onStart);
        track.addEventListener('mousemove', onMove);
        track.addEventListener('mouseup', onEnd);
        track.addEventListener('mouseleave', function() { clearTimeout(zoomTimer); if(isDragging) { isDragging=false; goToSlide(currentSlide); }});

        // Prevent link clicks after drag or zoom
        document.getElementById('promoCarousel').addEventListener('click', function(e) {
          if (moved || isZooming) { e.preventDefault(); e.stopPropagation(); moved = false; }
        }, true);

        // Suppress iOS long-press context menu so hold-to-zoom works
        document.getElementById('promoCarousel').addEventListener('contextmenu', function(e) {
          e.preventDefault();
        });

        // Create zoom lens for touch devices
        if (isMobile) {
          var lens = document.createElement('div');
          lens.id = 'promoZoomLens';
          lens.className = 'promo-zoom-lens';
          document.body.appendChild(lens);
        }

        // Hide nav for single banner
        if (slideCount <= 1) {
          document.querySelector('.promo-prev').style.display = 'none';
          document.querySelector('.promo-next').style.display = 'none';
          document.getElementById('promoDots').style.display = 'none';
          var ctrEl = document.getElementById('promoCounter');
          if (ctrEl) ctrEl.style.display = 'none';
        }

        startAutoplay();

        // Show hint on mobile
        if (isMobile && slideCount >= 1) {
          setTimeout(function() {
            var hint = document.getElementById('promoHint');
            if (hint) {
              hint.textContent = slideCount > 1 ? 'Swipe \\u2190\\u2192  \\u2022  Hold to zoom' : 'Hold to zoom';
              hint.style.opacity = '1';
            }
          }, 800);
        }
      }

      function goToSlide(index) {
        if (slideCount <= 0) return;
        currentSlide = ((index % slideCount) + slideCount) % slideCount;
        var track = document.getElementById('promoTrack');
        track.style.transition = 'transform 0.4s ease';
        track.style.transform = 'translateX(-' + (currentSlide * 100) + '%)';
        document.querySelectorAll('.promo-dot').forEach(function(dot, i) {
          dot.classList.toggle('active', i === currentSlide);
        });
        var counter = document.getElementById('promoCounter');
        if (counter) counter.textContent = (currentSlide + 1) + ' / ' + slideCount;
        resetAutoplay();
      }

      function resetAutoplay() {
        clearInterval(autoplayInterval);
        if (slideCount > 1) {
          autoplayInterval = setInterval(function() { goToSlide(currentSlide + 1); }, 5000);
        }
      }

      function startAutoplay() { resetAutoplay(); }

      function getX(e) { return e.touches ? e.touches[0].clientX : e.clientX; }
      function getY(e) { return e.touches ? e.touches[0].clientY : e.clientY; }

      function onStart(e) {
        if (isZooming) return;
        startX = getX(e); startY = getY(e);
        isDragging = true; moved = false;
        carouselWidth = document.getElementById('promoCarousel').offsetWidth;
        document.getElementById('promoTrack').style.transition = 'none';
        document.getElementById('promoCarousel').classList.add('dragging');
        clearInterval(autoplayInterval);

        // Start zoom detection on touch (capture touch data now since event may be recycled)
        if (e.touches) {
          var touchData = {clientX: e.touches[0].clientX, clientY: e.touches[0].clientY};
          clearTimeout(zoomTimer);
          zoomTimer = setTimeout(function() {
            if (isDragging && !moved) {
              enterZoomMode(touchData);
            }
          }, ZOOM_DELAY);
        }
      }

      function onMove(e) {
        // Handle zoom movement
        if (isZooming) {
          if (e.touches) { e.preventDefault(); updateZoom(e.touches[0]); }
          return;
        }
        if (!isDragging) return;
        var dx = getX(e) - startX, dy = getY(e) - startY;
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
          e.preventDefault();
          document.getElementById('promoTrack').style.transform = 'translateX(calc(-' + (currentSlide * 100) + '% + ' + dx + 'px))';
          if (Math.abs(dx) > 20) { moved = true; clearTimeout(zoomTimer); }
        } else if (Math.abs(dy) > 30) {
          isDragging = false;
          clearTimeout(zoomTimer);
          document.getElementById('promoTrack').style.transform = 'translateX(-' + (currentSlide * 100) + '%)';
          document.getElementById('promoCarousel').classList.remove('dragging');
          resetAutoplay();
        }
      }

      function onEnd(e) {
        clearTimeout(zoomTimer);
        document.getElementById('promoCarousel').classList.remove('dragging');
        if (isZooming) { exitZoomMode(); return; }
        if (!isDragging) return;
        isDragging = false;
        var dx = (e.changedTouches ? e.changedTouches[0].clientX : e.clientX) - startX;
        var threshold = isMobile ? carouselWidth * 0.08 : carouselWidth * 0.15;
        if (Math.abs(dx) > threshold) {
          goToSlide(dx < 0 ? currentSlide + 1 : currentSlide - 1);
        } else {
          goToSlide(currentSlide);
        }
      }

      // === Press-and-hold zoom magnifier ===
      function lockScroll() {
        savedScrollY = window.scrollY;
        document.body.style.position = 'fixed';
        document.body.style.top = '-' + savedScrollY + 'px';
        document.body.style.left = '0';
        document.body.style.right = '0';
        document.body.style.overflow = 'hidden';
      }
      function unlockScroll() {
        document.body.style.position = '';
        document.body.style.top = '';
        document.body.style.left = '';
        document.body.style.right = '';
        document.body.style.overflow = '';
        window.scrollTo(0, savedScrollY);
      }

      function enterZoomMode(touch) {
        isDragging = false;
        isZooming = true;
        document.getElementById('promoCarousel').style.touchAction = 'none';
        lockScroll();
        var slides = document.querySelectorAll('.promo-slide');
        var currentSlideEl = slides[currentSlide];
        if (!currentSlideEl) { exitZoomMode(); return; }
        zoomImg = currentSlideEl.querySelector('img');
        if (!zoomImg) { exitZoomMode(); return; }
        var lens = document.getElementById('promoZoomLens');
        if (!lens) { exitZoomMode(); return; }
        lens.style.backgroundImage = 'url("' + (zoomImg.currentSrc || zoomImg.src) + '")';
        lens.style.display = 'block';
        // Snap track to current slide
        var track = document.getElementById('promoTrack');
        track.style.transition = 'none';
        track.style.transform = 'translateX(-' + (currentSlide * 100) + '%)';
        updateZoom(touch);
      }

      function updateZoom(touch) {
        var lens = document.getElementById('promoZoomLens');
        if (!lens || !zoomImg) return;
        var rect = zoomImg.getBoundingClientRect();
        // Account for object-fit:cover - calculate actual displayed image dimensions
        var nw = zoomImg.naturalWidth || rect.width, nh = zoomImg.naturalHeight || rect.height;
        var sc = Math.max(rect.width / nw, rect.height / nh);
        var dw = nw * sc, dh = nh * sc;
        var ox = (rect.width - dw) / 2, oy = (rect.height - dh) / 2;
        var relX = Math.max(0, Math.min(1, (touch.clientX - rect.left - ox) / dw));
        var relY = Math.max(0, Math.min(1, (touch.clientY - rect.top - oy) / dh));
        var bgW = dw * ZOOM_FACTOR;
        var bgH = dh * ZOOM_FACTOR;
        var bgX = -(relX * bgW - LENS_SIZE / 2);
        var bgY = -(relY * bgH - LENS_SIZE / 2);
        lens.style.backgroundSize = bgW + 'px ' + bgH + 'px';
        lens.style.backgroundPosition = bgX + 'px ' + bgY + 'px';
        // Position lens above finger, keep on screen
        var lensX = touch.clientX - LENS_SIZE / 2;
        var lensY = touch.clientY - LENS_SIZE - 40;
        lensX = Math.max(5, Math.min(window.innerWidth - LENS_SIZE - 5, lensX));
        if (lensY < 5) lensY = touch.clientY + 40;
        if (lensY + LENS_SIZE > window.innerHeight - 5) lensY = window.innerHeight - LENS_SIZE - 5;
        lens.style.left = lensX + 'px';
        lens.style.top = lensY + 'px';
      }

      function exitZoomMode() {
        isZooming = false;
        zoomImg = null;
        moved = true; // Prevent accidental link click after zoom
        document.getElementById('promoCarousel').style.touchAction = '';
        unlockScroll();
        var lens = document.getElementById('promoZoomLens');
        if (lens) lens.style.display = 'none';
        resetAutoplay();
      }

      // Clean up zoom state if user leaves page mid-zoom (tab switch, back button)
      document.addEventListener('visibilitychange', function() {
        if (document.hidden && isZooming) { exitZoomMode(); }
      });
      window.addEventListener('pagehide', function() {
        if (isZooming) { exitZoomMode(); }
      });

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
