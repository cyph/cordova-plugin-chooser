const { readFile, writeFile } = require('fs').promises;
const { basename } = require('path');

/**
 * Tries to read the file located in the provided path.
 * An error is thrown if the operation fails.
 * @param {string} path the path where the file is located
 * @returns {Buffer} the file content
 */
 const tryReadFile = (path) => {
    try {
        return readFile(path);
    } catch (err) {
        throw new Error(`Unable to find ${basename(path)}: ${err}`);
    }
};

/**
 * Tries to write a file in the provided path.
 * An error is thrown if the operation fails.
 * @param {string} path the path where the file is located
 * @param {string} contentToAdd the content to write in the file
 */
 const tryWriteFile = (path, contentToAdd) => {
    try {
        return writeFile(path, contentToAdd, 'utf8');
    } catch (err) {
        throw new Error(`Unable to write into ${basename(path)}: ${err}`);
    }
};

module.exports = {
    tryReadFile: tryReadFile,
    tryWriteFile: tryWriteFile
};
