// Convert the barcode printer to vanilla JavaScript
document.addEventListener('DOMContentLoaded', () => {
  let barcodes = [];
  let apiResponse = '';
  let barcodeFormat = 'CODE128';
  let barcodeHeight = 50;
  let barcodeWidth = 2;

  // Setup UI elements
  const container = document.getElementById('app');
  container.innerHTML = `
    <div class="container">
      <h1>SKU Barcode Printer</h1>
      
      <div class="input-section">
        <label for="apiResponse">Paste API Response JSON (from your trade-in system):</label>
        <textarea
          id="apiResponse"
          placeholder="Paste your API response here..."
          rows="8"
        ></textarea>
      </div>
      
      <div class="controls">
        <div class="control-group">
          <label for="barcodeFormat">Barcode Format:</label>
          <select id="barcodeFormat">
            <option value="CODE128">CODE128 (Recommended)</option>
            <option value="CODE39">CODE39</option>
            <option value="EAN13">EAN13 (13 digits only)</option>
            <option value="EAN8">EAN8 (8 digits only)</option>
          </select>
        </div>
        
        <div class="control-group">
          <label for="barcodeHeight">Height:</label>
          <input 
            type="number" 
            id="barcodeHeight" 
            value="50"
            min="30" 
            max="200" 
          />
        </div>
        
        <div class="control-group">
          <label for="barcodeWidth">Width:</label>
          <input 
            type="number" 
            id="barcodeWidth" 
            value="2"
            min="1" 
            max="5" 
            step="0.1" 
          />
        </div>
        
        <button id="generateBtn">Generate Barcodes</button>
        <button id="sampleBtn" class="sample-btn">Load Sample Data</button>
      </div>

      <div id="stats" class="stats" style="display: none;"></div>
      <div id="error" class="error" style="display: none;"></div>
      <div id="barcodeGrid" class="barcode-grid"></div>
      <div id="printSection" class="print-section" style="display: none;">
        <button id="printBtn" class="print-button">🖨️ Print Barcodes</button>
      </div>
    </div>
  `;

  // Get DOM elements
  const apiResponseTextarea = document.getElementById('apiResponse');
  const barcodeFormatSelect = document.getElementById('barcodeFormat');
  const barcodeHeightInput = document.getElementById('barcodeHeight');
  const barcodeWidthInput = document.getElementById('barcodeWidth');
  const generateButton = document.getElementById('generateBtn');
  const sampleButton = document.getElementById('sampleBtn');
  const printButton = document.getElementById('printBtn');
  const statsDiv = document.getElementById('stats');
  const errorDiv = document.getElementById('error');
  const barcodeGrid = document.getElementById('barcodeGrid');
  const printSection = document.getElementById('printSection');

  // Event handlers
  const loadSampleData = () => {
    const sampleData = {
      "results": [
        {
          "cardName": "Charizard VMAX",
          "match": "Pokemon Card - Charizard VMAX",
          "retailPrice": 45.99,
          "tradeInValue": 13.80,
          "quantity": 2,
          "sku": "CHAR-VMAX-001"
        },
        {
          "cardName": "Pikachu V",
          "match": "Pokemon Card - Pikachu V",
          "retailPrice": 12.99,
          "tradeInValue": 3.90,
          "quantity": 1,
          "sku": "PIKA-V-002"
        }
      ]
    };
    apiResponseTextarea.value = JSON.stringify(sampleData, null, 2);
  };

  const showError = (message) => {
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
  };

  const hideError = () => {
    errorDiv.style.display = 'none';
  };

  const generateBarcodes = () => {
    hideError();
    statsDiv.style.display = 'none';
    barcodeGrid.innerHTML = '';
    printSection.style.display = 'none';
    barcodes = [];

    const apiResponseValue = apiResponseTextarea.value.trim();
    if (!apiResponseValue) {
      showError('Please paste your API response JSON');
      return;
    }

    let apiData;
    try {
      apiData = JSON.parse(apiResponseValue);
    } catch (e) {
      showError('Invalid JSON format. Please check your API response.');
      return;
    }

    if (!apiData.results || !Array.isArray(apiData.results)) {
      showError('API response must contain a "results" array');
      return;
    }

    const cards = apiData.results.filter(card => card.match && card.match !== null && card.sku);

    if (cards.length === 0) {
      showError('No matched cards with SKUs found in the API response');
      return;
    }

    let totalBarcodes = 0;

    cards.forEach(card => {
      const quantity = parseInt(card.quantity) || 1;
      totalBarcodes += quantity;

      for (let i = 0; i < quantity; i++) {
        barcodes.push({
          id: `${card.sku}-${i}`,
          cardName: card.cardName,
          sku: card.sku,
          match: card.match
        });
      }
    });

    // Update stats
    statsDiv.innerHTML = `
      <strong>Generated ${totalBarcodes} barcodes</strong><br>
      ${cards.length} unique cards processed
    `;
    statsDiv.style.display = 'block';

    // Generate barcode elements
    barcodes.forEach(barcode => {
      const barcodeItem = document.createElement('div');
      barcodeItem.className = 'barcode-item';
      barcodeItem.innerHTML = `
        <div class="card-name">${barcode.cardName}</div>
        <canvas id="barcode-${barcode.id}"></canvas>
        <div class="barcode-text">${barcode.sku}</div>
      `;
      barcodeGrid.appendChild(barcodeItem);

      const canvas = document.getElementById(`barcode-${barcode.id}`);
      try {
        JsBarcode(canvas, barcode.sku, {
          format: barcodeFormatSelect.value,
          width: parseFloat(barcodeWidthInput.value),
          height: parseInt(barcodeHeightInput.value),
          displayValue: false,
          margin: 10,
          background: '#ffffff',
          lineColor: '#000000'
        });
      } catch (e) {
        console.error('Barcode generation failed for:', barcode.sku, e);
      }
    });

    printSection.style.display = 'block';
  };

  // Event listeners
  generateButton.addEventListener('click', generateBarcodes);
  sampleButton.addEventListener('click', loadSampleData);
  printButton.addEventListener('click', () => window.print());

  // Initialize with sample data
  loadSampleData();
});
