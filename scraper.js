const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data', 'banners.json');
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000; // 5 seconds

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function scrapeBanners(retryCount = 0) {
  const url = process.env.DUTCHIE_URL;

  if (!url) {
    throw new Error('DUTCHIE_URL environment variable is required. Set it to your Dutchie embedded menu URL.');
  }

  console.log(`[${new Date().toISOString()}] Starting scrape of: ${url}${retryCount > 0 ? ` (retry ${retryCount}/${MAX_RETRIES})` : ''}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });

    const page = await browser.newPage();

    // Set viewport to ensure banners render properly
    await page.setViewport({ width: 1400, height: 900 });

    // Set a realistic user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Block unnecessary resources to speed up loading
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (['font', 'stylesheet'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    // Wait for banner images to load - they use these class patterns
    await page.waitForSelector('img[class*="menu-image__MainImage"]', { timeout: 30000 });

    // Give React a moment to finish rendering all slides
    await sleep(3000);

    // Extract banner data
    const banners = await page.evaluate(() => {
      const images = document.querySelectorAll('img[class*="menu-image__MainImage"]');
      const results = [];
      const seenUrls = new Set();

      images.forEach((img, index) => {
        // Get the base image URL (strip query params for deduplication)
        const srcUrl = img.src;
        const baseUrl = srcUrl.split('?')[0];

        // Skip duplicates (carousel often clones slides)
        if (seenUrls.has(baseUrl)) return;
        seenUrls.add(baseUrl);

        // Get the link wrapper if exists
        const link = img.closest('a');

        results.push({
          id: `banner-${results.length}`,
          src: srcUrl,
          srcset: img.srcset || null,
          alt: img.alt || '',
          link: link ? link.href : null,
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height
        });
      });

      return results;
    });

    // Validate we got banners
    if (!banners || banners.length === 0) {
      throw new Error('No banners found on page');
    }

    // Validate image URLs are accessible (quick check)
    for (const banner of banners) {
      if (!banner.src || !banner.src.startsWith('http')) {
        console.warn(`[${new Date().toISOString()}] Warning: Invalid banner URL: ${banner.src}`);
      }
    }

    const result = {
      banners,
      scrapedAt: new Date().toISOString(),
      source: url,
      count: banners.length
    };

    // Ensure data directory exists
    const dataDir = path.dirname(DATA_FILE);
    try {
      await fs.access(dataDir);
    } catch {
      await fs.mkdir(dataDir, { recursive: true });
    }

    // Save to file
    await fs.writeFile(DATA_FILE, JSON.stringify(result, null, 2));

    console.log(`[${new Date().toISOString()}] Scraped ${banners.length} banners successfully`);

    return result;

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Scrape failed:`, error.message);

    // Retry logic
    if (retryCount < MAX_RETRIES) {
      console.log(`[${new Date().toISOString()}] Retrying in ${RETRY_DELAY/1000} seconds...`);
      await sleep(RETRY_DELAY);
      if (browser) {
        try { await browser.close(); } catch (e) {}
      }
      return scrapeBanners(retryCount + 1);
    }

    throw error;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error(`[${new Date().toISOString()}] Error closing browser:`, e.message);
      }
    }
  }
}

async function getBanners() {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(data);

    // Check if data is stale (older than 2 hours)
    const scrapedAt = new Date(parsed.scrapedAt);
    const ageMs = Date.now() - scrapedAt.getTime();
    const twoHours = 2 * 60 * 60 * 1000;

    if (ageMs > twoHours) {
      console.log(`[${new Date().toISOString()}] Cache is ${Math.round(ageMs/60000)} minutes old, triggering refresh`);
      // Return stale data but trigger refresh in background
      scrapeBanners().catch(err => console.error('Background refresh failed:', err.message));
    }

    return parsed;
  } catch (error) {
    // If no cached data, scrape now
    console.log(`[${new Date().toISOString()}] No cached data, scraping now...`);
    return await scrapeBanners();
  }
}

module.exports = { scrapeBanners, getBanners };
