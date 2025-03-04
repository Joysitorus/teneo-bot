const WebSocket = require('ws');
const { promisify } = require('util');
const fs = require('fs');
const readline = require('readline');
const axios = require('axios');
const HttpsProxyAgent = require('https-proxy-agent');

// Helper functions for file operations
const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);

// Read environment variables from .env file
require('dotenv').config();

// Initialize readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

let socket = null;
let pingInterval;
let countdownInterval;
let potentialPoints = 0;
let countdown = "Calculating...";
let pointsTotal = 0;
let pointsToday = 0;

// Load environment variables
const auth = process.env.AUTH_TOKEN;
const email = process.env.EMAIL;
const password = process.env.PASSWORD;

async function getLocalStorage() {
  try {
    const data = await readFileAsync('localStorage.json', 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error("Error reading localStorage.json:", error.message);
    return {};
  }
}

async function setLocalStorage(data) {
  try {
    const currentData = await getLocalStorage();
    const newData = { ...currentData, ...data };
    await writeFileAsync('localStorage.json', JSON.stringify(newData));
  } catch (error) {
    console.error("Error writing to localStorage.json:", error.message);
  }
}

async function connectWebSocket(token, proxy) {
  if (socket) return;

  const version = "v0.2";
  const url = "wss://secure.ws.teneo.pro";
  const wsUrl = `${url}/websocket?accessToken=${encodeURIComponent(token)}&version=${encodeURIComponent(version)}`;

  const options = { agent: new HttpsProxyAgent(proxy) };

  socket = new WebSocket(wsUrl, options);

  socket.onopen = async () => {
    const connectionTime = new Date().toISOString();
    await setLocalStorage({ lastUpdated: connectionTime });
    console.log("WebSocket connected at", connectionTime);
    startPinging();
    startCountdownAndPoints();
  };

  socket.onmessage = async (event) => {
    try {
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
    } catch (error) {
      console.error("Error handling WebSocket message:", error.message);
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
  try {
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
  } catch (error) {
    console.error("Error updating countdown and points:", error.message);
  }
}

async function getUserId(proxy) {
  const loginUrl = "https://auth.teneo.pro/api/login";

  try {
    const response = await axios.post(
      loginUrl,
      { email: email, password: password },
      {
        headers: {
          'x-api-key': process.env.REFF_CODE,
        },
        httpsAgent: new HttpsProxyAgent(proxy),
      }
    );

    const access_token = response.data.access_token;

    await setLocalStorage({ access_token });
    await startCountdownAndPoints();
    await connectWebSocket(access_token, proxy);
  } catch (error) {
    console.error("Error during login:", error.response ? error.response.data : error.message);
  }
}

async function main() {
  try {
    // Read proxy from dataProxy.txt
    const proxy = await readFileAsync('dataProxy.txt', 'utf8').then((data) => data.trim());
    if (!proxy) {
      console.error("Proxy is required but not found in dataProxy.txt. Exiting...");
      process.exit(1);
    }

    const localStorageData = await getLocalStorage();
    let access_token = localStorageData.access_token;

    if (!access_token) {
      console.log("Access token not found. Logging in...");
      await getUserId(proxy);
    } else {
      console.log("Access token found. Starting WebSocket connection...");
      await startCountdownAndPoints();
      await connectWebSocket(access_token, proxy);
    }
  } catch (error) {
    console.error("Error in main function:", error.message);
  }
}

// Run the program
main();