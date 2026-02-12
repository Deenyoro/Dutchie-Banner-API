const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data', 'banners.json');
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000; // 5 seconds

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Scrape banner images from the carousel at a given viewport size.
 * Clicks through all carousel slides and returns an array of banner objects.
 */
async function scrapeAtViewport(page, url, width, height, userAgent) {
  await page.setViewport({ width, height });
  await page.setUserAgent(userAgent);

  await page.goto(url, {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  // Wait for banner images to load
  await page.waitForSelector('img[class*="menu-image__MainImage"]', { timeout: 30000 });

  // Give React a moment to finish rendering initial slides
  await sleep(3000);

  // Collect banners by clicking through the carousel to reveal all slides.
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
      banners.push(b);
    }
  }

  // Gather whatever is in the DOM initially
  addNewBanners(await collectVisibleBanners());

  // Click through carousel to reveal slides that aren't initially in the DOM.
  // On mobile viewports Dutchie renders all banners at once (no carousel nav),
  // so we check if the next button is actually visible before attempting clicks.
  const nextBtn = await page.$('button[class*="arrow"][class*="right"], button[class*="arrow"][class*="next"], button[class*="Next"], [class*="carousel"] button:last-of-type, [class*="banner"] button:last-of-type');

  let useButton = false;
  if (nextBtn) {
    useButton = await page.evaluate(el => {
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }, nextBtn);
  }

  if (useButton) {
    const MAX_CLICKS = 20;
    let stableRounds = 0;
    for (let click = 0; click < MAX_CLICKS; click++) {
      const before = banners.length;
      try {
        await nextBtn.click();
      } catch {
        break;
      }
      await sleep(1000);
      addNewBanners(await collectVisibleBanners());
      if (banners.length === before) {
        stableRounds++;
        if (stableRounds >= 3) break;
      } else {
        stableRounds = 0;
      }
    }
  }

  return banners;
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

    // Pass 1: Desktop at 1400x900
    console.log(`[${new Date().toISOString()}] Pass 1: Desktop (1400x900)`);
    const desktopBanners = await scrapeAtViewport(page, url, 1400, 900, DESKTOP_UA);

    if (!desktopBanners || desktopBanners.length === 0) {
      throw new Error('No banners found on page');
    }

    console.log(`[${new Date().toISOString()}] Desktop pass found ${desktopBanners.length} banners`);

    // Assign IDs to desktop banners (canonical)
    const banners = desktopBanners.map((b, i) => ({
      id: `banner-${i}`,
      ...b
    }));

    // Pass 2: Mobile at 390x844
    try {
      console.log(`[${new Date().toISOString()}] Pass 2: Mobile (390x844)`);
      const mobileBanners = await scrapeAtViewport(page, url, 390, 844, MOBILE_UA);
      console.log(`[${new Date().toISOString()}] Mobile pass found ${mobileBanners.length} banners`);

      // Merge mobile results by index
      for (let i = 0; i < banners.length; i++) {
        if (i < mobileBanners.length) {
          const mb = mobileBanners[i];
          // Only set mobile fields if the image is actually different from desktop
          const desktopBase = banners[i].src.split('?')[0];
          const mobileBase = mb.src.split('?')[0];
          if (mobileBase !== desktopBase) {
            banners[i].mobileSrc = mb.src;
            banners[i].mobileSrcset = mb.srcset;
            banners[i].mobileWidth = mb.width;
            banners[i].mobileHeight = mb.height;
          } else {
            // Same image — fall back to desktop (no mobile fields)
            banners[i].mobileSrc = null;
            banners[i].mobileSrcset = null;
            banners[i].mobileWidth = null;
            banners[i].mobileHeight = null;
          }
        } else {
          // Fewer mobile banners than desktop — fall back to desktop
          banners[i].mobileSrc = null;
          banners[i].mobileSrcset = null;
          banners[i].mobileWidth = null;
          banners[i].mobileHeight = null;
        }
      }
    } catch (mobileErr) {
      console.warn(`[${new Date().toISOString()}] Mobile pass failed, using desktop images only: ${mobileErr.message}`);
      // Set null mobile fields so consumers know mobile wasn't captured
      for (const b of banners) {
        b.mobileSrc = null;
        b.mobileSrcset = null;
        b.mobileWidth = null;
        b.mobileHeight = null;
      }
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

    // Check if data is stale (older than 45 minutes)
    const scrapedAt = new Date(parsed.scrapedAt);
    const ageMs = Date.now() - scrapedAt.getTime();
    const staleThreshold = 45 * 60 * 1000;

    if (ageMs > staleThreshold && !isRefreshing) {
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
