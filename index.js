const WebSocket = require('ws');
const { promisify } = require('util');
const fs = require('fs');
const readline = require('readline');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

let sockets = []; // Array untuk menyimpan semua koneksi WebSocket
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
  const currentData = await getLocalStorage();
  const newData = { ...currentData, ...data };
  try {
    await writeFileAsync('localStorage.json', JSON.stringify(newData));
  } catch (error) {
    console.error('Error writing to localStorage.json:', error.message);
  }
}

async function isValidProxy(proxy) {
  try {
    new HttpsProxyAgent(proxy); // Coba inisialisasi proxy
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
    if (proxies.length === 0) {
      console.log('No proxies found in dataProxy.txt. Using default settings.');
      return [];
    }

    // Filter hanya proxy yang valid
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
      if (key && value) {
        envVars[key.trim()] = value.trim();
      }
    });
    return envVars.ACCESS_TOKEN || null;
  } catch (error) {
    console.error('Error loading .env file:', error.message);
    return null;
  }
}

async function connectWebSocket(token, proxy) {
  const version = "v0.2";
  const url = "wss://secure.ws.teneo.pro";
  const wsUrl = `${url}/websocket?accessToken=${encodeURIComponent(token)}&version=${encodeURIComponent(version)}`;

  const options = {};
  if (proxy) {
    options.agent = new HttpsProxyAgent(proxy);
  }

  const socket = new WebSocket(wsUrl, options);

  socket.onopen = async () => {
    const connectionTime = new Date().toISOString();
    console.log(`WebSocket connected via proxy: ${proxy} at ${connectionTime}`);
    startPinging(socket);
  };

  socket.onmessage = async (event) => {
    const data = JSON.parse(event.data);
    console.log(`Received message from WebSocket via proxy: ${proxy}:`, data);
    if (data.pointsTotal !== undefined && data.pointsToday !== undefined) {
      const lastUpdated = new Date().toISOString();
      await setLocalStorage({
        lastUpdated: lastUpdated,
        pointsTotal: data.pointsTotal,
        pointsToday: data.pointsToday,
      });
      pointsTotal = data.pointsTotal;
      pointsToday = data.pointsToday;
    }
  };

  socket.onclose = () => {
    console.log(`WebSocket disconnected via proxy: ${proxy}`);
    stopPinging(socket);
  };

  socket.onerror = (error) => {
    console.error(`WebSocket error via proxy: ${proxy}:`, error.message);
  };

  return socket;
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
  }
}

function disconnectAllWebSockets() {
  sockets.forEach(socket => {
    if (socket) {
      socket.close();
    }
  });
  sockets = [];
  pingIntervals.forEach(interval => clearInterval(interval));
  pingIntervals = [];
}

process.on('SIGINT', () => {
  console.log('Received SIGINT. Stopping pinging and disconnecting all WebSockets...');
  disconnectAllWebSockets();
  process.exit(0);
});

function startCountdownAndPoints() {
  clearInterval(countdownInterval);
  updateCountdownAndPoints();
  countdownInterval = setInterval(updateCountdownAndPoints, 60 * 1000); // 1 minute interval
}

async function updateCountdownAndPoints() {
  const { lastUpdated, pointsTotal, pointsToday } = await getLocalStorage();
  if (lastUpdated) {
    const nextHeartbeat = new Date(lastUpdated);
    nextHeartbeat.setMinutes(nextHeartbeat.getMinutes() + 15);
    const now = new Date();
    const diff = nextHeartbeat.getTime() - now.getTime();

    if (diff > 0) {
      const minutes = Math.floor(diff / 60000);
      const seconds = Math.floor((diff % 60000) / 1000);
      countdown = `${minutes}m ${seconds}s`;

      const maxPoints = 25;
      const timeElapsed = now.getTime() - new Date(lastUpdated).getTime();
      const timeElapsedMinutes = timeElapsed / (60 * 1000);
      let newPoints = Math.min(maxPoints, (timeElapsedMinutes / 15) * maxPoints);
      newPoints = parseFloat(newPoints.toFixed(2));

      if (Math.random() < 0.1) {
        const bonus = Math.random() * 2;
        newPoints = Math.min(maxPoints, newPoints + bonus);
        newPoints = parseFloat(newPoints.toFixed(2));
      }

      potentialPoints = newPoints;
    } else {
      countdown = "Calculating...";
      potentialPoints = 25;
    }
  } else {
    countdown = "Calculating...";
    potentialPoints = 0;
  }
  console.log("Total Points:", pointsTotal, "| Today Points:", pointsToday, "| Countdown:", countdown);
  await setLocalStorage({ potentialPoints, countdown });
}

async function main() {
  const localStorageData = await getLocalStorage();
  let access_token = localStorageData.access_token;

  if (!access_token) {
    access_token = await loadAccessToken(); // Memuat token dari file .env
    console.log("Loaded access token from .env:", access_token);
    if (!access_token) {
      console.error("Access token not found in localStorage or .env file. Exiting...");
      process.exit(1);
    }
  }

  const proxies = await getProxies(); // Ambil semua proxy valid
  if (proxies.length === 0) {
    console.log("No valid proxies found. Using default connection.");
    const socket = await connectWebSocket(access_token, null);
    sockets.push(socket);
  } else {
    // Buat koneksi WebSocket untuk setiap proxy
    for (const proxy of proxies) {
      const socket = await connectWebSocket(access_token, proxy);
      sockets.push(socket);
    }
  }
}

// Run the program
main();
