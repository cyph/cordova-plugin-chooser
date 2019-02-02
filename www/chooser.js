module.exports = {
  getFile: function(successCallback, errorCallback, accept) {
    accept =
      (typeof accept === "string" ? accept.replace(/\s/g, "") : undefined) ||
      "*/*";
    var parseResult = function(json) {
      try {
        successCallback(JSON.parse(json));
      } catch (err) {
        errorCallback(err);
      }
    };

    cordova.exec(parseResult, errorCallback, "Chooser", "getFile", [accept]);
  }
};
