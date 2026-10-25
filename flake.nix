{
  description = "Chooser development and verification toolchains";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  inputs.nixpkgs-darwin.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";
  outputs = { nixpkgs, nixpkgs-darwin, ... }: {
    devShells =
      nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ]
        (
          system:
          let
            source = if system == "x86_64-darwin" then nixpkgs-darwin else nixpkgs;
            pkgs = import source {
              inherit system;
              config = {
                allowUnfree = true;
                android_sdk.accept_license = true;
              };
            };
            nodejs = pkgs.nodejs_24;
            pnpmSource = (builtins.fromJSON (builtins.readFile ./chainman/tools.json)).pnpm;
            pnpm =
              (pkgs.pnpm_11.override {
                inherit (pnpmSource) version hash;
                nodejs-slim = nodejs;
              }).overrideAttrs
                (_: {
                  src = pkgs.fetchurl { inherit (pnpmSource) url hash; };
                });
            prettier = pkgs.prettier.override { inherit nodejs; };
            base = [
              nodejs
              pnpm
              pkgs.python3
              pkgs.git
              pkgs.just
              prettier
              pkgs.taplo
              pkgs.nixfmt
            ];
            gradle = pkgs.gradle_8;
            android = pkgs.androidenv.composeAndroidPackages {
              platformVersions = [
                "35"
                "36"
              ];
              buildToolsVersions = [
                "35.0.0"
                "36.0.0"
              ];
              includeEmulator = false;
              includeSystemImages = false;
              includeNDK = false;
            };
            emulatorSdk = pkgs.androidenv.composeAndroidPackages {
              platformVersions = [ "33" ];
              buildToolsVersions = [ "36.0.0" ];
              includeEmulator = true;
              includeSystemImages = true;
              systemImageTypes = [ "google_apis" ];
              abiVersions = [ "x86_64" ];
              includeNDK = false;
            };
          in
          {
            default = pkgs.mkShell { packages = base; };
            browser = pkgs.mkShell {
              packages = base ++ [
                pkgs.playwright-driver
                pkgs.playwright-driver.browsers
              ];
              PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
              CHOOSER_PLAYWRIGHT_MODULE = "${pkgs.playwright-driver}";
              PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
              LIBGL_ALWAYS_SOFTWARE = "1";
              LIBGL_DRIVERS_PATH = "${pkgs.mesa}/lib/dri";
              __EGL_VENDOR_LIBRARY_FILENAMES = "${pkgs.mesa}/share/glvnd/egl_vendor.d/50_mesa.json";
            };
            android = pkgs.mkShell {
              packages = base ++ [
                pkgs.jdk17
                gradle
                android.androidsdk
              ];
              JAVA_HOME = "${pkgs.jdk17}";
              ANDROID_HOME = "${android.androidsdk}/libexec/android-sdk";
              ANDROID_SDK_ROOT = "${android.androidsdk}/libexec/android-sdk";
              CORDOVA_ANDROID_GRADLE_DISTRIBUTION_URL = "file://${pkgs.gradle-packages.gradle_8.src}";
            };
            capacitor = pkgs.mkShell {
              packages = base ++ [
                pkgs.jdk21
                gradle
                android.androidsdk
              ];
              JAVA_HOME = "${pkgs.jdk21}";
              ANDROID_HOME = "${android.androidsdk}/libexec/android-sdk";
              ANDROID_SDK_ROOT = "${android.androidsdk}/libexec/android-sdk";
            };
            android-emulator = pkgs.mkShell {
              packages = base ++ [
                pkgs.jdk21
                gradle
                android.androidsdk
                emulatorSdk.androidsdk
              ];
              JAVA_HOME = "${pkgs.jdk21}";
              ANDROID_HOME = "${android.androidsdk}/libexec/android-sdk";
              ANDROID_SDK_ROOT = "${android.androidsdk}/libexec/android-sdk";
              CHOOSER_EMULATOR_SDK = "${emulatorSdk.androidsdk}/libexec/android-sdk";
            };
            ios = pkgs.mkShell {
              packages = base ++ [
                pkgs.cocoapods
                pkgs.xcodegen
              ];
            };
          }
        );
    packages =
      nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ]
        (
          system:
          let
            source = if system == "x86_64-darwin" then nixpkgs-darwin else nixpkgs;
          in
          {
            just = (import source { inherit system; }).just;
          }
        );
  };
}
