/**
 * Collectr Scraper API - Vercel Serverless Function
 * 
 * POST /api/scrape-collectr
 * Body: { "url": "https://app.getcollectr.com/showcase/profile/..." }
 */

let chromium, puppeteer;

// Dynamic imports for serverless
async function getBrowser() {
  if (!chromium) {
    chromium = require('@sparticuz/chromium');
  }
  if (!puppeteer) {
    puppeteer = require('puppeteer-core');
  }
  
  // Minimize chromium size
  chromium.setHeadlessMode = true;
  chromium.setGraphicsMode = false;
  
  return await puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: 1280, height: 720 },
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });
}

// Extract showcase UUID from URL
function extractShowcaseId(url) {
  const patterns = [
    /showcase\/profile\/([a-f0-9-]+)/i,
    /getcollectr\.com\/showcase\/([a-f0-9-]+)/i,
    /^([a-f0-9-]{36})$/i
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// Main handler
module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }
  
  let body = req.body;
  
  // Parse body if it's a string
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid JSON body' 
      });
    }
  }
  
  const url = body?.url;
  
  if (!url) {
    return res.status(400).json({ 
      success: false,
      error: 'Missing URL',
      message: 'Please provide a Collectr showcase URL'
    });
  }
  
  const showcaseId = extractShowcaseId(url);
  if (!showcaseId) {
    return res.status(400).json({ 
      success: false,
      error: 'Invalid URL',
      message: 'Please provide a valid Collectr showcase URL (e.g., https://app.getcollectr.com/showcase/profile/...)'
    });
  }
  
  const fullUrl = `https://app.getcollectr.com/showcase/profile/${showcaseId}`;
  
  let browser = null;
  
  try {
    console.log(`[Collectr] Starting scrape: ${fullUrl}`);
    
    browser = await getBrowser();
    const page = await browser.newPage();
    
    // Set user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Intercept API responses
    let apiData = null;
    page.on('response', async (response) => {
      const respUrl = response.url();
      // Look for Collectr's internal API calls
      if (respUrl.includes('api') && (respUrl.includes('showcase') || respUrl.includes('portfolio') || respUrl.includes('item'))) {
        try {
          const contentType = response.headers()['content-type'] || '';
          if (contentType.includes('application/json')) {
            const json = await response.json();
            if (json && (json.cards || json.items || json.portfolio || json.products || Array.isArray(json))) {
              apiData = json;
              console.log('[Collectr] Intercepted API data');
            }
          }
        } catch (e) {
          // Not JSON or parsing failed, ignore
        }
      }
    });
    
    // Navigate
    console.log('[Collectr] Navigating to page...');
    await page.goto(fullUrl, { 
      waitUntil: 'networkidle0',
      timeout: 30000 
    });
    
    // Wait for content to render
    await page.waitForTimeout(2000);
    
    // Scroll to trigger lazy loading
    console.log('[Collectr] Scrolling to load content...');
    let previousHeight = 0;
    let scrollAttempts = 0;
    
    while (scrollAttempts < 8) {
      const currentHeight = await page.evaluate(() => document.body.scrollHeight);
      if (currentHeight === previousHeight) break;
      
      previousHeight = currentHeight;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(600);
      scrollAttempts++;
    }
    
    // If we intercepted API data, use it
    if (apiData) {
      console.log('[Collectr] Using intercepted API data');
      await browser.close();
      
      const cards = normalizeApiData(apiData);
      
      return res.status(200).json({
        success: true,
        source: 'api',
        sourceUrl: fullUrl,
        importedAt: new Date().toISOString(),
        cardCount: cards.length,
        cards
      });
    }
    
    // Fallback: scrape from DOM
    console.log('[Collectr] Scraping from DOM...');
    const scrapedData = await page.evaluate(() => {
      const results = {
        profileName: null,
        totalValue: null,
        cards: []
      };
      
      // Profile name
      const h1 = document.querySelector('h1');
      if (h1) results.profileName = h1.textContent.trim();
      
      // Pokemon sets regex
      const pokemonSets = /\b(Prismatic Evolutions|Surging Sparks|Stellar Crown|Shrouded Fable|Twilight Masquerade|Temporal Forces|Paldean Fates|Paradox Rift|151|Obsidian Flames|Paldea Evolved|Scarlet & Violet|Crown Zenith|Silver Tempest|Lost Origin|Pokemon GO|Astral Radiance|Brilliant Stars|Fusion Strike|Celebrations|Evolving Skies|Chilling Reign|Battle Styles|Shining Fates|Vivid Voltage|Darkness Ablaze|Sword & Shield|Hidden Fates|Unified Minds|Team Up|Lost Thunder|Celestial Storm|Ultra Prism|Burning Shadows|Sun & Moon|Evolutions|XY|Base Set|Jungle|Fossil|Team Rocket|Neo Genesis)\b/i;
      
      // Find card containers
      const containers = document.querySelectorAll('[class*="card"], [class*="item"], [class*="product"], article');
      
      containers.forEach(el => {
        // Skip nested containers
        if (el.querySelectorAll('[class*="card"], [class*="item"]').length > 3) return;
        
        const text = el.textContent || '';
        const card = {};
        
        // Name from heading or title class
        const nameEl = el.querySelector('h2, h3, h4, [class*="name"], [class*="title"]');
        if (nameEl) {
          card.name = nameEl.textContent.trim();
        }
        
        // Skip if no name or name is too short/generic
        if (!card.name || card.name.length < 3) return;
        
        // Set
        const setMatch = text.match(pokemonSets);
        if (setMatch) card.set = setMatch[1];
        
        // Card number
        const numMatch = text.match(/(\d{1,3})\s*\/\s*(\d{1,3})/);
        if (numMatch) card.number = `${numMatch[1]}/${numMatch[2]}`;
        
        // Price
        const priceMatch = text.match(/\$\s*([\d,]+\.?\d*)/);
        if (priceMatch) card.marketPrice = parseFloat(priceMatch[1].replace(/,/g, ''));
        
        // Image
        const img = el.querySelector('img[src*="card"], img[src*="product"], img[src*="pokemon"], img:not([src*="avatar"]):not([src*="profile"])');
        if (img && img.src) card.image = img.src;
        
        // Condition
        const condMatch = text.match(/\b(NM|LP|MP|HP|DMG|Mint|Near Mint|Lightly Played)\b/i);
        card.condition = condMatch ? condMatch[1] : 'NM';
        
        // Quantity
        const qtyMatch = text.match(/(?:qty|quantity|×|x)\s*:?\s*(\d+)/i);
        card.quantity = qtyMatch ? parseInt(qtyMatch[1]) : 1;
        
        results.cards.push(card);
      });
      
      return results;
    });
    
    await browser.close();
    console.log(`[Collectr] Found ${scrapedData.cards.length} cards from DOM`);
    
    // Dedupe by name
    const seen = new Set();
    const cards = scrapedData.cards.filter(card => {
      const key = `${card.name}-${card.set || ''}-${card.number || ''}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    
    return res.status(200).json({
      success: true,
      source: 'dom',
      sourceUrl: fullUrl,
      profileName: scrapedData.profileName,
      importedAt: new Date().toISOString(),
      cardCount: cards.length,
      cards
    });
    
  } catch (error) {
    console.error('[Collectr] Error:', error);
    
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
    
    // Return proper JSON error
    return res.status(500).json({
      success: false,
      error: 'Scraping failed',
      message: error.message || 'Unknown error occurred'
    });
  }
};

// Normalize API response formats
function normalizeApiData(data) {
  let items = [];
  
  if (Array.isArray(data)) {
    items = data;
  } else if (data.cards) {
    items = data.cards;
  } else if (data.items) {
    items = data.items;
  } else if (data.products) {
    items = data.products;
  } else if (data.portfolio?.items) {
    items = data.portfolio.items;
  } else if (data.data?.items) {
    items = data.data.items;
  } else if (data.data && Array.isArray(data.data)) {
    items = data.data;
  }
  
  return items.map(item => ({
    name: item.name || item.productName || item.title || item.cardName || null,
    set: item.set || item.setName || item.expansion || item.series || null,
    number: item.number || item.cardNumber || item.collectorNumber || null,
    condition: item.condition || item.grade || 'NM',
    quantity: item.quantity || item.qty || item.count || 1,
    marketPrice: item.price || item.marketPrice || item.value || item.tcgPrice || null,
    image: item.image || item.imageUrl || item.img || item.thumbnail || null
  })).filter(card => card.name);
}
