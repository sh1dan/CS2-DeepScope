# 🎯 CS2 DeepScope

<div align="center">

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)
![PM2](https://img.shields.io/badge/PM2-Ready-green.svg)

**A production-ready Node.js/TypeScript service for fetching CS2 player profiles from the Game Coordinator via REST API**

[Features](#-features) • [Installation](#-installation) • [Usage](#-usage) • [API Reference](#-api-reference) • [Deployment](#-deployment)

</div>

---

## ✨ Features

- 🔐 **Automatic Steam Authentication** - No 2FA required after first login (session persistence)
- 🎮 **Direct Game Coordinator Connection** - Connects to the real CS2 Game Coordinator
- 📊 **Player Profile Data** - Fetch commendations, medals, and XP level
- 🚀 **REST API** - Clean HTTP endpoints for easy integration
- 🛡️ **Production Ready** - CORS support, rate limiting, and error handling
- 🔄 **Auto-Restart** - Built-in watchdog mechanism with PM2 support
- 📝 **Structured Logging** - Winston-based logging with colored console output
- ⚡ **Optional Caching** - File-based caching for faster repeated requests

## 📋 Prerequisites

- **Node.js** >= 18.0.0
- **npm** >= 9.0.0
- **Steam Account** with CS2 access
- **Steam Guard Mobile Authenticator** (for shared secret)

## 🚀 Installation

### 1. Clone the repository

```bash
git clone https://github.com/your-username/cs2-deepscope.git
cd cs2-deepscope
```

### 2. Install dependencies

```bash
npm install
```

### 3. Build the project

```bash
npm run build
```

### 4. Configure environment variables

Copy the example environment file and configure it:

```bash
cp env.example .env
```

Edit `.env` with your credentials:

```env
# Required
STEAM_USERNAME=your_steam_username
STEAM_PASSWORD=your_steam_password
STEAM_SHARED_SECRET=your_shared_secret_from_mobile_authenticator

# Optional
API_PORT=3000
ENABLE_FILE_CACHE=false
OUTPUT_DIR=./output
LOG_LEVEL=info
```

> **Note:** The `STEAM_SHARED_SECRET` is required for automatic 2FA code generation. You can extract it from your Steam Mobile Authenticator.

### 5. Start the service

**Option A: Development mode (for testing)**

```bash
npm start
```

**Option B: Production mode with PM2 (recommended)**

```bash
# Install PM2 globally (if not already installed)
npm install -g pm2

# Start using ecosystem config
npm run pm2:start

# Or directly
pm2 start ecosystem.config.js
```

## 📖 Usage

### First Run

On the first run, the service will:
1. Authenticate with Steam (2FA code will be auto-generated)
2. Save session tokens (`loginKey`, `refreshToken`, `machineAuthToken`)
3. Connect to CS2 Game Coordinator
4. Start the REST API server

**Subsequent runs** will use saved tokens and won't require 2FA.

### PM2 Management

```bash
# View running processes
pm2 list

# View logs
npm run pm2:logs
# or
pm2 logs cs2-deepscope

# Restart service
npm run pm2:restart

# Stop service
npm run pm2:stop

# Delete from PM2
npm run pm2:delete

# Save PM2 configuration
pm2 save

# Setup PM2 to start on system boot
pm2 startup
```

## 🔌 API Reference

### Base URL

```
http://localhost:3000
```

### Endpoints

#### `GET /api/health`

Health check endpoint to verify service status.

**Response:**

```json
{
  "status": "ok",
  "gcReady": true,
  "timestamp": "2025-01-20T12:00:00.000Z"
}
```

#### `GET /api/profile/:steamId64`

Fetch player profile data from Game Coordinator.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `steamId64` | string | Steam ID 64 (17 digits) |

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `force` | boolean | `false` | Force fresh data (ignore cache) |

**Example Request:**

```bash
curl http://localhost:3000/api/profile/76561199441016438
```

**Example Response:**

```json
{
  "steamId64": "76561199441016438",
  "commendations": {
    "friendly": 10,
    "leader": 5,
    "teacher": 3
  },
  "medals": [
    {
      "medalId": 5211
    },
    {
      "medalId": 6120
    }
  ],
  "equippedMedal": {
    "medalId": 5211
  },
  "xpLevel": 25,
  "fetchedAt": "2025-01-20T12:00:00.000Z",
  "cached": false
}
```

**Error Responses:**

| Status Code | Description |
|-------------|-------------|
| `400` | Invalid Steam ID 64 format |
| `503` | Game Coordinator not ready |
| `500` | Internal server error |

### Rate Limiting

API endpoints are rate-limited to **100 requests per 15 minutes** per IP address. The health check endpoint (`/api/health`) is excluded from rate limiting.

## 🛠️ Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `STEAM_USERNAME` | ✅ Yes | - | Steam account username |
| `STEAM_PASSWORD` | ✅ Yes | - | Steam account password |
| `STEAM_SHARED_SECRET` | ✅ Yes | - | Shared secret from Steam Mobile Authenticator |
| `API_PORT` | ❌ No | `3000` | Port for REST API server |
| `ENABLE_FILE_CACHE` | ❌ No | `false` | Enable file-based profile caching |
| `OUTPUT_DIR` | ❌ No | `./output` | Directory for cached profiles |
| `LOG_LEVEL` | ❌ No | `info` | Logging level (`error`, `warn`, `info`, `debug`) |

### File Caching

When `ENABLE_FILE_CACHE=true`, player profiles are saved to disk in `output/profiles/` directory. This is useful for:
- Faster repeated requests
- Offline access to cached data
- Debugging and analysis

**Note:** If you only use the API endpoint, file caching is not necessary and can be disabled.

## 🔒 Security Features

- ✅ **CORS** - Cross-origin resource sharing enabled
- ✅ **Rate Limiting** - 100 requests per 15 minutes per IP
- ✅ **Input Validation** - Steam ID 64 format validation
- ✅ **Error Handling** - Comprehensive error handling and logging
- ✅ **Environment Variables** - Sensitive data stored in `.env` (not committed)

## ⚠️ Important Notes

### Watchdog Mechanism

The service includes a built-in watchdog that monitors Steam disconnections. After **5 consecutive disconnections**, the service will automatically exit (`process.exit(1)`).

**For automatic restart, use PM2:**

```bash
npm run pm2:start
```

PM2 will automatically restart the service when it exits, allowing recovery from critical errors.

### Valve Protobuf Updates

This service uses `node-cs2`, which depends on Valve's protobuf definitions. When CS2 receives major updates (e.g., new operations or UI changes), protobufs may change.

**Symptoms of outdated protobufs:**
- Service connects but `profileFetcher` returns empty or incorrect data
- Profiles missing expected fields
- Response structure changed

**Solution:**

```bash
npm update node-cs2
```

If the library hasn't been updated yet, the service may be non-functional until an update is released.

### Session Persistence

Session tokens are automatically saved to:
- `machineAuthToken_*.json` - Machine authentication token
- `loginKey_*.txt` - Login key for quick re-authentication
- `sentry_*.bin` - Legacy sentry file (fallback)

These files are automatically created and should **never** be committed to version control (already in `.gitignore`).

## 📁 Project Structure

```
cs2-deepscope/
├── src/
│   ├── api/           # REST API server
│   ├── auth/           # Steam authentication
│   ├── gc/             # Game Coordinator connection
│   ├── types/          # TypeScript type definitions
│   └── utils/          # Utilities (logger, banner)
├── dist/               # Compiled JavaScript (generated)
├── logs/               # Log files (generated)
├── output/             # Cached profiles (if enabled)
├── ecosystem.config.js # PM2 configuration
├── env.example         # Environment variables template
├── package.json        # Dependencies and scripts
├── tsconfig.json       # TypeScript configuration
└── README.md           # This file
```

## 🧪 Development

### Development Mode

```bash
# Run in development mode with ts-node
npm run dev

# Watch mode for TypeScript compilation
npm run watch
```

### Building

```bash
# Compile TypeScript to JavaScript
npm run build
```

## 📝 Scripts

| Script | Description |
|--------|-------------|
| `npm run build` | Compile TypeScript to JavaScript |
| `npm start` | Start the service (production) |
| `npm run dev` | Start in development mode |
| `npm run watch` | Watch mode for TypeScript compilation |
| `npm run pm2:start` | Start with PM2 using ecosystem config |
| `npm run pm2:stop` | Stop PM2 process |
| `npm run pm2:restart` | Restart PM2 process |
| `npm run pm2:logs` | View PM2 logs |
| `npm run pm2:delete` | Delete PM2 process |

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [node-cs2](https://github.com/DoctorMcKay/node-cs2) - CS2 Game Coordinator library
- [steam-user](https://github.com/DoctorMcKay/node-steam-user) - Steam client library
- [PM2](https://pm2.keymetrics.io/) - Process manager for Node.js

## 📧 Support

If you encounter any issues or have questions, please open an issue on GitHub.

---

<div align="center">

**Made with ❤️ for the CS2 community**

⭐ Star this repo if you find it useful!

</div>
