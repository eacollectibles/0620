
// buybackstep4.js - ENHANCED DIAGNOSTIC for Tag Searching
module.exports = async function handler(req, res) {
  console.log('=== SHOPIFY ENHANCED DIAGNOSTIC START ===');
  console.log('Method:', req.method);
  console.log('Body:', req.body);

  try {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }

    if (req.method === 'GET') {
      return res.status(200).json({
        success: true,
        message: 'Shopify Enhanced Diagnostic API is running',
        timestamp: new Date().toISOString()
      });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'POST method required' });
    }

    const { cards, employeeName, payoutMethod } = req.body;
    
    if (!cards || !Array.isArray(cards) || cards.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Cards array is required'
      });
    }

    const cardName = cards[0]?.cardName;
    console.log('🔍 ENHANCED SEARCH for:', cardName);

    // Your Shopify credentials
    const SHOPIFY_DOMAIN = "ke40sv-my.myshopify.com";
    const ACCESS_TOKEN = "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";

    // DIAGNOSTIC: Get first 10 products to see structure
    const diagnosticUrl = `https://${SHOPIFY_DOMAIN}/admin/api/2023-10/products.json?` +
      `limit=10&` +
      `fields=id,title,variants,product_type,tags,handle`;

    console.log('🔗 DIAGNOSTIC URL:', diagnosticUrl);

    const diagnosticResponse = await fetch(diagnosticUrl, {
      headers: {
        'X-Shopify-Access-Token': ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    });

    if (!diagnosticResponse.ok) {
      const errorText = await diagnosticResponse.text();
      console.log('❌ Shopify API error:', diagnosticResponse.status, errorText);
      throw new Error(`Shopify API failed: ${diagnosticResponse.status}`);
    }

    const diagnosticData = await diagnosticResponse.json();
    console.log('📊 DIAGNOSTIC: Found', diagnosticData.products?.length || 0, 'products');

    // Log detailed info about first few products
    const products = diagnosticData.products || [];
    const diagnosticInfo = [];

    products.slice(0, 5).forEach((product, index) => {
      console.log(`\n🔍 PRODUCT ${index + 1}:`);
      console.log(`  Title: "${product.title}"`);
      console.log(`  Handle: "${product.handle}"`);
      console.log(`  Tags: "${product.tags}"`);
      console.log(`  Product Type: "${product.product_type}"`);
      console.log(`  Variants (${product.variants?.length || 0}):`);
      
      const variantInfo = [];
      product.variants?.forEach((variant, vIndex) => {
        console.log(`    Variant ${vIndex + 1}:`);
        console.log(`      SKU: "${variant.sku || 'NO SKU'}"`);
        console.log(`      Price: $${variant.price || 'NO PRICE'}"`);
        console.log(`      Title: "${variant.title || 'NO TITLE'}"`);
        
        variantInfo.push({
          sku: variant.sku,
          price: variant.price,
          title: variant.title
        });
      });

      diagnosticInfo.push({
        title: product.title,
        handle: product.handle,
        tags: product.tags,
        productType: product.product_type,
        variants: variantInfo
      });
    });

    // Now search ALL products (increased limit)
    console.log(`\n🎯 SEARCHING FOR: "${cardName}"`);
    
    let foundProducts = [];
    let allProducts = [];
    let page = 1;
    const limit = 250;
    
    // Paginate through ALL products
    while (true) {
      const pageUrl = `https://${SHOPIFY_DOMAIN}/admin/api/2023-10/products.json?` +
        `limit=${limit}&` +
        `page=${page}&` +
        `fields=id,title,variants,product_type,tags,handle`;

      console.log(`📄 Fetching page ${page}...`);

      const pageResponse = await fetch(pageUrl, {
        headers: {
          'X-Shopify-Access-Token': ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      });

      if (!pageResponse.ok) {
        console.log(`❌ Failed to fetch page ${page}`);
        break;
      }

      const pageData = await pageResponse.json();
      const pageProducts = pageData.products || [];
      
      if (pageProducts.length === 0) {
        console.log(`📄 Page ${page} empty - stopping pagination`);
        break;
      }
      
      allProducts = allProducts.concat(pageProducts);
      console.log(`📄 Page ${page}: ${pageProducts.length} products (Total: ${allProducts.length})`);
      
      // Stop if we got less than the limit (last page)
      if (pageProducts.length < limit) {
        break;
      }
      
      page++;
      
      // Safety limit to prevent infinite loops
      if (page > 20) {
        console.log('⚠️ Stopping at page 20 for safety');
        break;
      }
    }
      
    console.log(`📦 Total products to search: ${allProducts.length}`);
    
    // Enhanced search strategies with detailed logging
    const searchStrategies = [
      { 
        name: 'Exact Title', 
        test: (p) => {
          const match = p.title.toLowerCase() === cardName.toLowerCase();
          if (match) console.log(`  ✅ Title exact match: "${p.title}"`);
          return match;
        }
      },
      { 
        name: 'Title Contains', 
        test: (p) => {
          const match = p.title.toLowerCase().includes(cardName.toLowerCase());
          if (match) console.log(`  ✅ Title contains: "${p.title}" contains "${cardName}"`);
          return match;
        }
      },
      { 
        name: 'SKU Exact', 
        test: (p) => {
          const match = p.variants.some(v => v.sku === cardName);
          if (match) {
            const matchingVariant = p.variants.find(v => v.sku === cardName);
            console.log(`  ✅ SKU exact match: "${matchingVariant.sku}" in "${p.title}"`);
          }
          return match;
        }
      },
      { 
        name: 'SKU Contains', 
        test: (p) => {
          const match = p.variants.some(v => v.sku && v.sku.toLowerCase().includes(cardName.toLowerCase()));
          if (match) {
            const matchingVariant = p.variants.find(v => v.sku && v.sku.toLowerCase().includes(cardName.toLowerCase()));
            console.log(`  ✅ SKU contains: "${matchingVariant.sku}" contains "${cardName}" in "${p.title}"`);
          }
          return match;
        }
      },
      { 
        name: 'Tags Contains', 
        test: (p) => {
          if (!p.tags) return false;
          
          console.log(`  🏷️ Checking tags: "${p.tags}" for "${cardName}"`);
          
          // Try multiple tag search approaches
          const searches = [
            p.tags.toLowerCase().includes(cardName.toLowerCase()),
            p.tags.split(',').some(tag => tag.trim().toLowerCase() === cardName.toLowerCase()),
            p.tags.split(',').some(tag => tag.trim().toLowerCase().includes(cardName.toLowerCase()))
          ];
          
          const match = searches.some(s => s);
          
          if (match) {
            console.log(`  ✅ Tags match found: "${p.tags}" contains "${cardName}" in "${p.title}"`);
          }
          
          return match;
        }
      },
      { 
        name: 'Handle Contains', 
        test: (p) => {
          const searchHandle = cardName.toLowerCase().replace(/[^a-z0-9]/g, '-');
          const match = p.handle.includes(searchHandle);
          if (match) console.log(`  ✅ Handle contains: "${p.handle}" contains "${searchHandle}"`);
          return match;
        }
      },
      { 
        name: 'Card Number Pattern', 
        test: (p) => {
          const cardNum = cardName.split('/')[0]; // Get "001" from "001/182"
          const setNum = cardName.split('/')[1]; // Get "182" from "001/182"
          
          const titleMatch = p.title.toLowerCase().includes(cardNum.toLowerCase());
          const skuMatch = p.variants.some(v => v.sku && v.sku.includes(cardNum));
          const tagMatch = p.tags && (
            p.tags.includes(cardNum) || 
            p.tags.includes(cardName) ||
            (setNum && p.tags.includes(setNum))
          );
          
          const match = titleMatch || skuMatch || tagMatch;
          
          if (match) {
            console.log(`  ✅ Card pattern match: "${cardName}" found in "${p.title}"`);
            if (titleMatch) console.log(`    - Found in title`);
            if (skuMatch) console.log(`    - Found in SKU`);
            if (tagMatch) console.log(`    - Found in tags: "${p.tags}"`);
          }
          
          return match;
        }
      }
    ];

    // Run each search strategy
    searchStrategies.forEach(strategy => {
      console.log(`\n🔍 Testing ${strategy.name}:`);
      const matches = allProducts.filter(strategy.test);
      console.log(`🔍 ${strategy.name}: ${matches.length} matches`);
      
      if (matches.length > 0) {
        matches.slice(0, 3).forEach(match => {
          console.log(`  📋 "${match.title}"`);
          console.log(`    Tags: "${match.tags}"`);
          match.variants?.forEach(v => {
            if (v.sku) console.log(`    SKU: "${v.sku}" - Price: $${v.price}`);
          });
        });
        foundProducts = foundProducts.concat(matches);
      }
    });

    // Remove duplicates
    foundProducts = foundProducts.filter((product, index, self) => 
      index === self.findIndex(p => p.id === product.id)
    );

    // If still no matches, show sample tags for debugging
    if (foundProducts.length === 0) {
      console.log('\n🔍 NO MATCHES FOUND - Sample tags from products:');
      allProducts.slice(0, 10).forEach((p, i) => {
        if (p.tags) {
          console.log(`  Product ${i+1}: "${p.title}" - Tags: "${p.tags}"`);
        }
      });
    }

    const response = {
      success: true,
      diagnostic: {
        searchQuery: cardName,
        totalProductsInStore: allProducts.length,
        sampleProducts: diagnosticInfo,
        searchResults: foundProducts.length,
        foundProducts: foundProducts.slice(0, 3).map(p => ({
          title: p.title,
          handle: p.handle,
          tags: p.tags,
          variants: p.variants?.map(v => ({ sku: v.sku, price: v.price }))
        }))
      },
      results: foundProducts.length > 0 ? [{
        cardName: cardName,
        match: foundProducts[0].title,
        sku: foundProducts[0].variants?.[0]?.sku || null,
        retailPrice: parseFloat(foundProducts[0].variants?.[0]?.price) || 0,
        suggestedTradeValue: Math.floor((parseFloat(foundProducts[0].variants?.[0]?.price) || 0) * 0.7), // 70% of retail
        maximumTradeValue: Math.floor((parseFloat(foundProducts[0].variants?.[0]?.price) || 0) * 0.8), // 80% of retail
        searchMethod: 'enhanced_diagnostic'
      }] : [{
        cardName: cardName,
        match: null,
        sku: null,
        retailPrice: 0,
        suggestedTradeValue: 0,
        maximumTradeValue: 0,
        searchMethod: 'enhanced_diagnostic'
      }],
      resultsCount: foundProducts.length > 0 ? 1 : 0,
      timestamp: new Date().toISOString()
    };

    console.log('📋 ENHANCED DIAGNOSTIC COMPLETE');
    console.log('📊 Final Results:', foundProducts.length, 'products found');
    
    return res.status(200).json(response);

  } catch (error) {
    console.error('💥 ENHANCED DIAGNOSTIC ERROR:', error);
    
    return res.status(500).json({
      success: false,
      error: 'Enhanced diagnostic failed',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
};
