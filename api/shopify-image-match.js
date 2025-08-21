// /api/shopify-image-match.js
// Backend API endpoint for matching card images against Shopify product database

const express = require('express');
const multer = require('multer');
const Shopify = require('shopify-api-node');
const vision = require('@google-cloud/vision'); // or your preferred image analysis service
const sharp = require('sharp'); // for image processing
const similarity = require('compute-cosine-similarity'); // for image comparison

// Configure multer for image uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

// Initialize Shopify API
const shopify = new Shopify({
  shopName: 'ke40sv-my',
  apiKey: process.env.SHOPIFY_API_KEY,
  password: process.env.SHOPIFY_API_PASSWORD,
  apiVersion: '2023-10'
});

// Initialize Google Vision API (or your preferred image analysis service)
const visionClient = new vision.ImageAnnotatorClient({
  keyFilename: process.env.GOOGLE_CLOUD_KEY_FILE, // Path to your service account key
});

// Cache for product images and features (implement Redis in production)
let productImageCache = new Map();
let lastCacheUpdate = null;
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

// Main API endpoint
const shopifyImageMatch = async (req, res) => {
  try {
    const { shopify_store, match_threshold = 0.7, max_results = 5 } = req.body;
    
    // Validate store name
    if (shopify_store !== 'ke40sv-my') {
      return res.status(400).json({
        error: 'Invalid store identifier'
      });
    }

    // Validate image upload
    if (!req.file) {
      return res.status(400).json({
        error: 'No image file provided'
      });
    }

    console.log(`Processing image match request for store: ${shopify_store}`);
    console.log(`Image size: ${req.file.size} bytes`);

    // Process the uploaded image
    const uploadedImageFeatures = await extractImageFeatures(req.file.buffer);
    
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

    res.json({
      matches: matches,
      total_products_searched: productImageCache.size,
      processing_time: Date.now() - req.startTime
    });

  } catch (error) {
    console.error('Shopify image match error:', error);
    res.status(500).json({
      error: 'Internal server error during image matching',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Extract features from uploaded image
async function extractImageFeatures(imageBuffer) {
  try {
    // Resize and normalize image for better comparison
    const processedImage = await sharp(imageBuffer)
      .resize(512, 512, { fit: 'contain', background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 90 })
      .toBuffer();

    // Use Google Vision API for feature extraction
    const [result] = await visionClient.objectLocalization(processedImage);
    const objects = result.localizedObjectAnnotations || [];

    // Extract text for card names/numbers
    const [textResult] = await visionClient.textDetection(processedImage);
    const textAnnotations = textResult.textAnnotations || [];
    const extractedText = textAnnotations.length > 0 ? textAnnotations[0].description : '';

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

    return {
      objects: objects,
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
  if (lastCacheUpdate && (now - lastCacheUpdate) < CACHE_DURATION && productImageCache.size > 0) {
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
    productImageCache.clear();

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
            // Extract features from product image
            const imageFeatures = await extractProductImageFeatures(variantImage.src);
            
            if (imageFeatures) {
              productImageCache.set(`${product.id}-${variant.id}`, {
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
                features: imageFeatures,
                product_type: product.product_type,
                tags: product.tags
              });
            }
          } catch (error) {
            console.warn(`Failed to process image for product ${product.id}, variant ${variant.id}:`, error.message);
          }
        }
      }
    }

    lastCacheUpdate = now;
    console.log(`Cache updated with ${productImageCache.size} product variants`);

  } catch (error) {
    console.error('Error updating product cache:', error);
    throw error;
  }
}

// Extract features from Shopify product images
async function extractProductImageFeatures(imageUrl) {
  try {
    // Download image
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error(`Failed to fetch image: ${response.statusText}`);
    
    const imageBuffer = await response.buffer();
    
    // Process similar to uploaded image
    const processedImage = await sharp(imageBuffer)
      .resize(512, 512, { fit: 'contain', background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 90 })
      .toBuffer();

    // Extract features using Vision API
    const [result] = await visionClient.annotateImage({
      image: { content: processedImage.toString('base64') },
      features: [
        { type: 'OBJECT_LOCALIZATION' },
        { type: 'TEXT_DETECTION' },
        { type: 'LABEL_DETECTION' },
        { type: 'COLOR_PROPERTIES' }
      ]
    });

    const textAnnotations = result.textAnnotations || [];
    const extractedText = textAnnotations.length > 0 ? textAnnotations[0].description : '';

    return {
      objects: result.localizedObjectAnnotations || [],
      text: extractedText,
      labels: result.labelAnnotations || [],
      colors: result.imagePropertiesAnnotation?.dominantColors?.colors || []
    };

  } catch (error) {
    console.error('Product image feature extraction error:', error);
    return null;
  }
}

// Find matching products based on image features
async function findImageMatches(uploadedFeatures, threshold, maxResults) {
  const matches = [];

  for (const [key, productData] of productImageCache) {
    const confidence = calculateImageSimilarity(uploadedFeatures, productData.features);
    
    if (confidence >= threshold) {
      matches.push({
        ...productData,
        confidence: confidence
      });
    }
  }

  // Sort by confidence (highest first) and limit results
  return matches
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, maxResults);
}

// Calculate similarity between two sets of image features
function calculateImageSimilarity(features1, features2) {
  let totalScore = 0;
  let weightSum = 0;

  // Text similarity (high weight for card games)
  const textWeight = 0.4;
  const textSimilarity = calculateTextSimilarity(features1.text, features2.text);
  totalScore += textSimilarity * textWeight;
  weightSum += textWeight;

  // Object similarity
  const objectWeight = 0.3;
  const objectSimilarity = calculateObjectSimilarity(features1.objects, features2.objects);
  totalScore += objectSimilarity * objectWeight;
  weightSum += objectWeight;

  // Label similarity
  const labelWeight = 0.2;
  const labelSimilarity = calculateLabelSimilarity(features1.labels, features2.labels);
  totalScore += labelSimilarity * labelWeight;
  weightSum += labelWeight;

  // Color similarity
  const colorWeight = 0.1;
  const colorSimilarity = calculateColorSimilarity(features1.colors, features2.colors);
  totalScore += colorSimilarity * colorWeight;
  weightSum += colorWeight;

  return weightSum > 0 ? totalScore / weightSum : 0;
}

// Text similarity using simple string comparison and fuzzy matching
function calculateTextSimilarity(text1, text2) {
  if (!text1 || !text2) return 0;
  
  const cleanText1 = text1.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  const cleanText2 = text2.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  
  // Calculate Jaccard similarity of words
  const words1 = new Set(cleanText1.split(/\s+/));
  const words2 = new Set(cleanText2.split(/\s+/));
  
  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);
  
  return union.size > 0 ? intersection.size / union.size : 0;
}

