const WebSocket = require('ws');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');
require('dotenv').config();

// Global error handling
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Global state
let connections = [];
let writeTimeout;
let countdown = "Calculating...";
let pointsTotal = 0;
let pointsToday = 0;

// Promisified filesystem methods
const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);

// Debounced file writing
const debounceWrite = (data) => {
  clearTimeout(writeTimeout);
  writeTimeout = setTimeout(() => setLocalStorage(data), 5000);
};

// Local storage management
async function getLocalStorage() {
  try {
    return JSON.parse(await readFileAsync('localStorage.json', 'utf8'));
  } catch (error) {
    return {};
  }
}

async function setLocalStorage(data) {
  const currentData = await getLocalStorage();
  await writeFileAsync('localStorage.json', JSON.stringify({...currentData, ...data}));
}

// WebSocket creation
function createSocket(token, proxy) {
  const url = `wss://secure.ws.teneo.pro/websocket?accessToken=${encodeURIComponent(token)}&version=v0.2`;
  const agent = proxy ? new HttpsProxyAgent(proxy) : null;
  return new WebSocket(url, { agent });
}

// Connection management
function setupSocketHandlers(socket, proxy) {
  let isConnected = false;
  let pingInterval;
  let reconnectTimeout;

  const cleanup = () => {
    clearInterval(pingInterval);
    clearTimeout(reconnectTimeout);
    connections = connections.filter(conn => conn.socket !== socket);
  };

  const reconnect = (delay) => {
    cleanup();
    reconnectTimeout = setTimeout(() => {
      const newSocket = createSocket(socket.accessToken, proxy);
      connections.push({
        socket: newSocket,
        proxy,
        pingInterval: null
      });
      setupSocketHandlers(newSocket, proxy);
    }, delay);
  };

  socket.onopen = () => {
    isConnected = true;
    console.log(`Connected via ${proxy || 'direct'}`);
    pingInterval = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "PING" }));
      }
    }, 10000);
  };

  socket.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.pointsTotal !== undefined && data.pointsToday !== undefined) {
        pointsTotal = data.pointsTotal;
        pointsToday = data.pointsToday;
        debounceWrite({
          lastUpdated: new Date().toISOString(),
          pointsTotal,
          pointsToday
        });
      }
    } catch (error) {
      console.error('Message handling error:', error);
    }
  };

  socket.onclose = () => {
    cleanup();
    console.log(`Disconnected from ${proxy || 'direct'}`);
    reconnect(isConnected ? 120000 : 3600000); // 2m or 60m retry
  };

  socket.onerror = (error) => {
    console.error(`Connection error (${proxy || 'direct'}):`, error.message);
    if (!isConnected) socket.close();
  };
}

// Token loading
async function loadAccessToken() {
  try {
    // Try to read from .env file
    const envPath = path.resolve(process.cwd(), '.env');
    const envData = await readFileAsync(envPath, 'utf8');
    const envVars = envData.split('\n').reduce((acc, line) => {
      const [key, value] = line.split('=').map(s => s.trim());
      if (key && value) acc[key] = value;
      return acc;
    }, {});
    
    return envVars.ACCESS_TOKEN || process.env.ACCESS_TOKEN;
  } catch (error) {
    // Fallback to environment variables
    return process.env.ACCESS_TOKEN;
  }
}

// Proxy handling
async function getProxies() {
  try {
    const proxyData = await readFileAsync('dataProxy.txt', 'utf8');
    return proxyData.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
  } catch (error) {
    return [];
  }
}

// Main initialization
async function main() {
  try {
    // Load access token from multiple sources
    const storageData = await getLocalStorage();
    let access_token = storageData.access_token || 
                      await loadAccessToken() || 
                      process.env.ACCESS_TOKEN;

    if (!access_token) {
      throw new Error("Access token not found in:\n" + 
                      "- localStorage.json\n" + 
                      "- .env file\n" + 
                      "- Environment variables");
    }

    // Load proxies
    const proxies = await getProxies();
    
    // Establish connections
    proxies.forEach(proxy => {
      const socket = createSocket(access_token, proxy);
      connections.push({ socket, proxy, pingInterval: null });
      setupSocketHandlers(socket, proxy);
    });

    // Create direct connection if no proxies
    if (proxies.length === 0) {
      const socket = createSocket(access_token, null);
      connections.push({ socket, proxy: null, pingInterval: null });
      setupSocketHandlers(socket, null);
    }

    // Regular connection cleanup
    setInterval(() => {
      connections = connections.filter(conn => {
        const isAlive = conn.socket.readyState === WebSocket.OPEN;
        if (!isAlive) {
          clearInterval(conn.pingInterval);
          conn.socket.removeAllListeners();
        }
        return isAlive;
      });
    }, 60000); // Cleanup every 1 minute

    // Countdown updates
    const updateCountdown = async () => {
      const storage = await getLocalStorage();
      const lastUpdated = storage.lastUpdated;
      
      if (lastUpdated) {
        const nextUpdate = new Date(lastUpdated);
        nextUpdate.setMinutes(nextUpdate.getMinutes() + 15);
        const now = new Date();
        const diff = nextUpdate - now;

        if (diff > 0) {
          const minutes = Math.floor(diff / 60000);
          const seconds = Math.floor((diff % 60000) / 1000);
          countdown = `${minutes}m ${seconds}s`;
        } else {
          countdown = "Updating...";
        }
      }
      
      console.log(`Points: Total=${pointsTotal} Today=${pointsToday} | Next: ${countdown}`);
    };

    setInterval(updateCountdown, 60000); // Update every 1 minute
    updateCountdown();

  } catch (error) {
    console.error('Initialization error:', error.message);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  connections.forEach(conn => {
    conn.socket.close();
    clearInterval(conn.pingInterval);
  });
  process.exit(0);
});

// Start application
main();
