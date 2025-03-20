# Teneo Auto Bot with Proxy

## Features

- **Global Error Handlers**: Prevent the process from crashing on unhandled errors.
- **WebSocket Reconnection Logic**: Handle WebSocket to automatically reconnect.
- **Periodically Check Connections**: Monitoring health checks for WebSockets.
- **Cross-Platform Compatibility**: Works on Windows, macOS, and Linux.

## 🚀 Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/Joysitorus/layeredge-bot
   cd layeredge-bot
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a .env file and add your access token:
   ```bash
   ACCESS_TOKEN=your_access_token_here
   ```
4. Create a dataProxy.txt file and store your proxy here:
   ```bash
   http://username:password@host:port
   ```
5. Run Bot
   ```bash
   node index.js
   ```