// Object similarity based on detected objects
function calculateObjectSimilarity(objects1, objects2) {
  if (!objects1.length || !objects2.length) return 0;
  
  const names1 = objects1.map(obj => obj.name.toLowerCase());
  const names2 = objects2.map(obj => obj.name.toLowerCase());
  
  const common = names1.filter(name => names2.includes(name));
  return common.length / Math.max(names1.length, names2.length);
}

// Label similarity based on detected labels
function calculateLabelSimilarity(labels1, labels2) {
  if (!labels1.length || !labels2.length) return 0;
  
  const descriptions1 = labels1.map(label => label.description.toLowerCase());
  const descriptions2 = labels2.map(label => label.description.toLowerCase());
  
  const common = descriptions1.filter(desc => descriptions2.includes(desc));
  return common.length / Math.max(descriptions1.length, descriptions2.length);
}

// Color similarity based on dominant colors
function calculateColorSimilarity(colors1, colors2) {
  if (!colors1.length || !colors2.length) return 0;
  
  // Simple color distance calculation
  let totalDistance = 0;
  let comparisons = 0;
  
  for (const color1 of colors1.slice(0, 3)) { // top 3 colors
    for (const color2 of colors2.slice(0, 3)) {
      const distance = Math.sqrt(
        Math.pow(color1.color.red - color2.color.red, 2) +
        Math.pow(color1.color.green - color2.color.green, 2) +
        Math.pow(color1.color.blue - color2.color.blue, 2)
      );
      totalDistance += distance;
      comparisons++;
    }
  }
  
  if (comparisons === 0) return 0;
  
  const avgDistance = totalDistance / comparisons;
  const maxDistance = Math.sqrt(3 * Math.pow(255, 2)); // max possible distance
  
  return 1 - (avgDistance / maxDistance); // convert distance to similarity
}

// Middleware to add start time for performance tracking
const addStartTime = (req, res, next) => {
  req.startTime = Date.now();
  next();
};

// Express router setup
const router = express.Router();
router.post('/shopify-image-match', addStartTime, upload.single('image'), shopifyImageMatch);

module.exports = router;

// Alternative export for serverless functions (Vercel, Netlify, etc.)
module.exports.handler = async (event, context) => {
  // Serverless function wrapper
  const req = {
    body: JSON.parse(event.body),
    file: event.file, // You'll need to handle multipart parsing in serverless
    startTime: Date.now()
  };
  
  const res = {
    json: (data) => ({
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }),
    status: (code) => ({
      json: (data) => ({
        statusCode: code,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      })
    })
  };
  
  return await shopifyImageMatch(req, res);
};
