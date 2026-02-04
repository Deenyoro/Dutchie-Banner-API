const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { scrapeBanners, getBanners } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;
const SCRAPE_INTERVAL = (parseInt(process.env.SCRAPE_INTERVAL_MINUTES) || 60) * 60 * 1000;

// API Key from environment variable
const API_KEY = process.env.API_KEY;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['*'];

// Enable CORS for configured domains
app.use(cors({
  origin: ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS,
  methods: ['GET']
}));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - Key header: ${req.headers['x-api-key'] ? 'present' : 'missing'}, Query key: ${req.query.key ? 'present' : 'missing'}`);
  next();
});

// API Key validation middleware
const validateApiKey = (req, res, next) => {
  // Skip validation if no API_KEY is configured
  if (!API_KEY) {
    return next();
  }

  const providedKey = req.headers['x-api-key'] || req.query.key;

  if (!providedKey) {
    console.log(`[${new Date().toISOString()}] 401 - No API key provided`);
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'API key required. Provide via X-API-Key header or ?key= parameter'
    });
  }

  // Simple string comparison (keys are already random, timing attacks not a concern)
  if (providedKey !== API_KEY) {
    console.log(`[${new Date().toISOString()}] 403 - Invalid API key (length: ${providedKey.length} vs ${API_KEY.length})`);
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Invalid API key'
    });
  }

  next();
};

// Health check (no auth required)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get cached banners (requires API key)
app.get('/api/banners', validateApiKey, async (req, res) => {
  try {
    const data = await getBanners();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get banners', message: error.message });
  }
});

// Force a fresh scrape (requires API key)
app.get('/api/banners/refresh', validateApiKey, async (req, res) => {
  try {
    const data = await scrapeBanners();
    res.json(data);
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
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; }
    .promo-carousel {
      width: 100%;
      overflow: hidden;
      position: relative;
    }
    .promo-track {
      display: flex;
      transition: transform 0.5s ease;
    }
    .promo-slide {
      min-width: 100%;
      flex-shrink: 0;
    }
    .promo-slide img {
      width: 100%;
      height: auto;
      display: block;
    }
    .promo-slide a {
      display: block;
    }
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
  </style>
</head>
<body>
  <div class="promo-carousel" id="promoCarousel">
    <div class="promo-track" id="promoTrack"></div>
    <div class="promo-dots" id="promoDots"></div>
  </div>

  <script>
    (function() {
      const API_KEY = '${apiKey}';
      const API_URL = window.location.origin + '/api/banners' + (API_KEY ? '?key=' + API_KEY : '');
      let currentSlide = 0;
      let slideCount = 0;
      let autoplayInterval;

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

        dots.addEventListener('click', (e) => {
          if (e.target.classList.contains('promo-dot')) {
            goToSlide(parseInt(e.target.dataset.index));
          }
        });

        startAutoplay();
      }

      function goToSlide(index) {
        currentSlide = index;
        document.getElementById('promoTrack').style.transform = 'translateX(-' + (index * 100) + '%)';
        document.querySelectorAll('.promo-dot').forEach((dot, i) => {
          dot.classList.toggle('active', i === index);
        });
      }

      function nextSlide() {
        goToSlide((currentSlide + 1) % slideCount);
      }

      function startAutoplay() {
        if (autoplayInterval) clearInterval(autoplayInterval);
        autoplayInterval = setInterval(nextSlide, 5000);
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

  // Initial scrape on startup
  console.log('Running initial scrape...');
  scrapeBanners().catch(err => console.error('Initial scrape failed:', err.message));

  // Schedule periodic scrapes
  console.log(`Scheduling scrapes every ${SCRAPE_INTERVAL / 60000} minutes`);
  setInterval(() => {
    scrapeBanners().catch(err => console.error('Scheduled scrape failed:', err.message));
  }, SCRAPE_INTERVAL);
});
