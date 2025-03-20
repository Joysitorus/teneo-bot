const WebSocket = require('ws');
const { promisify } = require('util');
const fs = require('fs');
const readline = require('readline');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Global error handling
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

let sockets = [];
let pingIntervals = [];
let countdownInterval;
let potentialPoints = 0;
let countdown = "Calculating...";
let pointsTotal = 0;
let pointsToday = 0;

const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function getLocalStorage() {
  try {
    const data = await readFileAsync('localStorage.json', 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading localStorage.json:', error.message);
    return {};
  }
}

async function setLocalStorage(data) {
  try {
    const currentData = await getLocalStorage();
    const newData = { ...currentData, ...data };
    await writeFileAsync('localStorage.json', JSON.stringify(newData));
  } catch (error) {
    console.error('Error writing to localStorage.json:', error.message);
  }
}

async function isValidProxy(proxy) {
  try {
    new HttpsProxyAgent(proxy);
    return true;
  } catch (error) {
    console.error(`Invalid proxy: ${proxy}`);
    return false;
  }
}

async function getProxies() {
  try {
    const proxyData = await readFileAsync('dataProxy.txt', 'utf8');
    const proxies = proxyData.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    const validProxies = [];
    
    for (const proxy of proxies) {
      if (await isValidProxy(proxy)) {
        validProxies.push(proxy);
      }
    }
    
    console.log(`Found ${validProxies.length} valid proxies.`);
    return validProxies;
  } catch (error) {
    console.error('Error reading dataProxy.txt:', error.message);
    return [];
  }
}

async function loadAccessToken() {
  try {
    const envData = await readFileAsync('.env', 'utf8');
    const envVars = {};
    envData.split('\n').forEach(line => {
      const [key, value] = line.split('=');
      if (key && value) envVars[key.trim()] = value.trim();
    });
    return envVars.ACCESS_TOKEN || null;
  } catch (error) {
    console.error('Error loading .env file:', error.message);
    return null;
  }
}

function startPinging(socket) {
  const interval = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "PING" }));
    }
  }, 10000);
  pingIntervals.push(interval);
}

function stopPinging(socket) {
  const index = sockets.indexOf(socket);
  if (index !== -1) {
    clearInterval(pingIntervals[index]);
    pingIntervals.splice(index, 1);
    sockets.splice(index, 1);
  }
}

async function connectWebSocket(token, proxy) {
  const version = "v0.2";
  const url = "wss://secure.ws.teneo.pro";
  const wsUrl = `${url}/websocket?accessToken=${encodeURIComponent(token)}&version=${encodeURIComponent(version)}`;

  let reconnectAttempts = 0;
  const maxReconnectAttempts = 5;
  let socket;

  const connect = async () => {
    const options = proxy ? { agent: new HttpsProxyAgent(proxy) } : {};
    socket = new WebSocket(wsUrl, options);

    socket.onopen = async () => {
      reconnectAttempts = 0;
      console.log(`Connected via ${proxy || 'direct'}`);
      startPinging(socket);
    };

    socket.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log(`Received update via ${proxy || 'direct'}:`, data);
        
        if (data.pointsTotal !== undefined && data.pointsToday !== undefined) {
          await setLocalStorage({
            lastUpdated: new Date().toISOString(),
            pointsTotal: data.pointsTotal,
            pointsToday: data.pointsToday
          });
          pointsTotal = data.pointsTotal;
          pointsToday = data.pointsToday;
        }
      } catch (error) {
        console.error('Message handling error:', error);
      }
    };

    socket.onclose = () => {
      console.log(`Disconnected from ${proxy || 'direct'}. Reconnecting...`);
      stopPinging(socket);
      
      if (reconnectAttempts < maxReconnectAttempts) {
        const delay = Math.min(5000 * (reconnectAttempts + 1), 30000);
        setTimeout(connect, delay);
        reconnectAttempts++;
      }
    };

    socket.onerror = (error) => {
      console.error(`Connection error (${proxy || 'direct'}):`, error.message);
    };
  };

  await connect();
  return socket;
}

async function updateCountdownAndPoints() {
  try {
    const localStorageData = await getLocalStorage();
    const lastUpdated = localStorageData.lastUpdated;
    const pointsTotal = Number(localStorageData.pointsTotal) || 0;
    const pointsToday = Number(localStorageData.pointsToday) || 0;

    if (lastUpdated) {
      const nextHeartbeat = new Date(lastUpdated);
      nextHeartbeat.setMinutes(nextHeartbeat.getMinutes() + 15);
      const now = new Date();
      const diff = nextHeartbeat.getTime() - now.getTime();

      if (diff > 0) {
        const minutes = Math.floor(diff / 60000);
        const seconds = Math.floor((diff % 60000) / 1000);
        countdown = `${minutes}m ${seconds}s`;

        const timeElapsed = now.getTime() - new Date(lastUpdated).getTime();
        let newPoints = Math.min(25, (timeElapsed / (15 * 60 * 1000)) * 25);
        newPoints = Math.random() < 0.1 ? 
          Math.min(25, newPoints + Math.random() * 2) : newPoints;
        potentialPoints = parseFloat(newPoints.toFixed(2));
      } else {
        countdown = "Calculating...";
        potentialPoints = 25;
      }
    }
    
    console.log(`Points: Total=${pointsTotal} Today=${pointsToday} | Next: ${countdown}`);
    await setLocalStorage({ potentialPoints, countdown });
  } catch (error) {
    console.error('Countdown update error:', error);
  }
}

function startCountdownAndPoints() {
  updateCountdownAndPoints();
  countdownInterval = setInterval(updateCountdownAndPoints, 60000);
}

function healthCheck() {
  setInterval(() => {
    sockets.forEach((socket, index) => {
      if (socket.readyState !== WebSocket.OPEN) {
        console.log(`Reconnecting dead connection #${index}`);
        stopPinging(socket);
        socket.removeAllListeners();
        sockets.splice(index, 1);
      }
    });
  }, 300000); // 5-minute health check
}

async function main() {
  try {
    const localStorageData = await getLocalStorage();
    let access_token = localStorageData.access_token || await loadAccessToken();

    if (!access_token) {
      console.error("No access token found");
      process.exit(1);
    }

    const proxies = await getProxies();
    if (proxies.length === 0) {
      console.log("Using direct connection");
      sockets.push(await connectWebSocket(access_token, null));
    } else {
      for (const proxy of proxies) {
        sockets.push(await connectWebSocket(access_token, proxy));
      }
    }

    startCountdownAndPoints();
    healthCheck();
  } catch (error) {
    console.error('Initialization failed:', error);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');
  clearInterval(countdownInterval);
  sockets.forEach(socket => {
    socket.close();
    socket.removeAllListeners();
  });
  pingIntervals.forEach(clearInterval);
  process.exit(0);
});

main();
