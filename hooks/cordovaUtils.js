const getConfigParser = (context) => {
    const ConfigParser = context.requireCordovaModule('cordova-lib').configparser;
    return new ConfigParser('config.xml');
};

const getPreferenceValueCreator = (context) => {
    const configParser = getConfigParser(context);
    return (preferenceName, platform) => 
        configParser.getPreference(preferenceName, platform);
};

const getAppNameCreator = (context) => {
    const configParser = getConfigParser(context);
    return () => configParser.name();
};

module.exports = {
    getPreferenceValueCreator: getPreferenceValueCreator,
    getAppNameCreator: getAppNameCreator
};
