const WebSocket = require('ws');
const { promisify } = require('util');
const fs = require('fs');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

let socket = null;
let pingInterval;
let countdownInterval;
let potentialPoints = 0;
let countdown = "Calculating...";
let pointsTotal = 0;
let pointsToday = 0;

const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);

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

async function getProxy() {
  try {
    const proxyData = await readFileAsync('dataProxy.txt', 'utf8');
    const proxies = proxyData.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    if (proxies.length === 0) {
      console.log('No proxies found in dataProxy.txt. Using default settings.');
      return null;
    }

    // Looping untuk mencari proxy valid
    for (const proxy of proxies) {
      if (await isValidProxy(proxy)) {
        console.log(`Using valid proxy: ${proxy}`);
        return proxy;
      }
    }

    console.log('No valid proxies found. Using default settings.');
    return null;
  } catch (error) {
    console.error('Error reading dataProxy.txt:', error.message);
    return null;
  }
}

async function connectWebSocket(token, proxy) {
  if (socket) return;
  const version = "v0.2";
  const url = "wss://secure.ws.teneo.pro";
  const wsUrl = `${url}/websocket?accessToken=${encodeURIComponent(token)}&version=${encodeURIComponent(version)}`;

  const options = {};
  if (proxy) {
    try {
      options.agent = new HttpsProxyAgent(proxy); // Pastikan proxy valid
    } catch (error) {
      console.error(`Failed to use proxy: ${proxy}. Using default connection.`);
      proxy = null; // Gunakan koneksi default jika proxy gagal
    }
  }

  socket = new WebSocket(wsUrl, options);

  socket.onopen = async () => {
    const connectionTime = new Date().toISOString();
    await setLocalStorage({ lastUpdated: connectionTime });
    console.log("WebSocket connected at ", connectionTime);
    startPinging();
    startCountdownAndPoints();
  };

  socket.onmessage = async (event) => {
    const data = JSON.parse(event.data);
    console.log("Received message from WebSocket:", data);
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

  let reconnectAttempts = 0;
  socket.onclose = () => {
    socket = null;
    console.log("WebSocket disconnected");
    stopPinging();
    const delay = Math.min(1000 * 2 ** reconnectAttempts, 30000);
    setTimeout(() => connectWebSocket(token, proxy), delay);
    reconnectAttempts++;
  };

  socket.onerror = (error) => {
    console.error("WebSocket error:", error.message);
  };
}

function disconnectWebSocket() {
  if (socket) {
    socket.close();
    socket = null;
    stopPinging();
  }
}

function startPinging() {
  stopPinging();
  pingInterval = setInterval(async () => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "PING" }));
      await setLocalStorage({ lastPingDate: new Date().toISOString() });
    }
  }, 10000);
}

function stopPinging() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

process.on('SIGINT', () => {
  console.log('Received SIGINT. Stopping pinging and disconnecting WebSocket...');
  stopPinging();
  disconnectWebSocket();
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

async function main() {
  const localStorageData = await getLocalStorage();
  let access_token = localStorageData.access_token;

  if (!access_token) {
    access_token = await loadAccessToken();
    console.log("Loaded access token from .env:", access_token); // Debugging line
    if (!access_token) {
      console.error("Access token not found in localStorage or .env file. Exiting...");
      process.exit(1);
    }
  }

  const proxy = await getProxy(); // Ambil proxy secara acak dari file
  await startCountdownAndPoints();
  await connectWebSocket(access_token, proxy); // Gunakan proxy yang dipilih
}

// Run the program
main();