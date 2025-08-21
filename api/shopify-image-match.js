// /api/shopify-image-match.js
// Vercel serverless function for matching card images against Shopify product database

const Shopify = require('shopify-api-node');
const vision = require('@google-cloud/vision');
const sharp = require('sharp');
const multiparty = require('multiparty');

// Initialize Shopify API
const shopify = new Shopify({
  shopName: 'ke40sv-my',
  apiKey: process.env.SHOPIFY_API_KEY,
  password: process.env.SHOPIFY_API_PASSWORD,
  apiVersion: '2023-10'
});

// Initialize Google Vision API for Vercel
const visionClient = new vision.ImageAnnotatorClient({
  credentials: process.env.GOOGLE_CLOUD_CREDENTIALS ? 
    JSON.parse(process.env.GOOGLE_CLOUD_CREDENTIALS) : undefined
});

// Cache for product images (using Vercel's edge caching)
let productImageCache = null;
let lastCacheUpdate = null;
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

// Main Vercel serverless function
export default async function handler(req, res) {
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
    const startTime = Date.now();
    
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

    // Process the uploaded image
    const uploadedImageFeatures = await extractImageFeatures(imageFile.buffer);
    
    if (!uploadedImageFeatures) {
      return res.status(400).json({
        error: 'Could not process uploaded image'
      });
    }

    // Get or update product image cache
    await updateProductImageCache();

    // Find matches
    const matches = await findImageMatches(
      uploadedImageFeatures,
      parseFloat(match_threshold),
      parseInt(max_results)
    );

    console.log(`Found ${matches.length} matches above threshold ${match_threshold}`);

    return res.status(200).json({
      matches: matches,
      total_products_searched: productImageCache ? Object.keys(productImageCache).length : 0,
      processing_time: Date.now() - startTime
    });

  } catch (error) {
    console.error('Shopify image match error:', error);
    return res.status(500).json({
      error: 'Internal server error during image matching',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

// Parse multipart form data for Vercel
function parseFormData(req) {
  return new Promise((resolve, reject) => {
    const form = new multiparty.Form();
    
    form.parse(req, (err, fields, files) => {
      if (err) {
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

// Extract features from uploaded image
async function extractImageFeatures(imageBuffer) {
  try {
    // Resize and normalize image for better comparison
    const processedImage = await sharp(imageBuffer)
      .resize(512, 512, { fit: 'contain', background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 90 })
      .toBuffer();

    // Extract image features using Vision API
    const [featureResult] = await visionClient.annotateImage({
      image: { content: processedImage.toString('base64') },
      features: [
        { type: 'OBJECT_LOCALIZATION' },
        { type: 'TEXT_DETECTION' },
        { type: 'LABEL_DETECTION' },
        { type: 'COLOR_PROPERTIES' }
      ]
    });

    const textAnnotations = featureResult.textAnnotations || [];
    const extractedText = textAnnotations.length > 0 ? textAnnotations[0].description : '';

    return {
      objects: featureResult.localizedObjectAnnotations || [],
      text: extractedText,
      labels: featureResult.labelAnnotations || [],
      colors: featureResult.imagePropertiesAnnotation?.dominantColors?.colors || [],
      processedImage: processedImage
    };

  } catch (error) {
    console.error('Feature extraction error:', error);
    return null;
  }
}

// Update product image cache from Shopify
async function updateProductImageCache() {
  const now = Date.now();
  
  // Check if cache is still valid
  if (lastCacheUpdate && (now - lastCacheUpdate) < CACHE_DURATION && productImageCache) {
    console.log('Using cached product images');
    return;
  }

  console.log('Updating product image cache from Shopify...');
  
  try {
    let allProducts = [];
    let params = { limit: 250, fields: 'id,title,variants,images,product_type,tags' };
    
    // Fetch all products with pagination
    do {
      const products = await shopify.product.list(params);
      allProducts = allProducts.concat(products);
      
      if (products.length < 250) break;
      params.since_id = products[products.length - 1].id;
    } while (true);

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
          try {
            // For Vercel, we'll cache basic product info and do image processing on-demand
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
              tags: product.tags
            };
          } catch (error) {
            console.warn(`Failed to process product ${product.id}, variant ${variant.id}:`, error.message);
          }
        }
      }
    }

    lastCacheUpdate = now;
    console.log(`Cache updated with ${Object.keys(productImageCache).length} product variants`);

  } catch (error) {
    console.error('Error updating product cache:', error);
    throw error;
  }
}

// Find matching products based on image features
async function findImageMatches(uploadedFeatures, threshold, maxResults) {
  const matches = [];

  // For Vercel demo, we'll do a simplified match based on text extraction
  // In production, you'd want to implement more sophisticated image comparison
  
  for (const [key, productData] of Object.entries(productImageCache)) {
    // Simple text-based matching for now
    const confidence = calculateSimpleTextMatch(uploadedFeatures.text, productData.title);
    
    if (confidence >= threshold) {
      matches.push({
        ...productData,
        confidence: confidence
      });
    }
  }

  // Sort by confidence and limit results
  return matches
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, maxResults);
}

// Simple text matching function (placeholder for full image analysis)
function calculateSimpleTextMatch(extractedText, productTitle) {
  if (!extractedText || !productTitle) return 0;
  
  const cleanText = extractedText.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  const cleanTitle = productTitle.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  
  // Simple word overlap calculation
  const textWords = new Set(cleanText.split(/\s+/));
  const titleWords = new Set(cleanTitle.split(/\s+/));
  
  const intersection = new Set([...textWords].filter(x => titleWords.has(x)));
  const union = new Set([...textWords, ...titleWords]);
  
  return union.size > 0 ? intersection.size / union.size : 0;
}

// Export for ES modules
export { handler as default };
