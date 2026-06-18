const fs = require('fs');

// Global map tracking active download tokens
const tokenMapping = {};

/**
 * Deletes the temporary file associated with a token and removes it from mapping.
 * @param {string} token 
 */
function deleteTokenFile(token) {
    const entry = tokenMapping[token];
    if (entry) {
        delete tokenMapping[token];
        const filePath = entry.path;
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`Deleted temp file: ${filePath} associated with token ${token}`);
            }
        } catch (err) {
            console.error(`Error deleting temp file ${filePath}:`, err.message);
        }
    }
}

module.exports = {
    tokenMapping,
    deleteTokenFile
};
