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
        '--disable-features=TranslateUI'
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

    // Give React a moment to finish rendering initial slides
    await sleep(3000);

    // Collect banners by clicking through the carousel to reveal all slides.
    // Dutchie only renders a few slides in the DOM at a time, so we advance
    // the carousel and gather new images after each click.
    const seenBaseUrls = new Set();
    const banners = [];

    function collectVisibleBanners() {
      return page.evaluate(() => {
        const images = document.querySelectorAll('img[class*="menu-image__MainImage"]');
        return Array.from(images).map(img => {
          const link = img.closest('a');
          return {
            src: img.src,
            srcset: img.srcset || null,
            alt: img.alt || '',
            link: link ? link.href : null,
            width: img.naturalWidth || img.width,
            height: img.naturalHeight || img.height
          };
        });
      });
    }

    function addNewBanners(visible) {
      for (const b of visible) {
        const baseUrl = b.src.split('?')[0];
        if (seenBaseUrls.has(baseUrl)) continue;
        seenBaseUrls.add(baseUrl);
        banners.push({ id: `banner-${banners.length}`, ...b });
      }
    }

    // Gather whatever is in the DOM initially
    addNewBanners(await collectVisibleBanners());

    // Find the carousel next-arrow and click through remaining slides
    const nextBtn = await page.$('button[class*="arrow"][class*="right"], button[class*="arrow"][class*="next"], button[class*="Next"], [class*="carousel"] button:last-of-type, [class*="banner"] button:last-of-type');

    if (nextBtn) {
      const MAX_CLICKS = 20; // safety cap
      let stableRounds = 0;
      for (let click = 0; click < MAX_CLICKS; click++) {
        const before = banners.length;
        await nextBtn.click();
        await sleep(1000); // wait for slide transition + render
        addNewBanners(await collectVisibleBanners());
        if (banners.length === before) {
          stableRounds++;
          if (stableRounds >= 3) break; // no new banners after 3 consecutive clicks
        } else {
          stableRounds = 0;
        }
      }
    } else {
      console.log(`[${new Date().toISOString()}] No carousel next button found, using initially visible banners only`);
    }

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

    // Save to file atomically (write temp, then rename)
    const tmpFile = DATA_FILE + '.tmp';
    await fs.writeFile(tmpFile, JSON.stringify(result, null, 2));
    await fs.rename(tmpFile, DATA_FILE);

    console.log(`[${new Date().toISOString()}] Scraped ${banners.length} banners successfully`);

    return result;

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Scrape failed:`, error.message);

    // Retry logic - close browser before retry to free memory
    if (retryCount < MAX_RETRIES) {
      console.log(`[${new Date().toISOString()}] Retrying in ${RETRY_DELAY/1000} seconds...`);
      if (browser) {
        try { await browser.close(); } catch (e) {}
        browser = null; // Prevent double-close in finally
      }
      await sleep(RETRY_DELAY);
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

let isRefreshing = false;

async function getBanners() {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(data);

    // Check if data is stale (older than 2 hours)
    const scrapedAt = new Date(parsed.scrapedAt);
    const ageMs = Date.now() - scrapedAt.getTime();
    const twoHours = 2 * 60 * 60 * 1000;

    if (ageMs > twoHours && !isRefreshing) {
      console.log(`[${new Date().toISOString()}] Cache is ${Math.round(ageMs/60000)} minutes old, triggering refresh`);
      // Return stale data but trigger refresh in background
      isRefreshing = true;
      scrapeBanners()
        .catch(err => console.error('Background refresh failed:', err.message))
        .finally(() => { isRefreshing = false; });
    }

    return parsed;
  } catch (error) {
    // If no cached data, scrape now
    console.log(`[${new Date().toISOString()}] No cached data, scraping now...`);
    return await scrapeBanners();
  }
}

module.exports = { scrapeBanners, getBanners };

// CLI entrypoint: allow running directly with `node scraper.js`
if (require.main === module) {
  scrapeBanners()
    .then(result => {
      console.log(`Done. Scraped ${result.count} banners.`);
      process.exit(0);
    })
    .catch(err => {
      console.error('Scrape failed:', err.message);
      process.exit(1);
    });
}
