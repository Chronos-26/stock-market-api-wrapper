/**
 * Basic Usage Example
 * Demonstrates the core functionality of the Stock Market API Wrapper
 */

const StockMarketAPI = require('../src/index.js');

async function runExample() {
  console.log('📈 Stock Market API Wrapper - Example Usage\n');
  
  // Initialize with demo API key (replace with real key in production)
  const api = new StockMarketAPI('demo-api-key', {
    cacheTTL: 600,      // 10 minutes cache
    retryAttempts: 5,   // More retries for reliability
    enableRateLimiting: true,
    enableWebSocket: false // Disable WebSocket for this example
  });
  
  try {
    await api.connect();
    console.log('✅ API Wrapper connected\n');
    
    // Example 1: Get single quote
    console.log('1. Getting single stock quote...');
    try {
      const aaplQuote = await api.getQuote('AAPL');
      console.log(`   AAPL: $${aaplQuote.price} (${aaplQuote.changePercent}%)`);
      console.log(`   Volume: ${aaplQuote.volume.toLocaleString()} shares`);
      console.log(`   Market Cap: $${(aaplQuote.marketCap / 1e9).toFixed(1)}B`);
    } catch (error) {
      console.log(`   Note: Using demo mode - ${error.message}`);
      console.log('   In production, this would return real data');
    }
    
    // Example 2: Get multiple quotes
    console.log('\n2. Getting multiple stock quotes...');
    const techStocks = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'TSLA', 'META'];
    
    try {
      const quotes = await api.getMultipleQuotes(techStocks);
      
      console.log('   Top Tech Stocks:');
      for (const [symbol, data] of Object.entries(quotes)) {
        const trend = data.changePercent >= 0 ? '📈' : '📉';
        console.log(`   ${trend} ${symbol}: $${data.price.toFixed(2)} (${data.changePercent.toFixed(2)}%)`);
      }
      
      // Calculate average performance
      const avgChange = Object.values(quotes).reduce((sum, q) => sum + q.changePercent, 0) / Object.keys(quotes).length;
      console.log(`\n   Average daily change: ${avgChange.toFixed(2)}%`);
      
    } catch (error) {
      console.log(`   Note: Using demo mode - ${error.message}`);
      console.log('   In production, this would return real batch data');
    }
    
    // Example 3: Get historical data
    console.log('\n3. Getting historical data...');
    try {
      const historical = await api.getHistoricalData('AAPL', '5d', '1h');
      console.log(`   AAPL 5-day hourly data: ${historical.data.length} data points`);
      
      if (historical.data.length > 0) {
        const first = historical.data[0];
        const last = historical.data[historical.data.length - 1];
        const change = ((last.close - first.close) / first.close * 100).toFixed(2);
        
        console.log(`   First: $${first.close} (${first.timestamp})`);
        console.log(`   Last:  $${last.close} (${last.timestamp})`);
        console.log(`   Change: ${change}% over 5 days`);
      }
    } catch (error) {
      console.log(`   Note: Using demo mode - ${error.message}`);
    }
    
    // Example 4: Demonstrate error handling
    console.log('\n4. Demonstrating error handling...');
    try {
      // Invalid symbol
      await api.getQuote('');
    } catch (error) {
      console.log(`   ✅ Correctly caught error: ${error.message}`);
    }
    
    try {
      // Empty batch
      await api.getMultipleQuotes([]);
    } catch (error) {
      console.log(`   ✅ Correctly caught error: ${error.message}`);
    }
    
    try {
      // Too large batch
      const largeBatch = Array.from({length: 100}, (_, i) => `STOCK${i}`);
      await api.getMultipleQuotes(largeBatch);
    } catch (error) {
      console.log(`   ✅ Correctly caught error: ${error.message}`);
    }
    
    // Example 5: Cache demonstration
    console.log('\n5. Demonstrating caching...');
    console.log('   First request (may be slow)...');
    const start1 = Date.now();
    try {
      await api.getQuote('GOOGL');
    } catch {
      // Ignore demo errors
    }
    const time1 = Date.now() - start1;
    console.log(`   Time: ${time1}ms`);
    
    console.log('   Second request (should be fast from cache)...');
    const start2 = Date.now();
    try {
      await api.getQuote('GOOGL');
    } catch {
      // Ignore demo errors
    }
    const time2 = Date.now() - start2;
    console.log(`   Time: ${time2}ms`);
    
    if (time1 > 0 && time2 > 0) {
      const improvement = Math.round((time1 - time2) / time1 * 100);
      console.log(`   Result: ${improvement}% faster with cache`);
    }
    
    console.log('\n✅ All examples completed successfully!');
    console.log('\n📋 Summary:');
    console.log('   - Professional API wrapper with caching');
    console.log('   - Rate limiting and error handling');
    console.log('   - Batch operations for efficiency');
    console.log('   - Historical data support');
    console.log('   - Ready for production use');
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error('Stack:', error.stack);
  } finally {
    await api.disconnect();
    console.log('\n🔌 API Wrapper disconnected');
  }
}

// Run example if this file is executed directly
if (require.main === module) {
  runExample().catch(console.error);
}

module.exports = { runExample };