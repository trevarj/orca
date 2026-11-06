{
  description = "Orca desktop and Android development environment (x86_64 Linux)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        config = {
          allowUnfree = true;
          android_sdk.accept_license = true;
        };
      };
      android = pkgs.androidenv.composeAndroidPackages {
        platformVersions = [ "36" ];
        buildToolsVersions = [
          "35.0.0"
          "36.0.0"
        ];
        includeNDK = true;
        ndkVersions = [ "27.1.12297006" ];
        cmakeVersions = [ "3.22.1" ];
        includeEmulator = false;
      };
      # Android's bundled Ninja segfaults with this toolchain; retain the SDK layout.
      androidNinja = pkgs.writeShellScript "android-ninja" ''
        exec ${pkgs.ninja}/bin/ninja -j"''${CMAKE_BUILD_PARALLEL_LEVEL:-2}" "$@"
      '';
      androidSdk = android.androidsdk.overrideAttrs (_: {
        postInstall = ''
          cmakeDir="$out/libexec/android-sdk/cmake/3.22.1"
          rm "$cmakeDir"
          mkdir "$cmakeDir"
          cp -rs ${android.androidsdk}/libexec/android-sdk/cmake/3.22.1/. "$cmakeDir/"
          chmod u+w "$cmakeDir/bin"
          ln -sf ${androidNinja} "$cmakeDir/bin/ninja"
        '';
      });
      sdk = "${androidSdk}/libexec/android-sdk";
      corepack = pkgs.corepack.override { nodejs-slim = pkgs.nodejs-slim_24; };
      environment = pkgs.buildFHSEnv {
        name = "orca-env";
        targetPkgs =
          p: with p; [
            nodejs_24
            corepack
            gcc
            binutils
            gnumake
            python3
            pkg-config
            git
            curl
            unzip
            zip
            patchelf
            cmake
            ninja
            jdk17
            androidSdk
            android-tools
            gtk3
            glib
            atk
            at-spi2-atk
            at-spi2-core
            cairo
            pango
            gdk-pixbuf
            dbus
            libnotify
            libsecret
            nss
            nspr
            expat
            alsa-lib
            cups
            libuuid
            udev
            libX11
            libXcomposite
            libXcursor
            libXdamage
            libXext
            libXfixes
            libXi
            libXrandr
            libXrender
            libXScrnSaver
            libXtst
            libxcb
            libxkbcommon
            libdrm
            libgbm
            libglvnd
            mesa
            wayland
            wayland.dev
            xdg-utils
            xvfb-run
            xauth
            dejavu_fonts
            fontconfig
          ];
        profile = ''
          export JAVA_HOME=${pkgs.jdk17}
          export ANDROID_HOME=${sdk}
          export ANDROID_SDK_ROOT="$ANDROID_HOME"
          export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/27.1.12297006"
          export FONTCONFIG_FILE=${pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; }}
          export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
          export ORCA_PNPM_GLOBAL_VIRTUAL_STORE=0
        '';
        runScript = "bash";
      };
      start = pkgs.writeShellScript "orca-start" ''
        exec ${environment}/bin/orca-env -c 'exec pnpm start "$@"' orca "$@"
      '';
    in
    {
      packages.${system}.default = environment;
      devShells.${system}.default = environment.env;
      apps.${system} = {
        default = {
          type = "app";
          program = "${start}";
        };
        shell = {
          type = "app";
          program = "${environment}/bin/orca-env";
        };
      };
    };
}
