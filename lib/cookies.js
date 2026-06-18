const fs = require('fs');
const path = require('path');

function setupCookies() {
    const cookiesB64 = process.env.YOUTUBE_COOKIES_B64;
    if (!cookiesB64) {
        console.log("No YOUTUBE_COOKIES_B64 environment variable found. Proceeding without custom cookies.");
        return null;
    }

    const filePath = '/app/youtube_cookies.txt';
    try {
        const dir = path.dirname(filePath);
        if (dir) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, Buffer.from(cookiesB64, 'base64'));
        console.log(`Successfully decoded and wrote YouTube cookies to ${filePath}`);
        return filePath;
    } catch (err) {
        console.error(`Failed to write YouTube cookies to ${filePath}:`, err.message);
        
        // Fallback for local development/Windows: write inside the project temp directory
        try {
            const localDir = path.join(__dirname, '..', 'temp');
            fs.mkdirSync(localDir, { recursive: true });
            const localFilePath = path.join(localDir, 'youtube_cookies.txt');
            fs.writeFileSync(localFilePath, Buffer.from(cookiesB64, 'base64'));
            console.log(`Fallback: Successfully wrote YouTube cookies to local path ${localFilePath}`);
            return localFilePath;
        } catch (fallbackErr) {
            console.error(`Fallback failed to write YouTube cookies:`, fallbackErr.message);
            return null;
        }
    }
}

module.exports = { setupCookies };
