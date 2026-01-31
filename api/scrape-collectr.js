/**
 * Collectr Scraper API - Vercel Serverless Function
 * 
 * Uses @sparticuz/chromium for serverless-compatible Puppeteer
 * 
 * POST /api/scrape-collectr
 * Body: { "url": "https://app.getcollectr.com/showcase/profile/..." }
 */

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

// Extract showcase UUID from URL
function extractShowcaseId(url) {
  const patterns = [
    /showcase\/profile\/([a-f0-9-]+)/i,
    /getcollectr\.com\/([a-f0-9-]+)/i,
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
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  const { url } = req.body || {};
  
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
      message: 'Please provide a valid Collectr showcase URL'
    });
  }
  
  const fullUrl = `https://app.getcollectr.com/showcase/profile/${showcaseId}`;
  
  let browser = null;
  
  try {
    console.log(`[Collectr] Scraping: ${fullUrl}`);
    
    // Launch browser with serverless-optimized settings
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    
    const page = await browser.newPage();
    
    // Set viewport and user agent
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Intercept API calls to get raw data
    let apiData = null;
    page.on('response', async (response) => {
      const respUrl = response.url();
      if (respUrl.includes('/api/') && (respUrl.includes('showcase') || respUrl.includes('portfolio') || respUrl.includes('items'))) {
        try {
          const json = await response.json();
          if (json && (json.cards || json.items || json.portfolio || json.products || Array.isArray(json))) {
            apiData = json;
            console.log('[Collectr] Intercepted API data');
          }
        } catch (e) {
          // Not JSON, ignore
        }
      }
    });
    
    // Navigate to page
    await page.goto(fullUrl, { 
      waitUntil: 'networkidle2',
      timeout: 25000 
    });
    
    // Wait for content
    await new Promise(r => setTimeout(r, 3000));
    
    // Scroll to load all cards (infinite scroll)
    let previousHeight = 0;
    let scrollAttempts = 0;
    const maxScrollAttempts = 10;
    
    while (scrollAttempts < maxScrollAttempts) {
      const currentHeight = await page.evaluate(() => document.body.scrollHeight);
      
      if (currentHeight === previousHeight) break;
      
      previousHeight = currentHeight;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise(r => setTimeout(r, 800));
      scrollAttempts++;
    }
    
    // If we got API data, use that
    if (apiData) {
      await browser.close();
      
      // Normalize the data
      const cards = normalizeApiData(apiData);
      
      return res.status(200).json({
        success: true,
        source: 'api',
        sourceUrl: fullUrl,
        importedAt: new Date().toISOString(),
        cards
      });
    }
    
    // Otherwise scrape from DOM
    const scrapedData = await page.evaluate(() => {
      const results = {
        profileName: null,
        totalValue: null,
        cards: []
      };
      
      // Profile name
      const profileEl = document.querySelector('h1, [class*="profile"], [class*="username"]');
      if (profileEl) {
        results.profileName = profileEl.textContent.trim();
      }
      
      // Total value
      document.querySelectorAll('[class*="value"], [class*="total"], [class*="worth"]').forEach(el => {
        const match = el.textContent.match(/\$[\d,]+\.?\d*/);
        if (match && !results.totalValue) {
          results.totalValue = match[0];
        }
      });
      
      // Find card elements
      const selectors = [
        '[class*="card-item"]',
        '[class*="portfolio-item"]',
        '[class*="collection-item"]',
        '[class*="product-card"]',
        '[data-card]',
        'article'
      ];
      
      let cardElements = [];
      for (const selector of selectors) {
        const found = document.querySelectorAll(selector);
        if (found.length > cardElements.length) {
          cardElements = found;
        }
      }
      
      // Pokemon set names for matching
      const pokemonSets = /\b(Prismatic Evolutions|Surging Sparks|Stellar Crown|Shrouded Fable|Twilight Masquerade|Temporal Forces|Paldean Fates|Paradox Rift|151|Obsidian Flames|Paldea Evolved|Scarlet & Violet|Crown Zenith|Silver Tempest|Lost Origin|Pokemon GO|Astral Radiance|Brilliant Stars|Fusion Strike|Celebrations|Evolving Skies|Chilling Reign|Battle Styles|Shining Fates|Vivid Voltage|Champions Path|Darkness Ablaze|Rebel Clash|Sword & Shield|Cosmic Eclipse|Hidden Fates|Unified Minds|Unbroken Bonds|Team Up|Lost Thunder|Dragon Majesty|Celestial Storm|Forbidden Light|Ultra Prism|Crimson Invasion|Shining Legends|Burning Shadows|Guardians Rising|Sun & Moon|Evolutions|Steam Siege|Fates Collide|Generations|BREAKpoint|BREAKthrough|Ancient Origins|Roaring Skies|Double Crisis|Primal Clash|Phantom Forces|Furious Fists|Flashfire|XY|Base Set|Jungle|Fossil|Team Rocket|Gym Heroes|Gym Challenge|Neo Genesis|Neo Discovery|Neo Revelation|Neo Destiny)\b/i;
      
      cardElements.forEach(el => {
        // Skip containers with many nested items
        if (el.querySelectorAll('[class*="card"], [class*="item"]').length > 5) return;
        
        const card = {};
        const text = el.textContent;
        
        // Name
        const nameEl = el.querySelector('h2, h3, h4, [class*="name"], [class*="title"]');
        if (nameEl) card.name = nameEl.textContent.trim();
        
        // Set
        const setMatch = text.match(pokemonSets) || text.match(/(?:Set|Expansion):\s*([^\n\r,]+)/i);
        if (setMatch) card.set = setMatch[1].trim();
        
        // Number
        const numMatch = text.match(/#?\s*(\d{1,3})\s*\/\s*(\d{1,3})/);
        if (numMatch) card.number = `${numMatch[1]}/${numMatch[2]}`;
        
        // Price
        const priceMatch = text.match(/\$[\d,]+\.?\d*/);
        if (priceMatch) card.marketPrice = parseFloat(priceMatch[0].replace(/[$,]/g, ''));
        
        // Image
        const img = el.querySelector('img');
        if (img && img.src && !img.src.includes('avatar')) card.image = img.src;
        
        // Condition
        const condMatch = text.match(/\b(NM|LP|MP|HP|DMG|Mint|Near Mint|Lightly Played|Moderately Played|Heavily Played|Damaged)\b/i);
        card.condition = condMatch ? condMatch[1] : 'NM';
        
        // Quantity
        const qtyMatch = text.match(/(?:Qty|×|x)\s*:?\s*(\d+)/i);
        card.quantity = qtyMatch ? parseInt(qtyMatch[1]) : 1;
        
        if (card.name && card.name.length > 2) {
          results.cards.push(card);
        }
      });
      
      return results;
    });
    
    await browser.close();
    
    // Dedupe
    const seen = new Set();
    const cards = scrapedData.cards.filter(card => {
      const key = `${card.name}-${card.set || ''}-${card.number || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    
    return res.status(200).json({
      success: true,
      source: 'dom',
      sourceUrl: fullUrl,
      profileName: scrapedData.profileName,
      totalValue: scrapedData.totalValue,
      importedAt: new Date().toISOString(),
      cards
    });
    
  } catch (error) {
    console.error('[Collectr] Error:', error.message);
    
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
    
    return res.status(500).json({
      success: false,
      error: 'Scraping failed',
      message: error.message
    });
  }
};

// Normalize API response data
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
  }
  
  return items.map(item => ({
    name: item.name || item.productName || item.title || null,
    set: item.set || item.setName || item.expansion || null,
    number: item.number || item.cardNumber || item.collectorNumber || null,
    condition: item.condition || 'NM',
    quantity: item.quantity || item.qty || 1,
    marketPrice: item.price || item.marketPrice || item.value || null,
    image: item.image || item.imageUrl || item.img || null
  })).filter(card => card.name);
}
