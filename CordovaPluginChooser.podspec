require 'json'
package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |spec|
  spec.name = 'CordovaPluginChooser'
  spec.version = package['version']
  spec.summary = package['description']
  spec.homepage = package['homepage']
  spec.license = { :type => 'Apache-2.0', :file => 'LICENSE' }
  spec.author = 'Cyph, Inc.'
  spec.source = {
    :git => 'https://github.com/cyph/cordova-plugin-chooser.git',
    :tag => spec.version.to_s
  }
  spec.ios.deployment_target = '15.0'
  spec.swift_version = '5.0'
  spec.source_files = 'src/ios/*.swift', 'capacitor/ios/*.swift'
  spec.exclude_files = 'src/ios/CordovaChooser.swift'
  spec.resources = 'src/ios/ChooserPrivacy.bundle'
  spec.dependency 'Capacitor', '~> 8.0'
end
