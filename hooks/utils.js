const isAndroidPlatform = (platform) => platform.toLowerCase() === 'android';

const isIosPlatform = (platform) => platform.toLowerCase() === 'ios';

const isTrue = (str) => String(str).toLowerCase() === 'true';

module.exports = {
    isAndroidPlatform: isAndroidPlatform,
    isIosPlatform: isIosPlatform,
    isTrue: isTrue
};
