require('dotenv').config();
const path = require('path');
const express = require('express');
const app = express();

const { setupCookies } = require('./lib/cookies');
const { tokenMapping, deleteTokenFile } = require('./lib/state');

// Express JSON body parsing
app.use(express.json());

// CORS configuration (matching CORSMiddleware in main.py)
const frontendOrigin = process.env.FRONTEND_ORIGIN || "http://localhost:3000";
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", frontendOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE, PATCH");
    res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");

    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Port and BASE_URL configuration
function getRunningPort() {
    // Check --port argument (uvicorn/sys.argv style)
    const portArgIdx = process.argv.indexOf('--port');
    if (portArgIdx !== -1 && portArgIdx + 1 < process.argv.length) {
        const p = parseInt(process.argv[portArgIdx + 1], 10);
        if (!isNaN(p)) return p;
    }
    // Check PORT env var
    if (process.env.PORT) {
        const p = parseInt(process.env.PORT, 10);
        if (!isNaN(p)) return p;
    }
    return 8000;
}

const RUNNING_PORT = getRunningPort();
global.baseUrl = process.env.BASE_URL || `http://localhost:${RUNNING_PORT}`;

// Cookie decoding step at startup
global.youtubeCookiesPath = setupCookies();

// Expiry cleanup loops
function startPeriodicCleanup() {
    setInterval(() => {
        try {
            const now = Date.now();
            for (const [token, entry] of Object.entries(tokenMapping)) {
                if (now - entry.created_at > 3600 * 1000) { // 1 hour
                    console.log(`Token ${token} expired (1 hour passed). Cleaning up...`);
                    deleteTokenFile(token);
                }
            }
        } catch (err) {
            console.error("Error in periodic cleanup loop:", err.message);
        }
    }, 60000); // check every minute
}

// Start periodic cleanup task
startPeriodicCleanup();
console.log(`Using BASE_URL for file serving: ${global.baseUrl}`);

// Serve static files from 'public' directory (index.html at root '/')
app.use(express.static(path.join(__dirname, 'public')));

// Swagger API Documentation Setup
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./swagger');
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Register routes
app.use('/', require('./routes/index'));

// Run server
app.listen(RUNNING_PORT, () => {
    console.log(`Server running on port ${RUNNING_PORT}`);
});
