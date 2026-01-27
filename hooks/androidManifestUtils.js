const { Parser, Builder } = require("xml2js");

const parseXml = (contentStr) => new Parser().parseStringPromise(contentStr);

const buildXml = (obj) => new Builder().buildObject(obj);

/**
 * Adds the provided permissions to the AndroidManifest.xml if they are not
 * already set.
 * @param {string} manifestStr the content of AndroidManifest.xml
 * @param {*} permissions the permissions to add to AndroidManifest.xml
 * @returns the xml updated as string or undefined if nothing changed
 */
const addLargeHeapToAndroidManifest = async (manifestStr, permissions) => {
    const manifestObj = await parseXml(manifestStr);

    const application = manifestObj.manifest.application[0];

    if(!application)
        return undefined

    const appAttr = application["$"]

    if(!appAttr){
        application.$ = {}
    }

    if(!('android:largeHeap' in application.$)){
        application.$['android:largeHeap'] = 'true';
        return buildXml(manifestObj);
    }
    return undefined;
};

module.exports = {
    addLargeHeapToAndroidManifest: addLargeHeapToAndroidManifest
};
