import Head from 'next/head';
import { useEffect, useState } from 'react';

export default function BarcodePrinter() {
  const [apiResponse, setApiResponse] = useState('');
  const [barcodeFormat, setBarcodeFormat] = useState('CODE128');
  const [barcodeHeight, setBarcodeHeight] = useState(50);
  const [barcodeWidth, setBarcodeWidth] = useState(2);
  const [barcodes, setBarcodes] = useState([]);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    // Load JsBarcode library
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jsbarcode/3.11.5/JsBarcode.all.min.js';
    document.head.appendChild(script);

    return () => {
      document.head.removeChild(script);
    };
  }, []);

  const generateBarcodes = () => {
    setError('');
    setStats(null);
    setBarcodes([]);

    if (!apiResponse.trim()) {
      setError('Please paste your API response JSON');
      return;
    }

    let apiData;
    try {
      apiData = JSON.parse(apiResponse);
    } catch (e) {
      setError('Invalid JSON format. Please check your API response.');
      return;
    }

    if (!apiData.results || !Array.isArray(apiData.results)) {
      setError('API response must contain a "results" array');
      return;
    }

    const cards = apiData.results.filter(card => card.match && card.match !== null && card.sku);

    if (cards.length === 0) {
      setError('No matched cards with SKUs found in the API response');
      return;
    }

    const newBarcodes = [];
    let totalBarcodes = 0;

    cards.forEach(card => {
      const quantity = parseInt(card.quantity) || 1;
      totalBarcodes += quantity;

      for (let i = 0; i < quantity; i++) {
        newBarcodes.push({
          id: `${card.sku}-${i}`,
          cardName: card.cardName,
          sku: card.sku,
          match: card.match
        });
      }
    });

    setBarcodes(newBarcodes);
    setStats({
      totalBarcodes,
      uniqueCards: cards.length
    });

    // Generate barcodes after state update
    setTimeout(() => {
      newBarcodes.forEach(barcode => {
        const canvas = document.getElementById(`barcode-${barcode.id}`);
        if (canvas && window.JsBarcode) {
          try {
            window.JsBarcode(canvas, barcode.sku, {
              format: barcodeFormat,
              width: barcodeWidth,
              height: barcodeHeight,
              displayValue: false,
              margin: 10,
              background: '#ffffff',
              lineColor: '#000000'
            });
          } catch (e) {
            console.error('Barcode generation failed for:', barcode.sku, e);
          }
        }
      });
    }, 100);
  };

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
    setApiResponse(JSON.stringify(sampleData, null, 2));
  };

  return (
    <>
      <Head>
        <title>SKU Barcode Printer</title>
        <meta name="description" content="Generate barcodes from trade-in results" />
      </Head>

      <div className="container">
        <h1>SKU Barcode Printer</h1>
        
        <div className="input-section">
          <label htmlFor="apiResponse">Paste API Response JSON (from your trade-in system):</label>
          <textarea
            id="apiResponse"
            value={apiResponse}
            onChange={(e) => setApiResponse(e.target.value)}
            placeholder='Paste your API response here...'
            rows={8}
          />
        </div>
        
        <div className="controls">
          <div className="control-group">
            <label htmlFor="barcodeFormat">Barcode Format:</label>
            <select 
              id="barcodeFormat" 
              value={barcodeFormat} 
              onChange={(e) => setBarcodeFormat(e.target.value)}
            >
              <option value="CODE128">CODE128 (Recommended)</option>
              <option value="CODE39">CODE39</option>
              <option value="EAN13">EAN13 (13 digits only)</option>
              <option value="EAN8">EAN8 (8 digits only)</option>
            </select>
          </div>
          
          <div className="control-group">
            <label htmlFor="barcodeHeight">Height:</label>
            <input 
              type="number" 
              id="barcodeHeight" 
              value={barcodeHeight} 
              onChange={(e) => setBarcodeHeight(parseInt(e.target.value))}
              min="30" 
              max="200" 
            />
          </div>
          
          <div className="control-group">
            <label htmlFor="barcodeWidth">Width:</label>
            <input 
              type="number" 
              id="barcodeWidth" 
              value={barcodeWidth} 
              onChange={(e) => setBarcodeWidth(parseFloat(e.target.value))}
              min="1" 
              max="5" 
              step="0.1" 
            />
          </div>
          
          <button onClick={generateBarcodes}>Generate Barcodes</button>
          <button onClick={loadSampleData} className="sample-btn">Load Sample Data</button>
        </div>
        
        {stats && (
          <div className="stats">
            <strong>Generated {stats.totalBarcodes} barcodes</strong><br />
            {stats.uniqueCards} unique cards processed
          </div>
        )}
        
        {error && (
          <div className="error">{error}</div>
        )}
        
        {barcodes.length > 0 && (
          <>
            <div className="barcode-grid">
              {barcodes.map(barcode => (
                <div key={barcode.id} className="barcode-item">
                  <div className="card-name">{barcode.cardName}</div>
                  <canvas id={`barcode-${barcode.id}`}></canvas>
                  <div className="barcode-text">{barcode.sku}</div>
                </div>
              ))}
            </div>
            
            <div className="print-section">
              <button className="print-button" onClick={() => window.print()}>
                🖨️ Print Barcodes
              </button>
            </div>
          </>
        )}
      </div>

      <style jsx>{`
        .container {
          max-width: 1200px;
          margin: 0 auto;
          padding: 20px;
          background: #f5f5f5;
          min-height: 100vh;
        }
        
        .container > div:first-child {
          background: white;
          padding: 30px;
          border-radius: 12px;
          box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }
        
        h1 {
          color: #333;
          text-align: center;
          margin-bottom: 30px;
        }
        
        .input-section {
          margin-bottom: 30px;
        }
        
        label {
          display: block;
          margin-bottom: 8px;
          font-weight: bold;
          color: #555;
        }
        
        textarea {
          width: 100%;
          padding: 12px;
          border: 2px solid #ddd;
          border-radius: 8px;
          font-family: monospace;
          font-size: 14px;
          resize: vertical;
        }
        
        .controls {
          display: flex;
          gap: 15px;
          flex-wrap: wrap;
          align-items: end;
          margin-bottom: 30px;
        }
        
        .control-group {
          display: flex;
          flex-direction: column;
          gap: 5px;
        }
        
        select, input {
          padding: 8px 12px;
          border: 2px solid #ddd;
          border-radius: 6px;
          font-size: 14px;
        }
        
        button {
          background: #007cba;
          color: white;
          border: none;
          padding: 12px 24px;
          border-radius: 8px;
          cursor: pointer;
          font-size: 16px;
          font-weight: bold;
          transition: background-color 0.3s;
        }
        
        button:hover {
          background: #005a87;
        }
        
        .sample-btn {
          background: #6c757d;
        }
        
        .sample-btn:hover {
          background: #545b62;
        }
        
        .barcode-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
          gap: 20px;
          margin-top: 30px;
        }
        
        .barcode-item {
          border: 2px solid #ddd;
          border-radius: 8px;
          padding: 15px;
          text-align: center;
          background: white;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        
        .barcode-item canvas {
          max-width: 100%;
          height: auto;
        }
        
        .barcode-text {
          margin-top: 10px;
          font-weight: bold;
          font-size: 14px;
          color: #333;
        }
        
        .card-name {
          margin-bottom: 8px;
          font-size: 12px;
          color: #666;
          max-height: 36px;
          overflow: hidden;
          line-height: 1.2;
        }
        
        .print-section {
          margin-top: 30px;
          text-align: center;
          border-top: 2px solid #eee;
          padding-top: 30px;
        }
        
        .print-button {
          background: #28a745;
          font-size: 18px;
          padding: 15px 30px;
        }
        
        .print-button:hover {
          background: #1e7e34;
        }
        
        .stats {
          background: #f8f9fa;
          padding: 15px;
          border-radius: 8px;
          margin-bottom: 20px;
          text-align: center;
        }
        
        .error {
          color: #dc3545;
          background: #f8d7da;
          padding: 10px;
          border-radius: 6px;
          margin-top: 10px;
        }
        
        @media print {
          .container {
            background: white;
            padding: 0;
          }
          
          .input-section, .controls, .print-section, .stats, h1 {
            display: none !important;
          }
          
          .barcode-gri