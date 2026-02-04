const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data', 'banners.json');

async function scrapeBanners() {
  const url = process.env.DUTCHIE_URL;

  if (!url) {
    throw new Error('DUTCHIE_URL environment variable is required. Set it to your Dutchie embedded menu URL.');
  }
  
  console.log(`[${new Date().toISOString()}] Starting scrape of: ${url}`);
  
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
        '--single-process'
      ]
    });

    const page = await browser.newPage();
    
    // Set viewport to ensure banners render properly
    await page.setViewport({ width: 1400, height: 900 });
    
    // Set a realistic user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await page.goto(url, { 
      waitUntil: 'networkidle2',
      timeout: 60000 
    });

    // Wait for banner images to load - they use these class patterns
    await page.waitForSelector('img[class*="menu-image__MainImage"]', { timeout: 30000 });
    
    // Give React a moment to finish rendering all slides
    await new Promise(r => setTimeout(r, 3000));

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
          id: `banner-${index}`,
          src: srcUrl,
          srcset: img.srcset || null,
          alt: img.alt || '',
          link: link ? link.href : null,
          width: img.width,
          height: img.height
        });
      });
      
      return results;
    });

    const result = {
      banners,
      scrapedAt: new Date().toISOString(),
      source: url,
      count: banners.length
    };

    // Save to file
    await fs.writeFile(DATA_FILE, JSON.stringify(result, null, 2));
    
    console.log(`[${new Date().toISOString()}] Scraped ${banners.length} banners successfully`);
    
    return result;

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Scrape failed:`, error.message);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function getBanners() {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    // If no cached data, scrape now
    return await scrapeBanners();
  }
}

module.exports = { scrapeBanners, getBanners };
