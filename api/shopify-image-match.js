// /api/shopify-image-match.js
// Production version with real Shopify and Google Vision integration

const Shopify = require('shopify-api-node');
const vision = require('@google-cloud/vision');
const sharp = require('sharp');
const multiparty = require('multiparty');

// Initialize Shopify API using environment variables
const shopify = new Shopify({
  shopName: 'ke40sv-my',
  apiKey: process.env.SHOPIFY_API_KEY,
  password: process.env.SHOPIFY_API_PASSWORD,
  apiVersion: '2023-10'
});

// Initialize Google Vision API using environment variables
const visionClient = new vision.ImageAnnotatorClient({
  credentials: process.env.GOOGLE_CLOUD_CREDENTIALS ? 
    JSON.parse(process.env.GOOGLE_CLOUD_CREDENTIALS) : undefined
});

// Cache for product images (using Vercel's edge caching)
let productImageCache = null;
let lastCacheUpdate = null;
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

module.exports = async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('=== Production API Request Started ===');
    const startTime = Date.now();
    
    // Check environment variables
    if (!process.env.SHOPIFY_API_KEY || !process.env.SHOPIFY_API_PASSWORD) {
      console.error('Missing Shopify credentials');
      return res.status(500).json({
        error: 'Server configuration error - missing Shopify credentials'
      });
    }

    if (!process.env.GOOGLE_CLOUD_CREDENTIALS) {
      console.error('Missing Google Vision credentials');
      return res.status(500).json({
        error: 'Server configuration error - missing Google Vision credentials'
      });
    }

    // Parse multipart form data
    const formData = await parseFormData(req);
    
    const { 
      shopify_store = 'ke40sv-my', 
      match_threshold = 0.7, 
      max_results = 5 
    } = formData.fields;

    // Validate store name
    if (shopify_store !== 'ke40sv-my') {
      return res.status(400).json({
        error: 'Invalid store identifier'
      });
    }

    // Validate image upload
    if (!formData.files || !formData.files.image) {
      return res.status(400).json({
        error: 'No image file provided'
      });
    }

    const imageFile = formData.files.image;
    console.log(`Processing image: ${imageFile.originalFilename}, size: ${imageFile.size}`);

    // Process the uploaded image with Google Vision
    const uploadedImageFeatures = await extractImageFeatures(imageFile.buffer);
    
    if (!uploadedImageFeatures) {
      return res.status(400).json({
        error: 'Could not process uploaded image'
      });
    }

    console.log('Extracted text from image:', uploadedImageFeatures.text?.substring(0, 100));

    // Get or update product image cache from Shopify
    await updateProductImageCache();

    // Find matches based on extracted features
    const matches = await findImageMatches(
      uploadedImageFeatures,
      parseFloat(match_threshold),
      parseInt(max_results)
    );

    console.log(`Found ${matches.length} matches above threshold ${match_threshold}`);

    return res.status(200).json({
      matches: matches,
      total_products_searched: productImageCache ? Object.keys(productImageCache).length : 0,
      processing_time: Date.now() - startTime,
      extracted_text: uploadedImageFeatures.text?.substring(0, 200) // For debugging
    });

  } catch (error) {
    console.error('Shopify image match error:', error);
    return res.status(500).json({
      error: 'Internal server error during image matching',
      message: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};

// Parse multipart form data for Vercel
function parseFormData(req) {
  return new Promise((resolve, reject) => {
    const form = new multiparty.Form();
    
    form.parse(req, (err, fields, files) => {
      if (err) {
        console.error('Form parsing error:', err);
        reject(err);
        return;
      }
      
      // Process fields
      const processedFields = {};
      Object.keys(fields).forEach(key => {
        processedFields[key] = fields[key][0]; // Get first value
      });
      
      // Process files
      const processedFiles = {};
      Object.keys(files).forEach(key => {
        const file = files[key][0];
        processedFiles[key] = {
          buffer: require('fs').readFileSync(file.path),
          originalFilename: file.originalFilename,
          size: file.size,
          mimetype: file.headers['content-type']
        };
      });
      
      resolve({
        fields: processedFields,
        files: processedFiles
      });
    });
  });
}

// Extract features from uploaded image using Google Vision
async function extractImageFeatures(imageBuffer) {
  try {
    console.log('Processing image with Google Vision...');
    
    // Resize and normalize image for better analysis
    const processedImage = await sharp(imageBuffer)
      .resize(800, 800, { fit: 'contain', background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 95 })
      .toBuffer();

    // Extract image features using Vision API
    const [featureResult] = await visionClient.annotateImage({
      image: { content: processedImage.toString('base64') },
      features: [
        { type: 'TEXT_DETECTION' },
        { type: 'LABEL_DETECTION' },
        { type: 'OBJECT_LOCALIZATION' }
      ]
    });

    const textAnnotations = featureResult.textAnnotations || [];
    const extractedText = textAnnotations.length > 0 ? textAnnotations[0].description : '';

    console.log('Vision API - Extracted text length:', extractedText.length);
    console.log('Vision API - Labels found:', featureResult.labelAnnotations?.length || 0);

    return {
      text: extractedText,
      labels: featureResult.labelAnnotations || [],
      objects: featureResult.localizedObjectAnnotations || []
    };

  } catch (error) {
    console.error('Google Vision error:', error);
    return null;
  }
}

// Update product image cache from Shopify
async function updateProductImageCache() {
  const now = Date.now();
  
  // Check if cache is still valid
  if (lastCacheUpdate && (now - lastCacheUpdate) < CACHE_DURATION && productImageCache) {
    console.log('Using cached Shopify products');
    return;
  }

  console.log('Fetching products from Shopify...');
  
  try {
    let allProducts = [];
    let params = { limit: 250, fields: 'id,title,variants,images,product_type,tags,vendor' };
    
    // Fetch all products with pagination
    do {
      const products = await shopify.product.list(params);
      allProducts = allProducts.concat(products);
      
      if (products.length < 250) break;
      params.since_id = products[products.length - 1].id;
    } while (allProducts.length < 1000); // Limit to prevent timeout

    console.log(`Processing ${allProducts.length} products from Shopify...`);

    // Clear cache and rebuild
    productImageCache = {};

    for (const product of allProducts) {
      // Skip products without images
      if (!product.images || product.images.length === 0) continue;

      // Process each variant
      for (const variant of product.variants) {
        // Find the best image for this variant
        const variantImage = product.images.find(img => 
          img.variant_ids && img.variant_ids.includes(variant.id)
        ) || product.images[0]; // fallback to first image

        if (variantImage) {
          productImageCache[`${product.id}-${variant.id}`] = {
            title: product.title,
            sku: variant.sku,
            variant_sku: variant.sku,
            variant_title: variant.title,
            price: variant.price,
            compare_at_price: variant.compare_at_price,
            product_id: product.id,
            variant_id: variant.id,
            inventory_quantity: variant.inventory_quantity,
            image_url: variantImage.src,
            product_type: product.product_type,
            vendor: product.vendor,
            tags: product.tags
          };
        }
      }
    }

    lastCacheUpdate = now;
    console.log(`Shopify cache updated with ${Object.keys(productImageCache).length} product variants`);

  } catch (error) {
    console.error('Error fetching Shopify products:', error);
    throw error;
  }
}

// Find matching products based on image features
async function findImageMatches(uploadedFeatures, threshold, maxResults) {
  const matches = [];

  if (!productImageCache || Object.keys(productImageCache).length === 0) {
    console.log('No products in cache to match against');
    return matches;
  }

  console.log(`Searching ${Object.keys(productImageCache).length} products for matches...`);

  // Search through cached products for text matches
  for (const [key, productData] of Object.entries(productImageCache)) {
    const confidence = calculateTextMatch(uploadedFeatures.text, productData);
    
    if (confidence >= threshold) {
      matches.push({
        ...productData,
        confidence: confidence
      });
    }
  }

  // Sort by confidence and limit results
  const sortedMatches = matches
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, maxResults);

  console.log(`Returning ${sortedMatches.length} matches`);
  return sortedMatches;
}

// Calculate text-based matching confidence
function calculateTextMatch(extractedText, productData) {
  if (!extractedText || !productData.title) return 0;
  
  const cleanText = extractedText.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  const cleanTitle = productData.title.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  
  // Check for exact title match
  if (cleanText.includes(cleanTitle) || cleanTitle.includes(cleanText)) {
    return 0.95;
  }
  
  // Check for SKU match
  if (productData.sku && cleanText.includes(productData.sku.toLowerCase())) {
    return 0.90;
  }
  
  // Word overlap calculation
  const textWords = new Set(cleanText.split(/\s+/).filter(word => word.length > 2));
  const titleWords = new Set(cleanTitle.split(/\s+/).filter(word => word.length > 2));
  
  if (textWords.size === 0 || titleWords.size === 0) return 0;
  
  const intersection = new Set([...textWords].filter(x => titleWords.has(x)));
  const union = new Set([...textWords, ...titleWords]);
  
  const similarity = intersection.size / Math.max(textWords.size, titleWords.size);
  
  // Boost confidence for trading card related terms
  const cardTerms = ['magic', 'mtg', 'pokemon', 'yugioh', 'card', 'rare', 'foil', 'holo'];
  const hasCardTerms = cardTerms.some(term => 
    cleanText.includes(term) || cleanTitle.includes(term)
  );
  
  return hasCardTerms ? Math.min(similarity * 1.2, 1.0) : similarity;
}
