/**
 * Stock Market API Wrapper
 * Professional API development example
 * Features: Caching, Rate Limiting, Error Handling, Retry Logic
 */

const axios = require('axios');
const Redis = require('redis');
const { RateLimiterRedis } = require('rate-limiter-flexible');
const WebSocket = require('ws');
require('dotenv').config();

class StockMarketAPI {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey || process.env.STOCK_API_KEY;
    this.baseURL = options.baseURL || 'https://api.example-stock.com/v1';
    this.cacheTTL = options.cacheTTL || 300; // 5 minutes
    this.retryAttempts = options.retryAttempts || 3;
    this.enableWebSocket = options.enableWebSocket !== false;
    this.enableRateLimiting = options.enableRateLimiting !== false;
    
    // Initialize Redis client for caching and rate limiting
    this.redisClient = Redis.createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379'
    });
    
    this.redisClient.on('error', (err) => {
      console.warn('Redis connection error:', err.message);
    });
    
    // Rate limiter: 100 requests per minute per API key
    if (this.enableRateLimiting) {
      this.rateLimiter = new RateLimiterRedis({
        storeClient: this.redisClient,
        keyPrefix: 'rate_limit',
        points: 100,
        duration: 60
      });
    }
    
    // WebSocket server for real-time updates
    this.wss = null;
    this.clients = new Set();
    
    this.axiosInstance = axios.create({
      baseURL: this.baseURL,
      timeout: 10000,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'StockMarketAPI/1.0.0'
      }
    });
    
    // Cache for WebSocket subscriptions
    this.subscriptions = new Map();
  }
  
  async connect() {
    await this.redisClient.connect();
    console.log('✅ Stock Market API Wrapper initialized');
    
    if (this.enableWebSocket) {
      this.setupWebSocket();
    }
    
    return this;
  }
  
  async getQuote(symbol, useCache = true) {
    const cacheKey = `quote:${symbol.toLowerCase()}`;
    
    // Validate symbol
    if (!symbol || typeof symbol !== 'string') {
      throw new Error('Invalid symbol provided');
    }
    
    // Try cache first
    if (useCache) {
      try {
        const cached = await this.redisClient.get(cacheKey);
        if (cached) {
          console.log(`📊 ${symbol} quote from cache`);
          return JSON.parse(cached);
        }
      } catch (err) {
        console.warn('Cache read failed:', err.message);
      }
    }
    
    // Check rate limit
    if (this.enableRateLimiting) {
      try {
        await this.rateLimiter.consume(this.apiKey);
      } catch (err) {
        throw new Error(`Rate limit exceeded. Try again in ${Math.ceil(err.msBeforeNext / 1000)} seconds`);
      }
    }
    
    // Make API request with retry logic
    let lastError;
    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        const response = await this.axiosInstance.get(`/quote/${symbol}`);
        const data = this.transformQuoteData(response.data, symbol);
        
        // Cache the result
        if (useCache) {
          await this.redisClient.setEx(cacheKey, this.cacheTTL, JSON.stringify(data));
        }
        
        // Broadcast to WebSocket clients if subscribed
        this.broadcastToSubscribers(symbol, data);
        
        console.log(`✅ ${symbol} quote retrieved (attempt ${attempt})`);
        return data;
      } catch (error) {
        lastError = error;
        console.warn(`Attempt ${attempt} failed for ${symbol}:`, error.message);
        
        if (attempt < this.retryAttempts) {
          // Exponential backoff
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
        }
      }
    }
    
    throw new Error(`Failed to get quote for ${symbol} after ${this.retryAttempts} attempts: ${lastError.message}`);
  }
  
  async getMultipleQuotes(symbols, useCache = true) {
    if (!Array.isArray(symbols) || symbols.length === 0) {
      throw new Error('Symbols array must not be empty');
    }
    
    // Limit batch size
    const batchLimit = 50;
    if (symbols.length > batchLimit) {
      throw new Error(`Batch size limited to ${batchLimit} symbols`);
    }
    
    const results = {};
    const uncachedSymbols = [];
    
    // Check cache for each symbol
    if (useCache) {
      for (const symbol of symbols) {
        const cacheKey = `quote:${symbol.toLowerCase()}`;
        try {
          const cached = await this.redisClient.get(cacheKey);
          if (cached) {
            results[symbol] = JSON.parse(cached);
          } else {
            uncachedSymbols.push(symbol);
          }
        } catch (err) {
          uncachedSymbols.push(symbol);
        }
      }
    } else {
      uncachedSymbols.push(...symbols);
    }
    
    // Fetch uncached symbols
    if (uncachedSymbols.length > 0) {
      if (this.enableRateLimiting) {
        try {
          await this.rateLimiter.consume(this.apiKey, uncachedSymbols.length);
        } catch (err) {
          throw new Error(`Rate limit exceeded for batch request`);
        }
      }
      
      try {
        const response = await this.axiosInstance.post('/quotes/batch', {
          symbols: uncachedSymbols
        });
        
        const batchData = response.data;
        
        // Cache new results
        for (const symbol of uncachedSymbols) {
          if (batchData[symbol]) {
            const transformedData = this.transformQuoteData(batchData[symbol], symbol);
            results[symbol] = transformedData;
            
            if (useCache) {
              const cacheKey = `quote:${symbol.toLowerCase()}`;
              await this.redisClient.setEx(cacheKey, this.cacheTTL, JSON.stringify(transformedData));
            }
            
            // Broadcast to WebSocket clients
            this.broadcastToSubscribers(symbol, transformedData);
          }
        }
      } catch (error) {
        console.error('Batch quote fetch failed:', error.message);
        throw error;
      }
    }
    
    return results;
  }
  
  async getHistoricalData(symbol, period = '1d', interval = '1h') {
    const cacheKey = `historical:${symbol.toLowerCase()}:${period}:${interval}`;
    
    // Validate parameters
    const validPeriods = ['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max'];
    const validIntervals = ['1m', '5m', '15m', '30m', '1h', '1d', '1wk', '1mo'];
    
    if (!validPeriods.includes(period)) {
      throw new Error(`Invalid period. Valid options: ${validPeriods.join(', ')}`);
    }
    
    if (!validIntervals.includes(interval)) {
      throw new Error(`Invalid interval. Valid options: ${validIntervals.join(', ')}`);
    }
    
    try {
      const cached = await this.redisClient.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (err) {
      // Cache miss is OK
    }
    
    if (this.enableRateLimiting) {
      try {
        await this.rateLimiter.consume(this.apiKey);
      } catch (err) {
        throw new Error(`Rate limit exceeded for historical data`);
      }
    }
    
    try {
      const response = await this.axiosInstance.get(`/historical/${symbol}`, {
        params: { period, interval }
      });
      
      const data = this.transformHistoricalData(response.data, symbol, period, interval);
      
      // Cache historical data (longer TTL for less frequent data)
      const historicalTTL = period === '1d' ? 3600 : 86400; // 1 hour or 1 day
      await this.redisClient.setEx(cacheKey, historicalTTL, JSON.stringify(data));
      
      return data;
    } catch (error) {
      throw new Error(`Failed to get historical data for ${symbol}: ${error.message}`);
    }
  }
  
  transformQuoteData(rawData, symbol) {
    return {
      symbol: symbol.toUpperCase(),
      price: parseFloat(rawData.price) || 0,
      change: parseFloat(rawData.change) || 0,
      changePercent: parseFloat(rawData.changePercent) || 0,
      volume: parseInt(rawData.volume) || 0,
      marketCap: rawData.marketCap ? parseInt(rawData.marketCap) : null,
      high: parseFloat(rawData.high) || null,
      low: parseFloat(rawData.low) || null,
      open: parseFloat(rawData.open) || null,
      previousClose: parseFloat(rawData.previousClose) || null,
      timestamp: new Date().toISOString(),
      source: 'stock-market-api-wrapper'
    };
  }
  
  transformHistoricalData(rawData, symbol, period, interval) {
    return {
      symbol: symbol.toUpperCase(),
      period,
      interval,
      data: Array.isArray(rawData) ? rawData.map(point => ({
        timestamp: point.timestamp,
        open: parseFloat(point.open) || 0,
        high: parseFloat(point.high) || 0,
        low: parseFloat(point.low) || 0,
        close: parseFloat(point.close) || 0,
        volume: parseInt(point.volume) || 0
      })) : [],
      metadata: {
        generatedAt: new Date().toISOString(),
        points: Array.isArray(rawData) ? rawData.length : 0
      }
    };
  }
  
  setupWebSocket() {
    const port = process.env.WS_PORT || 8080;
    this.wss = new WebSocket.Server({ port });
    
    this.wss.on('connection', (ws) => {
      console.log('🔌 New WebSocket connection');
      this.clients.add(ws);
      
      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message);
          this.handleWebSocketMessage(ws, data);
        } catch (err) {
          console.error('WebSocket message error:', err.message);
        }
      });
      
      ws.on('close', () => {
        console.log('🔌 WebSocket connection closed');
        this.clients.delete(ws);
        this.cleanupSubscriptions(ws);
      });
      
      ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
      });
    });
    
    console.log(`📡 WebSocket server started on port ${port}`);
  }
  
  handleWebSocketMessage(ws, data) {
    switch (data.type) {
      case 'subscribe':
        this.handleSubscription(ws, data.symbols);
        break;
      case 'unsubscribe':
        this.handleUnsubscription(ws, data.symbols);
        break;
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        break;
      default:
        ws.send(JSON.stringify({ 
          type: 'error', 
          message: 'Unknown message type' 
        }));
    }
  }
  
  handleSubscription(ws, symbols) {
    if (!Array.isArray(symbols)) {
      symbols = [symbols];
    }
    
    for (const symbol of symbols) {
      if (!this.subscriptions.has(symbol)) {
        this.subscriptions.set(symbol, new Set());
      }
      this.subscriptions.get(symbol).add(ws);
      
      // Send initial quote if available in cache
      this.sendCachedQuoteToClient(ws, symbol);
    }
    
    ws.send(JSON.stringify({
      type: 'subscribed',
      symbols: symbols,
      timestamp: Date.now()
    }));
  }
  
  handleUnsubscription(ws, symbols) {
    if (!Array.isArray(symbols)) {
      symbols = [symbols];
    }
    
    for (const symbol of symbols) {
      if (this.subscriptions.has(symbol)) {
        this.subscriptions.get(symbol).delete(ws);
        if (this.subscriptions.get(symbol).size === 0) {
          this.subscriptions.delete(symbol);
        }
      }
    }
    
    ws.send(JSON.stringify({
      type: 'unsubscribed',
      symbols: symbols,
      timestamp: Date.now()
    }));
  }
  
  async sendCachedQuoteToClient(ws, symbol) {
    try {
      const cacheKey = `quote:${symbol.toLowerCase()}`;
      const cached = await this.redisClient.get(cacheKey);
      if (cached) {
        ws.send(JSON.stringify({
          type: 'quote',
          symbol: symbol.toUpperCase(),
          data: JSON.parse(cached),
          timestamp: Date.now()
        }));
      }
    } catch (err) {
      // Cache read failed, ignore
    }
  }
  
  broadcastToSubscribers(symbol, data) {
    if (!this.subscriptions.has(symbol)) {
      return;
    }
    
    const message = JSON.stringify({
      type: 'quote',
      symbol: symbol.toUpperCase(),
      data: data,
      timestamp: Date.now()
    });
    
    for (const client of this.subscriptions.get(symbol)) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }
  
  cleanupSubscriptions(ws) {
    for (const [symbol, clients] of this.subscriptions.entries()) {
      clients.delete(ws);
      if (clients.size === 0) {
        this.subscriptions.delete(symbol);
      }
    }
  }
  
  async disconnect() {
    // Close WebSocket connections
    if (this.wss) {
      this.wss.close();
    }
    
    // Close Redis connection
    await this.redisClient.quit();
    
    console.log('🔌 Stock Market API Wrapper disconnected');
  }
}

// Export the class
module.exports = StockMarketAPI;

// Example usage when run directly
if (require.main === module) {
  (async () => {
    console.log('📈 Stock Market API Wrapper - Demo Mode\n');
    
    const api = new StockMarketAPI('demo-api-key', {
      cacheTTL: 600,
      retryAttempts: 5,
      enableWebSocket: true,
      enableRateLimiting: true
    });
    
    await api.connect();
    
    console.log('\n✅ API Wrapper ready');
    console.log('   WebSocket: ws://localhost:8080');
    console.log('   Use Ctrl+C to exit\n');
    
    // Keep the process running
    process.on('SIGINT', async () => {
      console.log('\n\n👋 Shutting down...');
      await api.disconnect();
      process.exit(0);
    });
  })().catch(console.error);
}