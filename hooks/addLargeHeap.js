const { existsSync } = require('fs');
const { basename } = require('path');
const { getAppNameCreator } = require('./cordovaUtils');
const { tryReadFile, tryWriteFile } = require('./fileUtils');
const { addLargeHeapToAndroidManifest } = require('./androidManifestUtils');
const { isAndroidPlatform, isIosPlatform, isTrue } = require('./utils');

const ANDROID_MANIFEST_PATH = 'platforms/android/app/src/main/AndroidManifest.xml';
const getInfoPlistPath = (appName) => `platforms/ios/${appName}/${appName}-Info.plist`;

/**
 * Returns the file path for the provided platform
 * @param {string} platform the mobile platform
 * @param {string} appName the application name used to build plist path
 * @returns the path for the file
 */
const getFilePathByPlatform = (platform, appName) => {
    return isAndroidPlatform(platform) ?
        ANDROID_MANIFEST_PATH :
        isIosPlatform(platform) ? getInfoPlistPath(appName) : undefined;
};

/**
 * Adds large heap config to the platform specific file
 * @param {string} platform the mobile platform
 * @param {string} fileContent the content of the file to edit
 * @returns the updated file content
 */
const addConfigToPlatformSpecificFile = (platform, fileContent) => {
    return isAndroidPlatform(platform) ? 
        addLargeHeapToAndroidManifest(fileContent) : undefined;
};



/**
 * Add permissions to a the given platform in a given file
 * @param {string} platform the mobile platform
 * @param {string} filePath the path where the file is located
 */
const addLargeHeapAndroidConfig = async (platform, filePath) => {
    if (existsSync(filePath)) {
        const fileContent = await tryReadFile(filePath);
        const contentStr = fileContent.toString();
        const contentToAdd = await addConfigToPlatformSpecificFile(platform, contentStr);
        if (contentToAdd) {
            await tryWriteFile(filePath, contentToAdd);
            console.log('Configuration was successfully added!');
        } else {
            console.log('Configuration failed!');
        }
    }
};

module.exports = async (context) => {
    const platform = context.opts.cordova.platforms[0];
    if (isAndroidPlatform(platform)) {
        const appName = getAppNameCreator(context)();
        const filePath = getFilePathByPlatform(platform, appName);

        console.log(`Adding large-heap configuration to ${basename(filePath)}...`);
        await addLargeHeapAndroidConfig(platform, filePath);
    }
};
